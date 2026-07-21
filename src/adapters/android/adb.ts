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
 * exit or a missing binary rejects as an {@link AdbError}, never a silent fallback.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdbError } from '../../errors.js';

const pExecFile = promisify(execFile);

const ADB = 'adb';

/** 64 MiB stdout cap — `screencap -p` PNGs run a few MB on hi-dpi panels; text replies are tiny. */
const MAX_BUFFER = 64 * 1024 * 1024;

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

  constructor(flags: string[]) {
    this.#flags = flags;
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
      const { stdout } = await pExecFile(ADB, [...this.#flags, ...args], {
        encoding: 'buffer',
        maxBuffer: MAX_BUFFER,
      });
      return Uint8Array.from(stdout);
    } catch (error) {
      throw this.#wrap(args, error);
    }
  }

  async #text(args: string[]): Promise<string> {
    try {
      const { stdout } = await pExecFile(ADB, [...this.#flags, ...args], { maxBuffer: MAX_BUFFER });
      return stdout;
    } catch (error) {
      throw this.#wrap(args, error);
    }
  }

  /** Wrap any subprocess failure as a loud {@link AdbError} (ENOENT → a clear install hint). */
  #wrap(args: string[], error: unknown): AdbError {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return new AdbError('android: `adb` not found on PATH (install Android platform-tools)');
    }
    const message = error instanceof Error ? error.message : String(error);
    return new AdbError(`adb ${args[0] ?? ''} failed: ${message}`);
  }
}
