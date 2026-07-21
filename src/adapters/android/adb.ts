/**
 * ADB (Android Debug Bridge) transport — the one I/O seam for the android adapter.
 *
 * Android is **fully framework-driven** (no vision needed): every read/act/capture
 * is an `adb` subprocess (`idea/desktop-control.md`). This module is the thin runner
 * that shells out; all command *shapes* (`input tap`, `uiautomator dump`, keycodes)
 * live in the pure builders beside it (`commands.ts`, `uiautomator.ts`) so they stay
 * unit-testable without spawning. {@link AdbCli} is injected as a seam in tests.
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
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdbError } from '../../errors.js';

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

/** Construction knobs for {@link AdbCli} — also the seams unit tests drive it through. */
export interface AdbCliOptions {
  /** Per-call timeout in ms (default {@link DEFAULT_TIMEOUT_MS}). */
  timeoutMs?: number;
  /** Binary to invoke (default `adb`). */
  bin?: string;
}

/** The ADB transport the adapter depends on — implemented by {@link AdbCli}, faked in tests. */
export interface Adb {
  /** `adb <target> shell <command…>` → stdout text. */
  shell(command: string[]): Promise<string>;
  /** `adb <target> exec-out <command…>` → raw stdout bytes (binary-safe, e.g. `screencap -p`). */
  execOut(command: string[]): Promise<Uint8Array>;
  /** `adb <target> <args…>` → stdout text (top-level: `wait-for-device`, `emu kill`, …). */
  adb(args: string[]): Promise<string>;
}

/**
 * `execFile`-backed {@link Adb}. Construct with the device-selection `flags`
 * (`['-s', serial]` — the config serial when attaching, `emulator-<port>` when managed).
 */
export class AdbCli implements Adb {
  readonly #flags: string[];
  readonly #timeoutMs: number;
  readonly #bin: string;

  constructor(flags: string[], options: AdbCliOptions = {}) {
    this.#flags = flags;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#bin = options.bin ?? ADB;
  }

  shell(command: string[]): Promise<string> {
    return this.#text(['shell', ...command]);
  }

  adb(args: string[]): Promise<string> {
    return this.#text(args);
  }

  async execOut(command: string[]): Promise<Uint8Array> {
    const args = ['exec-out', ...command];
    try {
      const { stdout } = await pExecFile(this.#bin, [...this.#flags, ...args], {
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
        timeout: this.#timeoutMs,
        killSignal: KILL_SIGNAL,
      });
      return Uint8Array.from(stdout);
    } catch (error) {
      throw this.#wrap(args, error);
    }
  }

  async #text(args: string[]): Promise<string> {
    try {
      const { stdout } = await pExecFile(this.#bin, [...this.#flags, ...args], {
        maxBuffer: MAX_BUFFER,
        timeout: this.#timeoutMs,
        killSignal: KILL_SIGNAL,
      });
      return stdout;
    } catch (error) {
      throw this.#wrap(args, error);
    }
  }

  /**
   * Wrap any subprocess failure as a loud {@link AdbError}: ENOENT → a clear install
   * hint, expiry (the child was killed by our `timeout`) → a wedge report naming the cap.
   */
  #wrap(args: string[], error: unknown): AdbError {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new AdbError('android: `adb` not found on PATH (install Android platform-tools)');
    }
    if (error instanceof Error && (error as { killed?: boolean }).killed === true) {
      return new AdbError(
        `adb ${args[0] ?? ''} timed out after ${this.#timeoutMs}ms (${KILL_SIGNAL}ed — adb or the emulator is wedged)`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AdbError(`adb ${args[0] ?? ''} failed: ${message}`);
  }
}
