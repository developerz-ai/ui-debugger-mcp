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
 * boots the configured `emulator @avd`, waits for `sys.boot_completed`, and `close`
 * stops it. Android is fully framework-driven — no vision needed for actions.
 *
 * `console` is logcat-backed (real crash/error signal); `network` has no ADB channel
 * and throws loud ({@link AdapterError}). Every backend failure surfaces as an
 * {@link AdapterError}; our own loud errors pass through un-rewrapped.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { AndroidTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import type {
  Adapter,
  Bounds,
  ConsoleEntry,
  Filters,
  LogQuery,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollOptions,
  WaitOptions,
} from '../contract.js';
import { type Adb, AdbCli } from './adb.js';
import {
  centerOf,
  keyArgs,
  parseScreenSize,
  scrollSwipe,
  splitTextForInput,
  startArgs,
  swipeArgs,
  tapArgs,
  textArgs,
} from './commands.js';
import { AdbUiAutomator, shapeNodes, type UiAutomatorSource } from './uiautomator.js';

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/** `waitFor` defaults — poll the hierarchy for a query until it appears or times out. */
const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 300;

/** How long managed boot waits for `sys.boot_completed` before failing loud. */
const BOOT_WAIT_MS = 120_000;

/** Default logcat tail (lines) drained per `console` read. */
const LOGCAT_TAIL = 500;

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
 * Parse `logcat -v epoch` output into {@link ConsoleEntry}s (oldest first, as emitted).
 * Line shape: `1546300800.000  1000  1000 I Tag: message` — unmatched lines are skipped.
 */
export function parseLogcat(raw: string): ConsoleEntry[] {
  const out: ConsoleEntry[] = [];
  for (const line of raw.split('\n')) {
    const match = /^\s*(\d+)\.(\d+)\s+\d+\s+\d+\s+([VDIWEF])\s+([^:]*):\s?(.*)$/.exec(line);
    if (!match) continue;
    const [, sec, frac, priority, tag, text] = match;
    if (sec === undefined || frac === undefined || priority === undefined || text === undefined) {
      continue;
    }
    const location = (tag ?? '').trim();
    out.push({
      level: LOGCAT_LEVEL[priority] ?? 'log',
      text,
      location: location === '' ? undefined : location,
      timestamp: Math.round(Number(`${sec}.${frac}`) * 1000),
    });
  }
  return out;
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

interface AndroidAdapterHandles {
  config: AndroidTarget;
  adb: Adb;
  ui: UiAutomatorSource;
  attach: boolean;
  spawn: SpawnEmulator;
  bootWaitMs: number;
}

/** Launch the emulator process — the spawn seam tests replace with a fake child. */
export type SpawnEmulator = (bin: string, args: string[]) => ChildProcess;

export interface AndroidAdapterInit {
  /** Resolved android-target config (avd, emulatorPath, adbSerial). */
  config: AndroidTarget;
  /** Override the ADB transport (defaults to {@link AdbCli}); a seam for tests. */
  adb?: Adb;
  /** Override the read source (defaults to {@link AdbUiAutomator}); a seam for tests. */
  ui?: UiAutomatorSource;
  /** Override the emulator spawn (defaults to `spawn`, detached); a seam for tests. */
  spawn?: SpawnEmulator;
  /** Override the managed-boot deadline (defaults to {@link BOOT_WAIT_MS}); a seam for tests. */
  bootWaitMs?: number;
}

/**
 * The android {@link Adapter}: an ADB + uiautomator pair behind one contract.
 * Construct via {@link AndroidAdapter.create}.
 */
export class AndroidAdapter implements Adapter {
  readonly #config: AndroidTarget;
  readonly #adb: Adb;
  readonly #ui: UiAutomatorSource;
  readonly #attach: boolean;
  readonly #spawn: SpawnEmulator;
  readonly #bootWaitMs: number;
  #emulator: ChildProcess | null = null;
  /** Why the managed emulator process is unusable (launch failure / early exit), or null. */
  #emulatorDown: string | null = null;
  #booted: boolean;
  #screen: Bounds | null = null;

  private constructor(handles: AndroidAdapterHandles) {
    this.#config = handles.config;
    this.#adb = handles.adb;
    this.#ui = handles.ui;
    this.#attach = handles.attach;
    this.#spawn = handles.spawn;
    this.#bootWaitMs = handles.bootWaitMs;
    // Attach mode targets an already-running device — treat it as booted from the start.
    this.#booted = handles.attach;
  }

  /** Wire the adapter from config: `adbSerial` → attach (`-s serial`), else managed emulator (`-e`). */
  static create(init: AndroidAdapterInit): AndroidAdapter {
    const serial = init.config.adbSerial ?? null;
    const attach = serial !== null;
    const adb = init.adb ?? new AdbCli(serial !== null ? ['-s', serial] : ['-e']);
    return new AndroidAdapter({
      config: init.config,
      adb,
      ui: init.ui ?? new AdbUiAutomator(adb),
      attach,
      spawn: init.spawn ?? ((bin, args) => spawn(bin, args, { detached: true, stdio: 'ignore' })),
      bootWaitMs: init.bootWaitMs ?? BOOT_WAIT_MS,
    });
  }

  /** Ensure the device is up (managed: boot the emulator), then start the activity/package. */
  async open(target: string): Promise<void> {
    await this.#run('open', async () => {
      await this.#ensureBooted();
      if (target.trim() !== '') await this.#adb.shell(startArgs(target));
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
      const { x, y } = centerOf((await this.#resolve(target)).bounds);
      await this.#adb.shell(tapArgs(x, y));
    });
  }

  async type(target: NodeRef, text: string): Promise<void> {
    // Contract: focus the target first, then type. Tap its center to focus.
    // Text goes out in %s-safe chunks — one `input text` per chunk (they append).
    await this.#run('type', async () => {
      const { x, y } = centerOf((await this.#resolve(target)).bounds);
      await this.#adb.shell(tapArgs(x, y));
      for (const chunk of splitTextForInput(text)) {
        await this.#adb.shell(textArgs(chunk));
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
      const start = Date.now();
      for (;;) {
        if (await this.find({ query })) return;
        if (Date.now() - start >= timeout) {
          throw new AdapterError(`android: waitFor timed out after ${timeout}ms (${query})`);
        }
        await delay(POLL_MS);
      }
    });
  }

  /** Drain recent logcat as normalized console entries (newest first), narrowed by {@link LogQuery}. */
  async console(opts: LogQuery = {}): Promise<ConsoleEntry[]> {
    return this.#run('console', async () => {
      // `limit` caps the *filtered result*, never the raw window — narrowing the
      // logcat tail to `limit` first would make filtered reads miss older matches.
      const tail = Math.max(LOGCAT_TAIL, opts.limit ?? 0);
      // `-t N` dumps the most recent N lines and exits (implies `-d`); `-v epoch` → real timestamps.
      const raw = await this.#adb.shell(['logcat', '-v', 'epoch', '-t', String(tail)]);
      const entries = applyLogFilters(parseLogcat(raw).reverse(), opts.filters);
      return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
    });
  }

  /** Android exposes no network channel over ADB — unsupported, surfaced loud. */
  async network(): Promise<NetworkEntry[]> {
    throw new AdapterError(
      'android target has no network channel over ADB (use a proxy; unsupported)',
    );
  }

  /** Attach: disconnect-only (never stop the device). Managed: stop the emulator. */
  async close(): Promise<void> {
    if (this.#attach) return;
    await this.#run('close', async () => {
      if (this.#booted) {
        // Best-effort console kill; the SIGTERM below is the hard backstop.
        await this.#adb.adb(['emu', 'kill']).catch(() => undefined);
      }
      const pid = this.#emulator?.pid;
      this.#emulator = null;
      this.#booted = false;
      if (pid === undefined) return;
      try {
        // Negative pid → the whole detached group.
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    });
  }

  /** Managed boot: launch `emulator @avd` (once) and poll `sys.boot_completed`. No-op when attached. */
  async #ensureBooted(): Promise<void> {
    if (this.#booted) return;
    if (!this.#emulator) {
      const bin = this.#config.emulatorPath ?? 'emulator';
      const child = this.#spawn(bin, [`@${this.#config.avd}`]);
      this.#emulatorDown = null;
      // Both fire async (later tick): without a listener a bad `emulatorPath` would
      // crash the whole server via an unhandled 'error' event. Capture the failure
      // and let the boot poll below surface it as a loud AdapterError.
      child.on('error', (err) => {
        this.#emulatorDown = `emulator ('${bin}') failed to launch: ${err.message}`;
      });
      child.on('exit', (code, signal) => {
        this.#emulatorDown ??= `emulator ('${bin}') exited before boot (${signal ?? code ?? 'unknown'})`;
      });
      this.#emulator = child;
    }
    const deadline = Date.now() + this.#bootWaitMs;
    await this.#awaitDevice(deadline);
    for (;;) {
      const out = (await this.#adb.shell(['getprop', 'sys.boot_completed'])).trim();
      if (out === '1') break;
      if (Date.now() >= deadline) {
        throw new AdapterError(
          `android: emulator @${this.#config.avd} did not boot within ${this.#bootWaitMs}ms`,
        );
      }
      await delay(POLL_MS);
    }
    this.#booted = true;
  }

  /**
   * Bounded replacement for the unbounded `adb wait-for-device`: poll `get-state`
   * until a device answers, failing loud when the emulator died or the boot
   * deadline passed — a dead emulator must never hang `open` forever.
   */
  async #awaitDevice(deadline: number): Promise<void> {
    for (;;) {
      if (this.#emulatorDown !== null) {
        throw new AdapterError(`android: ${this.#emulatorDown}`);
      }
      // `get-state` exits non-zero while no device is connected — that's "keep waiting".
      const state = await this.#adb.adb(['get-state']).catch(() => '');
      if (state.trim() === 'device') return;
      if (Date.now() >= deadline) {
        throw new AdapterError(
          `android: no device appeared within ${this.#bootWaitMs}ms (emulator @${this.#config.avd})`,
        );
      }
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

  /** Resolve a scope `within` (a {@link Node} or a selector) to an on-screen rectangle. */
  async #regionBounds(within: NodeRef): Promise<Bounds> {
    if (typeof within !== 'string') return within.bounds;
    const node = await this.find({ query: within });
    if (!node) throw new AdapterError(`android: \`within\` target not found: ${within}`);
    return node.bounds;
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
