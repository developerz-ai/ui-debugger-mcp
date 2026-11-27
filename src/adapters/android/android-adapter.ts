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

import { spawn } from 'node:child_process';
import type { AndroidTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import { capWait } from '../budget.js';
import type {
  Adapter,
  Bounds,
  CaptureSink,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollOptions,
  SelectorDialect,
  WaitOptions,
} from '../contract.js';
import { abortable } from './abortable.js';
// Both managed adapters kill a detached group the same way — one implementation, in the
// subprocess plumbing module.
import { type Adb, AdbCli } from './adb.js';
import {
  assertPng,
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
import { awaitBooted, delay, ManagedEmulator, POLL_MS, type SpawnEmulator } from './emulator.js';
import { emulatorLaunchArgs } from './launch.js';
import { applyLogFilters, LogcatCoverage, parseRawLogcat, toConsoleEntry } from './logcat.js';
import { emulatorSerial, pickEmulatorPort } from './ports.js';
import { type EmulatorBin, resolveEmulatorBin } from './sdk.js';
import { AdbUiAutomator, shapeNodes, type UiAutomatorSource } from './uiautomator.js';

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

const DEFAULT_WAIT_MS = 5000;
/** How long managed boot waits for `sys.boot_completed` before failing loud. */
const BOOT_WAIT_MS = 120_000;

/** Default logcat window (lines) read per `console` call — reading never clears the log. */
const LOGCAT_TAIL = 500;

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
  /** Managed-boot emulator-binary resolution — the seam behind `AndroidAdapterInit.resolveBin`. */
  resolveBin: (explicit: string | null | undefined) => EmulatorBin;
  /** Where drained logcat rows are streamed — the run's durable capture sink. */
  onLog: CaptureSink | undefined;
}

// Public path stays stable: the logcat helpers and the spawn seam type moved to siblings.
export { applyLogFilters, parseLogcat, parseRawLogcat } from './logcat.js';
export type { SpawnEmulator };

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
   * Override managed-boot emulator-binary resolution (defaults to
   * {@link resolveEmulatorBin}: a configured `emulatorPath` verbatim, else the
   * Android SDK install, else PATH); a seam for tests. Managed boot only — attach
   * never resolves.
   */
  resolveBin?: (explicit: string | null | undefined) => EmulatorBin;
  /**
   * Sink streaming captured logcat rows to the run's durable console trail (the
   * session layer binds it, redacting, to `logs/console.log`).
   */
  onLog?: CaptureSink;
}

/**
 * The android {@link Adapter}: an ADB + uiautomator pair behind one contract.
 * Construct via {@link AndroidAdapter.create}.
 */
export class AndroidAdapter implements Adapter {
  /** The native grammar `find`/`click`/`type` accept: `role "name"` or a bare id/name substring. */
  readonly selectorDialect: SelectorDialect = 'native';
  readonly #config: AndroidTarget;
  readonly #bind: ((serial: string) => Transport) | null;
  readonly #attach: boolean;
  readonly #bootWaitMs: number;
  readonly #pickPort: () => Promise<number>;
  readonly #resolveBin: (explicit: string | null | undefined) => EmulatorBin;
  readonly #onLog: CaptureSink | undefined;
  /** Durable-trail dedup state — which logcat rows the capture sink already holds. */
  readonly #coverage = new LogcatCoverage();
  #transport: Transport | null;
  /** The device every call is bound to (`emulator-<port>` once managed boot picks one). */
  #serial: string | null;
  readonly #emulator: ManagedEmulator;
  #booted: boolean;
  #screen: Bounds | null = null;

  private constructor(handles: AndroidAdapterHandles) {
    this.#config = handles.config;
    this.#transport = handles.transport;
    this.#bind = handles.bind;
    this.#attach = handles.attach;
    this.#serial = handles.serial;
    this.#emulator = new ManagedEmulator(handles.spawn);
    this.#bootWaitMs = handles.bootWaitMs;
    this.#pickPort = handles.pickPort;
    this.#resolveBin = handles.resolveBin;
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
      resolveBin: init.resolveBin ?? ((explicit) => resolveEmulatorBin(explicit)),
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
      try {
        await this.#ensureBooted(deadline);
      } catch (error) {
        // A boot that failed (timeout, early exit, bad adb) must not leave the emulator
        // we spawned running with nothing owning it: release it on this path too.
        await this.#teardown().catch(() => undefined);
        throw error;
      }
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
    return this.#run('screenshot', async () =>
      assertPng(await this.#adb.execOut(['screencap', '-p'])),
    );
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
    const { signal } = opts;
    // Raised outside `#run`, which would re-wrap an abort and lose its `AbortError` name.
    await abortable(signal, `android: waitFor aborted (${query})`, () =>
      this.#run('waitFor', async () => {
        const deadline = Date.now() + timeout;
        // An in-flight dump can't be cancelled (no transport cancel) but is capped by
        // `deadline`; the loop stops right after it.
        while (signal?.aborted !== true) {
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
      }),
    );
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
      this.#coverage.stream(rows, this.#onLog);
      const entries = applyLogFilters(rows.map(toConsoleEntry).reverse(), opts.filters);
      return opts.limit !== undefined ? entries.slice(0, opts.limit) : entries;
    });
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
    await this.#run('close', () => this.#teardown());
  }

  /** Stop the emulator we started (console kill, then the process group) and unbind. */
  async #teardown(): Promise<void> {
    if (this.#booted && this.#transport) {
      // Best-effort console kill; the SIGTERM below is the hard backstop.
      await this.#transport.adb.adb(['emu', 'kill']).catch(() => undefined);
    }
    this.#booted = false;
    this.#serial = null;
    this.#screen = null;
    // Drop the binding so a re-`open` binds to the next emulator, not the dead one.
    if (this.#bind) this.#transport = null;
    await this.#emulator.terminate();
  }

  /**
   * Managed boot: resolve the emulator binary first (`emulatorPath`, else SDK/PATH
   * auto-detect — a miss fails loud before anything is picked, bound or spawned), then
   * launch `emulator @avd -port <p>` (once) and poll `sys.boot_completed`. The port
   * is picked free and bound **before** the spawn, so every later call (and the `close` kill)
   * targets the emulator we started, never a pre-existing one. No-op when attached; `deadline`
   * (the absolute instant the open's budget runs out) bounds the whole poll — a slow `adb`
   * call can never push the boot past it.
   */
  async #ensureBooted(deadline: number): Promise<void> {
    if (this.#booted) return;
    if (!this.#emulator.running) {
      // Only managed mode needs an AVD — attach never reads it (hence optional in config).
      const avd = this.#config.avd;
      if (avd === undefined) {
        throw new AdapterError(
          'android: managed boot needs `avd` on the target (or set `adbSerial` to attach ' +
            'to a running device/emulator)',
        );
      }
      // Honor `null = auto-detect from SDK` (config schema): resolve BEFORE the
      // port pick so a missing binary fails loud before anything is picked, bound
      // or spawned. Attach never reaches here (it starts out already booted).
      const resolved = this.#resolveBin(this.#config.emulatorPath);
      if (resolved.origin === 'missing') {
        throw new AdapterError(
          'android: no emulator binary found for managed boot — set `emulatorPath` on the ' +
            `target; searched: ${(resolved.searched ?? []).join(', ')}`,
        );
      }
      const port = await this.#pickPort();
      this.#serial = emulatorSerial(port);
      if (this.#bind) this.#transport = this.#bind(this.#serial);
      this.#emulator.start(
        resolved.bin,
        emulatorLaunchArgs({
          avd,
          port,
          headless: this.#config.headless,
          ...(this.#config.emulatorArgs ? { extraArgs: this.#config.emulatorArgs } : {}),
        }),
      );
    }
    await awaitBooted(this.#adb, this.#emulator, deadline, {
      avd: this.#config.avd,
      serial: this.#serial,
      bootWaitMs: this.#bootWaitMs,
    });
    this.#booted = true;
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
