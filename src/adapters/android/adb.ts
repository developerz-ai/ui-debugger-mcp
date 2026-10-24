/**
 * ADB (Android Debug Bridge) transport — the one I/O seam for the android adapter.
 *
 * Android is **fully framework-driven** (no vision needed): every read/act/capture
 * is an `adb` subprocess (`idea/desktop-control.md`). This module is the thin runner
 * that shells out; all command *shapes* (`input tap`, `uiautomator dump`, keycodes)
 * live in the pure builders beside it (`commands.ts`, `uiautomator.ts`) so they stay
 * unit-testable without spawning. {@link AdbCli} is injected as a seam in tests.
 *
 * One subprocess call underneath ({@link AdbExec}, injectable) resolving raw bytes; the
 * text channels decode UTF-8 on top, so `exec-out` stays binary-safe by construction.
 *
 * Three channels, mirroring `adb`'s own surface:
 *   - {@link Adb.shell}   — `adb shell <cmd>` → text (am/input/uiautomator/getprop/logcat).
 *   - {@link Adb.execOut} — `adb exec-out <cmd>` → **raw bytes** (binary-safe `screencap -p`).
 *   - {@link Adb.adb}     — top-level `adb <args>` (`wait-for-device`, `emu kill`).
 *
 * Target selection is baked into the `flags` at construction and is always an explicit
 * serial — `['-s', serial]`, the configured one when attaching, `emulator-<port>` for
 * the emulator a managed run started (never the ambiguous `-e`). Fails loud — a non-zero
 * exit, a timeout or a missing binary rejects as an {@link AdbError}, never a silent
 * fallback; {@link pendingStateOrThrow} is the one narrow exception a boot poll may retry.
 *
 * **Deadlines.** Every call may carry an absolute deadline (epoch ms) — the wall-clock
 * instant the enclosing budget runs out. It bounds the subprocess itself (the per-call
 * cap becomes the time left until the deadline, never more) AND the result: a call that
 * *resolves* after the deadline is a failure, not a late success. Without that second
 * check a slow `adb` would report success minutes past the caller's deadline.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdbError } from '../../errors.js';
import { capWait } from '../budget.js';

const pExecFile = promisify(execFile);

const ADB = 'adb';

/** 64 MiB stdout cap — `screencap -p` PNGs run a few MB on hi-dpi panels; text replies are tiny. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Per-invocation wall-clock cap. `adb` wedges in practice — a stuck `uiautomator dump`,
 * a half-dead emulator, an adb server mid-restart — and an unbounded `execFile` would
 * hang the whole run behind it. 30 s is far above any healthy call (a cold `screencap`
 * or a big hierarchy dump lands in single-digit seconds).
 *
 * The long boot wait is *not* one call: the adapter polls `get-state`/`getprop` against
 * its own 120 s deadline, so every individual call stays under this cap.
 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Kill signal on expiry. SIGKILL, not SIGTERM: a wedged `adb` blocked on the transport
 * is exactly the process that ignores a polite signal, and Node only rejects once the
 * child is actually gone.
 */
const KILL_SIGNAL = 'SIGKILL';

/** Decoder for the text channels — one instance, `adb` speaks UTF-8. */
const DECODER = new TextDecoder();

/**
 * `adb` failure phrases that mean "the device is not up **yet**" — the only rejection a
 * boot poll may retry. Deliberately narrow: a missing binary, an ambiguous target
 * (`more than one device`) or a timeout are real failures, not "keep waiting".
 */
const PENDING_DEVICE =
  /no devices\/emulators found|device offline|device '[^']*' not found|device still (connecting|authorizing)/i;

/**
 * Triage a `get-state` rejection during a boot poll: return `''` (poll again) only when
 * the device is merely not up yet, otherwise rethrow. Honest failure — a missing `adb`
 * or a wedged call must surface now, not 120 s later as a misleading "no device appeared".
 */
export function pendingStateOrThrow(error: unknown): string {
  if (error instanceof AdbError && PENDING_DEVICE.test(error.message)) return '';
  throw error;
}

/**
 * The one subprocess call the transport makes — resolves **raw stdout bytes** (text
 * channels decode on top, so `exec-out` stays binary-safe). Injectable so argv-shape
 * tests assert the argv they would have spawned instead of spawning: a real child's
 * stdout is at the mercy of the machine, and argv ordering is a pure property.
 */
export type AdbExec = (bin: string, args: string[], timeoutMs: number) => Promise<Uint8Array>;

/** The real {@link AdbExec}: `execFile`, capped, buffer-encoded (never UTF-8 mangled). */
export const execFileBytes: AdbExec = async (bin, args, timeoutMs) => {
  const { stdout } = await pExecFile(bin, args, {
    encoding: 'buffer',
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    killSignal: KILL_SIGNAL,
  });
  return Uint8Array.from(stdout);
};

/** Construction knobs for {@link AdbCli} — also the seams unit tests drive it through. */
export interface AdbCliOptions {
  /** Per-call timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Binary to invoke (default `adb`). */
  bin?: string;
  /** Subprocess runner (default {@link execFileBytes}). */
  exec?: AdbExec;
}

/**
 * The ADB transport the adapter depends on — implemented by {@link AdbCli}, faked in tests.
 *
 * `deadline` is an ABSOLUTE wall-clock instant (epoch ms) the call must not outlive —
 * the same shape as `AtspiReadOptions.deadline`. Omit it for the transport's own
 * per-call cap.
 */
export interface Adb {
  /** `adb <target> shell <command…>` → stdout text. */
  shell(command: string[], deadline?: number): Promise<string>;
  /** `adb <target> exec-out <command…>` → raw stdout bytes (binary-safe, e.g. `screencap -p`). */
  execOut(command: string[], deadline?: number): Promise<Uint8Array>;
  /** `adb <target> <args…>` → stdout text (top-level: `wait-for-device`, `emu kill`, …). */
  adb(args: string[], deadline?: number): Promise<string>;
}

/**
 * `execFile`-backed {@link Adb}. Construct with the device-selection `flags`
 * (`['-s', serial]` — the config serial when attaching, `emulator-<port>` when managed).
 */
export class AdbCli implements Adb {
  readonly #flags: string[];
  readonly #timeoutMs: number;
  readonly #bin: string;
  readonly #exec: AdbExec;

  constructor(flags: string[], options: AdbCliOptions = {}) {
    this.#flags = flags;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#bin = options.bin ?? ADB;
    this.#exec = options.exec ?? execFileBytes;
  }

  shell(command: string[], deadline?: number): Promise<string> {
    return this.#text(['shell', ...command], deadline);
  }

  adb(args: string[], deadline?: number): Promise<string> {
    return this.#text(args, deadline);
  }

  execOut(command: string[], deadline?: number): Promise<Uint8Array> {
    return this.#bytes(['exec-out', ...command], deadline);
  }

  /** UTF-8 view of the byte read — `adb`'s text channels (`am`, `getprop`, `logcat`) are UTF-8. */
  async #text(args: string[], deadline?: number): Promise<string> {
    return DECODER.decode(await this.#bytes(args, deadline));
  }

  async #bytes(args: string[], deadline?: number): Promise<Uint8Array> {
    const timeoutMs = this.#timeoutFor(deadline);
    let bytes: Uint8Array;
    try {
      bytes = await this.#exec(this.#bin, [...this.#flags, ...args], timeoutMs);
    } catch (error) {
      throw this.#wrap(args, error, timeoutMs);
    }
    // The subprocess cap bounds the CHILD, not the answer: a child that exits just
    // after the deadline still resolves here. Reporting that as success would let a
    // wedged adb answer minutes past the caller's budget — reject instead. Keep this
    // outside the subprocess catch: a late answer is not a subprocess failure and
    // must not be re-wrapped as one.
    this.#assertBeforeDeadline(args, deadline);
    return bytes;
  }

  /**
   * The effective per-call cap: the transport's own default, shortened to the time
   * left until `deadline` when one is given. `capWait` floors a spent budget at 1ms
   * (never 0 — a 0ms timeout would mean "no timeout" to some runners) and rejects a
   * non-finite/negative budget, so the clamp stays in one place.
   */
  #timeoutFor(deadline?: number): number {
    if (deadline === undefined) return this.#timeoutMs;
    return capWait(this.#timeoutMs, Math.max(0, deadline - Date.now()));
  }

  /** Fail loud when a call resolved after its deadline — a late answer is not an answer. */
  #assertBeforeDeadline(args: string[], deadline?: number): void {
    if (deadline === undefined) return;
    const now = Date.now();
    if (now > deadline) {
      throw new AdbError(
        `adb ${args[0] ?? ''} resolved ${now - deadline}ms after its deadline ` +
          `(deadline ${deadline}ms — the enclosing budget had already run out)`,
      );
    }
  }

  /**
   * Wrap any subprocess failure as a loud {@link AdbError}: ENOENT → a clear install
   * hint, expiry (the child was killed by our `timeout`) → a wedge report naming the cap.
   */
  #wrap(args: string[], error: unknown, timeoutMs: number): AdbError {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new AdbError('android: `adb` not found on PATH (install Android platform-tools)');
    }
    if (
      error instanceof Error &&
      (error as { killed?: boolean }).killed === true &&
      (error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
    ) {
      return new AdbError(
        `adb ${args[0] ?? ''} timed out after ${timeoutMs}ms (${KILL_SIGNAL}ed — adb or the emulator is wedged)`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AdbError(`adb ${args[0] ?? ''} failed: ${message}`);
  }
}
