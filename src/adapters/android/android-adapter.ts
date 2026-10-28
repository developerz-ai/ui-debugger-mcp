/**
 * Android adapter — drives an emulator/device over **ADB** behind the shared
 * {@link Adapter} contract, so the agent loop stays adapter-blind.
 *
 * Composition (split per SRP — see siblings):
 *   - transport → {@link Adb} (`adb` subprocess seam, `adb.ts`)
 *   - read      → {@link UiAutomatorSource} (`uiautomator dump` → view hierarchy, `uiautomator.ts`)
 *   - commands  → pure argv builders (`input tap/text/swipe/keyevent`, `commands.ts`)
 *
 * **Managed or attach** (`idea/adapters.md`): with an `adbSerial` the adapter attaches
 * to a running device and `close` is disconnect-only (never stops it); otherwise it
 * boots the configured `emulator @avd` on a free console port (`ports.ts`), waits for
 * `sys.boot_completed`, and `close` stops it. Either way every call is bound to one
 * explicit serial (`adb -s <serial>`), so a managed run can never drive — or kill — an
 * emulator it did not start. Android is fully framework-driven — no vision for actions.
 *
 * `console` is logcat-backed (real crash/error signal); `network` has no ADB channel
 * and throws loud ({@link AdapterError}). Every backend failure surfaces as an
 * {@link AdapterError}; our own loud errors pass through un-rewrapped.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { AndroidTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import { capWait } from '../budget.js';
import type {
  Adapter,
  Bounds,
  CaptureSink,
  ConsoleEntry,
  Filters,
  LogQuery,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollOptions,
  SelectorDialect,
  WaitOptions,
} from '../contract.js';
// Both managed adapters kill a detached group the same way — one implementation, in the
// subprocess plumbing module.
import { terminateGroup } from '../desktop/proc.js';
import { formatConsoleLine } from '../log-format.js';
import { type Adb, AdbCli, pendingStateOrThrow } from './adb.js';
import {
  expectOnScreen,
  keyArgs,
  parseScreenSize,
  scrollSwipe,
  splitTextForInput,
  splitTextLines,
  startArgs,
  swipeArgs,
  tapArgs,
  tapPointOf,
  textArgs,
} from './commands.js';
import { emulatorLaunchArgs } from './launch.js';
import { emulatorSerial, pickEmulatorPort } from './ports.js';
import { AdbUiAutomator, shapeNodes, type UiAutomatorSource } from './uiautomator.js';

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/** `waitFor` defaults — poll the hierarchy for a query until it appears or times out. */
const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 300;

/** How long managed boot waits for `sys.boot_completed` before failing loud. */
const BOOT_WAIT_MS = 120_000;

/** Default logcat window (lines) read per `console` call — reading never clears the log. */
const LOGCAT_TAIL = 500;

/**
 * Cap on the remembered console coverage (raw keys of every row the durable trail
 * already holds) — bounded no matter how long the run or how wide a one-off `limit`
 * was. The oldest covered rows drop first; the logcat buffer drops them too, so a
 * trimmed row is also the first to become unreachable.
 */
const MAX_COVERED_KEYS = 4096;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Android logcat priority letter → normalized console {@link ConsoleEntry} level. */
const LOGCAT_LEVEL: Record<string, ConsoleEntry['level']> = {
  V: 'log',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
};

/**
 * One raw logcat row — the record exactly as logcat emitted it, before
 * normalization. This is the row's dedup identity: keying the NORMALIZED entry
 * instead would merge distinct rows (the timestamp rounds to whole milliseconds,
 * `F` and `E` fold into one level, and PID/TID are dropped entirely).
 */
interface RawLogcatRow {
  /** Raw `sec.frac` text — the full precision logcat emitted, never rounded. */
  time: string;
  pid: string;
  tid: string;
  /** Raw priority letter — `F` and `E` normalize alike but are distinct rows. */
  priority: string;
  tag: string;
  text: string;
}

/** The occurrence identity of a raw row: the whole record, at full precision. */
function rawRowKey(row: RawLogcatRow): string {
  return `${row.time}|${row.pid}|${row.tid}|${row.priority}|${row.tag}|${row.text}`;
}

/** True when `needle` appears in `hay` contiguously starting at `start`. */
function matchesAt(hay: readonly string[], start: number, needle: readonly string[]): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (hay[start + i] !== needle[i]) return false;
  }
  return true;
}

/** True when the last `r` entries of `covered` equal the first `r` of `keys`. */
function overlapAtHead(covered: readonly string[], keys: readonly string[], r: number): boolean {
  for (let i = 0; i < r; i++) {
    if (covered[covered.length - r + i] !== keys[i]) return false;
  }
  return true;
}

/** `1546300800.000  1000  1000 I Tag: message` — unmatched lines are skipped. */
const LOGCAT_ROW = /^\s*(\d+)\.(\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*):\s?(.*)$/;

/** Parse `logcat -v epoch` output into raw rows (oldest first, as emitted). */
export function parseRawLogcat(raw: string): RawLogcatRow[] {
  const out: RawLogcatRow[] = [];
  for (const line of raw.split('\n')) {
    const match = LOGCAT_ROW.exec(line);
    if (!match) continue;
    const [, sec, frac, pid, tid, priority, tag, text] = match;
    if (
      sec === undefined ||
      frac === undefined ||
      pid === undefined ||
      tid === undefined ||
      priority === undefined ||
      text === undefined
    ) {
      continue;
    }
    out.push({ time: `${sec}.${frac}`, pid, tid, priority, tag: (tag ?? '').trim(), text });
  }
  return out;
}

/** Normalize a raw row onto the adapter-agnostic {@link ConsoleEntry} shape. */
function toConsoleEntry(row: RawLogcatRow): ConsoleEntry {
  return {
    level: LOGCAT_LEVEL[row.priority] ?? 'log',
    text: row.text,
    location: row.tag === '' ? undefined : row.tag,
    timestamp: Math.round(Number(row.time) * 1000),
  };
}

/**
 * Parse `logcat -v epoch` output into {@link ConsoleEntry}s (oldest first, as emitted).
 * Line shape: `1546300800.000  1000  1000 I Tag: message` — unmatched lines are skipped.
 */
export function parseLogcat(raw: string): ConsoleEntry[] {
  return parseRawLogcat(raw).map(toConsoleEntry);
}

/** Apply the whitelisted console `filters` (logcat). Loud on an unknown key or wrong type. */
export function applyLogFilters(entries: ConsoleEntry[], filters?: Filters): ConsoleEntry[] {
  if (!filters) return entries;
  let out = entries;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'level_eq': {
        if (typeof value !== 'string') throw new AdapterError('filter `level_eq` expects a string');
        out = out.filter((e) => e.level === value);
        break;
      }
      case 'level_in': {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          throw new AdapterError('filter `level_in` expects a string[]');
        }
        out = out.filter((e) => value.includes(e.level));
        break;
      }
      case 'text_contains': {
        if (typeof value !== 'string') {
          throw new AdapterError('filter `text_contains` expects a string');
        }
        const needle = value.toLowerCase();
        out = out.filter((e) => e.text.toLowerCase().includes(needle));
        break;
      }
      default:
        throw new AdapterError(
          `unknown filter \`${key}\` for android console (allowed: level_eq, level_in, text_contains)`,
        );
    }
  }
  return out;
}

/** The device seams, bound to one serial: the ADB transport plus the reader on top of it. */
interface Transport {
  adb: Adb;
  ui: UiAutomatorSource;
}

interface AndroidAdapterHandles {
  config: AndroidTarget;
  /** Bound transport, or null while a managed emulator has no serial yet. */
  transport: Transport | null;
  /** Build the transport for a serial; null when an instance seam was injected. */
  bind: ((serial: string) => Transport) | null;
  attach: boolean;
  serial: string | null;
  spawn: SpawnEmulator;
  bootWaitMs: number;
  pickPort: () => Promise<number>;
  /** Where drained logcat rows are streamed — the run's durable capture sink. */
  onLog: CaptureSink | undefined;
}

/** Launch the emulator process — the spawn seam tests replace with a fake child. */
export type SpawnEmulator = (bin: string, args: string[]) => ChildProcess;

export interface AndroidAdapterInit {
  /** Resolved android-target config (avd, emulatorPath, adbSerial). */
  config: AndroidTarget;
  /**
   * Override the ADB transport (defaults to an {@link AdbCli} bound to the device
   * serial); a seam for tests. As a function it is the transport *factory* and gets
   * the serial the adapter bound to — managed mode calls it at boot.
   */
  adb?: Adb | ((serial: string) => Adb);
  /** Override the read source (defaults to {@link AdbUiAutomator}); a seam for tests. */
  ui?: UiAutomatorSource;
  /** Override the emulator spawn (defaults to `spawn`, detached); a seam for tests. */
  spawn?: SpawnEmulator;
  /** Override the managed-boot deadline (defaults to {@link BOOT_WAIT_MS}); a seam for tests. */
  bootWaitMs?: number;
  /** Override the managed console-port pick (defaults to {@link pickEmulatorPort}); a test seam. */
  pickPort?: () => Promise<number>;
  /**
   * Optional sink for streaming captured logcat rows to the run's durable console
   * trail — the same seam the browser adapter writes to (the session layer binds
   * it, redacting, to `logs/console.log`).
   */
  onLog?: CaptureSink;
}

/**
 * The android {@link Adapter}: an ADB + uiautomator pair behind one contract.
 * Construct via {@link AndroidAdapter.create}.
 */
export class AndroidAdapter implements Adapter {
  /**
   * The native selector grammar — the uiautomator parser this adapter's
   * `find`/`click`/`type` accept: `role "name"` or a bare `resource-id`/name
   * substring, and nothing else. Declared here, not derived from the absence of
   * `tabs`: the dialect is the grammar, and the grammar is the adapter's own.
   */
  readonly selectorDialect: SelectorDialect = 'native';
  readonly #config: AndroidTarget;
  readonly #bind: ((serial: string) => Transport) | null;
  readonly #attach: boolean;
  readonly #spawn: SpawnEmulator;
  readonly #bootWaitMs: number;
  readonly #pickPort: () => Promise<number>;
  readonly #onLog: CaptureSink | undefined;
  /**
   * The overlap window: raw keys of every row the durable trail already holds,
   * in drain order (oldest first), capped at {@linkcode MAX_COVERED_KEYS} —
   * so the remembered window is bounded no matter how long the run (see
   * {@linkcode AndroidAdapter.streamRows}).
   */
  #coveredKeys: string[] = [];
  #transport: Transport | null;
  /** The device every call is bound to (`emulator-<port>` once managed boot picks one). */
  #serial: string | null;
  #emulator: ChildProcess | null = null;
  /** Why the managed emulator process is unusable (launch failure / early exit), or null. */
  #emulatorDown: string | null = null;
  #booted: boolean;
  #screen: Bounds | null = null;

  private constructor(handles: AndroidAdapterHandles) {
    this.#config = handles.config;
    this.#transport = handles.transport;
    this.#bind = handles.bind;
    this.#attach = handles.attach;
    this.#serial = handles.serial;
    this.#spawn = handles.spawn;
    this.#bootWaitMs = handles.bootWaitMs;
    this.#pickPort = handles.pickPort;
    this.#onLog = handles.onLog;
    // Attach mode targets an already-running device — treat it as booted from the start.
    this.#booted = handles.attach;
  }

  /**
   * Wire the adapter from config. Both modes talk to **one explicit serial**
   * (`adb -s <serial>`): attach reads it from `adbSerial` and binds here, managed
   * only learns it when it picks a console port and spawns — so it binds at boot.
   */
  static create(init: AndroidAdapterInit): AndroidAdapter {
    const attachSerial = init.config.adbSerial ?? null;
    // An injected transport instance (test seam) is already bound — never rebuilt.
    const seam = typeof init.adb === 'object' ? init.adb : null;
    const makeAdb = typeof init.adb === 'function' ? init.adb : null;
    const bind =
      seam === null
        ? (serial: string): Transport => {
            const adb = makeAdb ? makeAdb(serial) : new AdbCli(['-s', serial]);
            return { adb, ui: init.ui ?? new AdbUiAutomator(adb) };
          }
        : null;
    let transport: Transport | null = null;
    if (seam !== null) transport = { adb: seam, ui: init.ui ?? new AdbUiAutomator(seam) };
    else if (attachSerial !== null && bind !== null) transport = bind(attachSerial);
    return new AndroidAdapter({
      config: init.config,
      transport,
      bind,
      attach: attachSerial !== null,
      serial: attachSerial,
      spawn: init.spawn ?? ((bin, args) => spawn(bin, args, { detached: true, stdio: 'ignore' })),
      bootWaitMs: init.bootWaitMs ?? BOOT_WAIT_MS,
      pickPort: init.pickPort ?? (() => pickEmulatorPort()),
      onLog: init.onLog,
    });
  }

  /** The bound ADB transport. Managed mode binds it at boot — nothing talks to a device before. */
  get #adb(): Adb {
    if (!this.#transport) {
      throw new AdapterError('android: no device bound yet (open the target first)');
    }
    return this.#transport.adb;
  }

  /** The bound hierarchy reader — bound with {@link AndroidAdapter.#adb}. */
  get #ui(): UiAutomatorSource {
    if (!this.#transport) {
      throw new AdapterError('android: no device bound yet (open the target first)');
    }
    return this.#transport.ui;
  }

  /** Ensure the device is up (managed: boot the emulator), then start the activity/package. */
  async open(target: string, timeoutMs?: number): Promise<void> {
    await this.#run('open', async () => {
      // One absolute deadline for the whole open: the managed boot poll AND the
      // post-boot activity start share it, so neither can outlive the caller's budget.
      const deadline = Date.now() + capWait(this.#bootWaitMs, timeoutMs);
      await this.#ensureBooted(deadline);
      if (target.trim() !== '') {
        await this.#adb.shell(startArgs(target), deadline);
        this.#assertBefore(deadline, 'android: activity start');
      }
    });
  }

  async find(opts: Query): Promise<Node | null> {
    return this.#run('find', async () => {
      const nodes = await this.readState({ ...opts, limit: 1 });
      return nodes[0] ?? null;
    });
  }

  async readState(opts: Query = {}): Promise<Node[]> {
    return this.#run('readState', async () => {
      const region = opts.within !== undefined ? await this.#regionBounds(opts.within) : undefined;
      const nodes = await this.#ui.dump();
      return shapeNodes(nodes, opts, DEFAULT_LIMIT, region);
    });
  }

  async click(target: NodeRef): Promise<void> {
    await this.#run('click', async () => {
      const { x, y } = tapPointOf(await this.#resolve(target));
      await this.#adb.shell(tapArgs(x, y));
    });
  }

  async type(target: NodeRef, text: string): Promise<void> {
    // Contract: focus the target first, then type. Tap its center to focus.
    // Line breaks become ENTER presses (a raw \n would reach the device shell);
    // each line goes out in %s-safe chunks — one `input text` per chunk (they append).
    await this.#run('type', async () => {
      const { x, y } = tapPointOf(await this.#resolve(target));
      await this.#adb.shell(tapArgs(x, y));
      for (const [index, line] of splitTextLines(text).entries()) {
        if (index > 0) await this.#adb.shell(keyArgs('enter'));
        for (const chunk of splitTextForInput(line)) {
          await this.#adb.shell(textArgs(chunk));
        }
      }
    });
  }

  async pressKey(key: string): Promise<void> {
    if (key.trim() === '') throw new AdapterError('pressKey requires a non-empty key');
    await this.#run('pressKey', async () => {
      await this.#adb.shell(keyArgs(key));
    });
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    await this.#run('scroll', async () => {
      const area =
        opts.within !== undefined
          ? await this.#regionBounds(opts.within)
          : await this.#screenSize();
      const { x1, y1, x2, y2 } = scrollSwipe(opts.direction, area, opts.amount);
      await this.#adb.shell(swipeArgs(x1, y1, x2, y2));
      // Screen size may have changed (orientation, split-screen, etc.) — invalidate cache.
      this.#screen = null;
    });
  }

  async screenshot(): Promise<Uint8Array> {
    return this.#run('screenshot', () => this.#adb.execOut(['screencap', '-p']));
  }

  async waitFor(opts: WaitOptions): Promise<void> {
    if (opts.networkIdle) {
      throw new AdapterError('android: `networkIdle` wait is unsupported (no network channel)');
    }
    const query = opts.query;
    if (!query) {
      throw new AdapterError('waitFor requires `query` (android has no networkIdle)');
    }
    const timeout = opts.timeout ?? DEFAULT_WAIT_MS;
    await this.#run('waitFor', async () => {
      const deadline = Date.now() + timeout;
      for (;;) {
        if (await this.#present(query, deadline)) {
          // A node that only appeared AFTER the deadline is a timeout, not a success:
          // the wait's promise is "the node is there NOW", and by then it is not.
          this.#assertBefore(deadline, `android: waitFor (${query})`);
          return;
        }
        if (Date.now() >= deadline) {
          throw new AdapterError(`android: waitFor timed out after ${timeout}ms (${query})`);
        }
        await delay(POLL_MS);
      }
    });
  }

  /**
   * One deadline-bounded poll for `query`. The wait's deadline goes **into** the dump:
   * a dump is three `adb` round-trips (`rm` → `dump` → `cat`) and each one has its own
   * 30 s transport cap, so a poll could run for a minute and `waitFor` — which only
   * checks the clock between polls — would overshoot its timeout by a whole dump.
   */
  async #present(query: string, deadline: number): Promise<boolean> {
    const nodes = await this.#ui.dump(deadline);
    return shapeNodes(nodes, { query, limit: 1 }, DEFAULT_LIMIT).length > 0;
  }

  /** Fail loud when the deadline has already passed — a late success is not a success. */
  #assertBefore(deadline: number, what: string): void {
    const now = Date.now();
    if (now > deadline) {
      throw new AdapterError(
        `${what} finished ${now - deadline}ms after its deadline (deadline ${deadline}ms)`,
      );
    }
  }

  /** Read recent logcat as normalized console entries (newest first), narrowed by {@link LogQuery}. Reads are non-destructive — the log is not cleared. */
  async console(opts: LogQuery = {}): Promise<ConsoleEntry[]> {
    return this.#run('console', async () => {
      // `limit` caps the *filtered result*, never the raw window — narrowing the
      // logcat tail to `limit` first would make filtered reads miss older matches.
      const tail = Math.max(LOGCAT_TAIL, opts.limit ?? 0);
      // `-t N` dumps the most recent N lines and exits (implies `-d`); `-v epoch` → real timestamps.
      const raw = await this.#adb.shell(['logcat', '-v', 'epoch', '-t', String(tail)]);
      const rows = parseRawLogcat(raw);
      // The durable trail is the RAW record: every drained row is streamed before
      // filters/limit narrow the returned view — the browser's capture-then-filter
      // posture, on the same sink.
      this.#streamRows(rows);
      const entries = applyLogFilters(rows.map(toConsoleEntry).reverse(), opts.filters);
      return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
    });
  }

  /**
   * Stream the drained logcat rows to the capture sink — one formatted line per row.
   *
   * The sink is the run's redacting durable writer (the session layer binds it);
   * the adapter itself never writes to disk. `logcat -t N` re-dumps the same tail
   * on every read, so the durable trail would otherwise repeat it — a coverage
   * window prevents that without an ever-growing row set:
   *
   * Drains are chronological tails of one append-only log, so consecutive drains
   * only ever slide FORWARD: this drain's overlap with the already-covered rows
   * is a contiguous run of them, and its fresh rows are a suffix. Remembering
   * the covered span as the SEQUENCE of raw keys already streamed
   * ({@linkcode AndroidAdapter.coveredKeys}, capped) decides every row by
   * locating that coverage inside this drain ({@linkcode AndroidAdapter.coveredSpan}):
   *
   *   - the whole covered sequence found as one contiguous block → the block and
   *     everything up to its last row is covered → skipped; rows before it sit
   *     below the earlier tail's cutoff, never drained → streamed now (a wider
   *     `limit` back-fills them, once);
   *   - only the covered sequence's TAIL found at the drain's head (a narrower
   *     drain, or the oldest covered rows slid out of the buffer) → that overlap
   *     is skipped, everything after it streams;
   *   - no overlap at all → the coverage predates this drain entirely → the
   *     whole drain streams.
   *
   * Matching the whole SEQUENCE — not a boundary key — is what keeps
   * byte-identical records honest: a drain holding two copies of one record ends
   * on the second copy, and only a sequence match finds it; a first-key
   * `findIndex` would stop at the first copy and re-stream the rest. A narrower
   * drain never SHRINKS the remembered coverage either (the rows it could not
   * see stay remembered ahead of it), so wide → narrow → wide re-reads do not
   * re-stream the rows the narrow drain temporarily hid. Under a fully periodic
   * drain an overlap is genuinely ambiguous; the earliest (largest-skip) match
   * wins, which never duplicates: two rows sharing a raw key format to the same
   * trail line, so a skipped twin loses no content.
   *
   * A failing sink never fails the read.
   */
  #streamRows(rows: RawLogcatRow[]): void {
    const sink = this.#onLog;
    const oldest = rows[0];
    const newest = rows[rows.length - 1];
    if (sink === undefined || oldest === undefined || newest === undefined) return;
    const keys = rows.map(rawRowKey);
    const span = this.#coveredSpan(keys);
    const coveredFrom = span === null ? -1 : span.from;
    const coveredThrough = span === null ? -1 : span.to;
    for (const [index, row] of rows.entries()) {
      const backFilled = coveredFrom !== -1 && index < coveredFrom;
      const arrived = coveredThrough === -1 || index > coveredThrough;
      if (!backFilled && !arrived) continue;
      try {
        sink('console', formatConsoleLine(toConsoleEntry(row)));
      } catch (error) {
        // A sink failure must not crash the read — the entries still come back.
        console.error(
          `android capture sink failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // The window records what is covered NOW — the skipped overlap plus every
    // streamed row — so the next read locates its overlap against it. A narrower
    // drain extends the span; it never pulls the coverage start forward.
    this.#rememberCoverage(keys, span);
  }

  /**
   * Locate the already-covered rows inside this drain's keys (both oldest
   * first). Returns the covered span as inclusive `[from, to]` indexes into
   * `keys`, or null when none of the coverage appears.
   */
  #coveredSpan(keys: string[]): { from: number; to: number } | null {
    const covered = this.#coveredKeys;
    const m = covered.length;
    const n = keys.length;
    if (m === 0 || n === 0) return null;
    // The whole coverage as one contiguous block — a drain at least as wide as
    // the span it covers. Earliest alignment wins (see the streamRows note).
    if (n >= m) {
      for (let from = 0; from + m <= n; from++) {
        if (matchesAt(keys, from, covered)) return { from, to: from + m - 1 };
      }
    }
    // Otherwise the drain's head sits inside the coverage: its longest suffix
    // that matches the drain's prefix is the overlap (a narrower drain, or the
    // covered oldest rows already slid out of the buffer).
    for (let r = Math.min(m, n); r >= 1; r--) {
      if (overlapAtHead(covered, keys, r)) return { from: 0, to: r - 1 };
    }
    return null;
  }

  /** Extend the covered window by this drain — the overlap was skipped, the rest streamed. */
  #rememberCoverage(keys: string[], span: { from: number; to: number } | null): void {
    let grown: string[];
    if (span === null) {
      // No overlap located: the whole coverage predates this drain (it slid out
      // of the buffer, or sits wholly below a too-narrow tail). Keep it — a
      // later wider drain must not re-stream those rows — and extend by this drain.
      grown = [...this.#coveredKeys, ...keys];
    } else if (span.from === 0) {
      // The drain starts inside the coverage: the remembered rows BELOW the
      // drain (the coverage's head) stay remembered — a narrower drain must not
      // shrink coverage — and the whole drain extends the span.
      grown = [...this.#coveredKeys.slice(0, this.#coveredKeys.length - (span.to + 1)), ...keys];
    } else {
      // The coverage sat wholly inside the drain (its head rows were back-filled
      // just now): the drain is the new coverage.
      grown = keys;
    }
    this.#coveredKeys =
      grown.length > MAX_COVERED_KEYS ? grown.slice(grown.length - MAX_COVERED_KEYS) : grown;
  }

  /** Android exposes no network channel over ADB — unsupported, surfaced loud. */
  async network(): Promise<NetworkEntry[]> {
    throw new AdapterError(
      'android target has no network channel over ADB (use a proxy; unsupported)',
    );
  }

  /**
   * Attach: disconnect-only (never stop the device). Managed: stop **our** emulator —
   * the kill goes to the bound serial (`adb -s emulator-<port> emu kill`), so a
   * co-running emulator we never started is untouched.
   */
  async close(): Promise<void> {
    if (this.#attach) return;
    await this.#run('close', async () => {
      if (this.#booted && this.#transport) {
        // Best-effort console kill; the SIGTERM below is the hard backstop.
        await this.#transport.adb.adb(['emu', 'kill']).catch(() => undefined);
      }
      const pid = this.#emulator?.pid;
      this.#booted = false;
      this.#serial = null;
      this.#screen = null;
      // Drop the binding so a re-`open` binds to the next emulator, not the dead one.
      if (this.#bind) this.#transport = null;
      if (pid === undefined) {
        this.#emulator = null;
        return;
      }
      // SIGTERM the group, escalate to SIGKILL, and keep the handle until death is
      // confirmed — a dropped handle leaves a SIGTERM-ignoring emulator orphaned for good.
      await terminateGroup(pid);
      this.#emulator = null;
    });
  }

  /**
   * Managed boot: launch `emulator @avd -port <p>` (once), poll `sys.boot_completed`. The port
   * is picked free and bound **before** the spawn, so every later call (and the `close` kill)
   * targets the emulator we started, never a pre-existing one. No-op when attached; `deadline`
   * (the absolute instant the open's budget runs out) bounds both the device poll and the
   * `getprop` poll — a slow `adb` call can never push the boot past it.
   */
  async #ensureBooted(deadline: number): Promise<void> {
    if (this.#booted) return;
    if (!this.#emulator) {
      // Only managed mode needs an AVD — attach never reads it (hence optional in config).
      const avd = this.#config.avd;
      if (avd === undefined) {
        throw new AdapterError(
          'android: managed boot needs `avd` on the target (or set `adbSerial` to attach ' +
            'to a running device/emulator)',
        );
      }
      const bin = this.#config.emulatorPath ?? 'emulator';
      const port = await this.#pickPort();
      this.#serial = emulatorSerial(port);
      if (this.#bind) this.#transport = this.#bind(this.#serial);
      const child = this.#spawn(
        bin,
        emulatorLaunchArgs({
          avd,
          port,
          headless: this.#config.headless,
          ...(this.#config.emulatorArgs ? { extraArgs: this.#config.emulatorArgs } : {}),
        }),
      );
      this.#emulatorDown = null;
      // Both fire async (later tick): without a listener a bad `emulatorPath` would
      // crash the whole server via an unhandled 'error' event. Capture the failure
      // and let the boot poll below surface it as a loud AdapterError.
      child.on('error', (err) => {
        this.#emulatorDown = `emulator ('${bin}') failed to launch: ${err.message}`;
        this.#emulator = null;
      });
      child.on('exit', (code, signal) => {
        this.#emulatorDown ??= `emulator ('${bin}') exited before boot (${signal ?? code ?? 'unknown'})`;
        this.#emulator = null;
      });
      this.#emulator = child;
    }
    await this.#awaitDevice(deadline);
    for (;;) {
      const out = (await this.#adb.shell(['getprop', 'sys.boot_completed'], deadline)).trim();
      if (Date.now() >= deadline) {
        throw new AdapterError(
          `android: emulator @${this.#config.avd} (${this.#serial}) did not boot within ${this.#bootWaitMs}ms`,
        );
      }
      if (out === '1') break;
      await delay(POLL_MS);
    }
    this.#booted = true;
  }

  /**
   * Bounded replacement for the unbounded `adb wait-for-device`: poll `get-state` until
   * a device answers, failing loud when the emulator died, the poll hit a real error
   * ({@link pendingStateOrThrow}) or the deadline passed — never hang `open` forever.
   *
   * The `get-state` call carries the deadline: its own 30 s transport cap is shortened to
   * the time left, so a wedged `adb` cannot hold the boot past the caller's budget.
   */
  async #awaitDevice(deadline: number): Promise<void> {
    for (;;) {
      if (this.#emulatorDown !== null) {
        throw new AdapterError(`android: ${this.#emulatorDown}`);
      }
      // `get-state` exits non-zero while no device is connected — that alone is "keep
      // waiting"; a missing `adb`, an ambiguous target or a wedged call surfaces now.
      const state = await this.#adb.adb(['get-state'], deadline).catch(pendingStateOrThrow);
      if (Date.now() >= deadline) {
        throw new AdapterError(
          `android: no device appeared within ${this.#bootWaitMs}ms ` +
            `(emulator @${this.#config.avd} on ${this.#serial})`,
        );
      }
      if (state.trim() === 'device') return;
      await delay(POLL_MS);
    }
  }

  /** Read (and cache) the device screen size for viewport scrolls. */
  async #screenSize(): Promise<Bounds> {
    if (this.#screen) return this.#screen;
    this.#screen = parseScreenSize(await this.#adb.shell(['wm', 'size']));
    return this.#screen;
  }

  /** Resolve a {@link NodeRef} to a concrete {@link Node}, re-querying a selector. */
  async #resolve(target: NodeRef): Promise<Node> {
    if (typeof target !== 'string') return target;
    const node = await this.find({ query: target });
    if (!node) {
      throw new AdapterError(`android: no element matched query ${JSON.stringify(target)}`);
    }
    return node;
  }

  /**
   * Resolve a scope `within` (a {@link Node} or a selector) to an on-screen rectangle.
   * A zero-size region is rejected, not scoped to: `scroll` would swipe 2px at the screen
   * origin (a shade pull) and `readState` would report the region as simply empty.
   */
  async #regionBounds(within: NodeRef): Promise<Bounds> {
    if (typeof within !== 'string') return expectOnScreen(within);
    const node = await this.find({ query: within });
    if (!node) throw new AdapterError(`android: \`within\` target not found: ${within}`);
    return expectOnScreen(node);
  }

  /** Run a backend call, re-throwing as a loud {@link AdapterError} (our own errors pass through). */
  async #run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UiDebuggerError) throw error;
      throw new AdapterError(
        `android.${op} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
