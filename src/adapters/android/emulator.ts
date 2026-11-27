/**
 * The managed emulator process and its boot poll — split from the adapter so the
 * adapter stays the contract wiring. {@link ManagedEmulator} owns the child (and its
 * listeners) until {@link ManagedEmulator.terminate}; {@link awaitBooted} is the bounded
 * replacement for `adb wait-for-device` + the `sys.boot_completed` poll.
 */

import type { ChildProcess } from 'node:child_process';
import { AdapterError } from '../../errors.js';
import { terminateGroup } from '../desktop/proc.js';
import { type Adb, pendingStateOrThrow } from './adb.js';

/** Poll interval for the boot and `waitFor` loops. */
export const POLL_MS = 300;

export const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Launch the emulator process — the spawn seam tests replace with a fake child. */
export type SpawnEmulator = (bin: string, args: string[]) => ChildProcess;

/** The emulator child we started: its handle, and why it is unusable once it is. */
export class ManagedEmulator {
  readonly #spawn: SpawnEmulator;
  #child: ChildProcess | null = null;
  /**
   * The process group we own. Outlives the child's liveness: a wrapper launcher may
   * exit while the emulator it backgrounded keeps running in the same group, so the
   * pid is kept until {@link ManagedEmulator.terminate} has reaped the group.
   */
  #group: number | null = null;
  /** Why the process is unusable (launch failure / early exit), or null. */
  #down: string | null = null;

  constructor(spawn: SpawnEmulator) {
    this.#spawn = spawn;
  }

  /** True while a launched child is tracked (cleared on exit, error or terminate). */
  get running(): boolean {
    return this.#child !== null;
  }

  get down(): string | null {
    return this.#down;
  }

  /** Spawn `bin args` and track it. */
  start(bin: string, args: string[]): void {
    const child = this.#spawn(bin, args);
    this.#down = null;
    // Both fire async (later tick): without a listener a bad `emulatorPath` would
    // crash the whole server via an unhandled 'error' event. Capture the failure
    // and let the boot poll surface it as a loud AdapterError.
    // A handler acts only for the child it was bound to: a closed child's late
    // event must not fail, or drop the handle of, the emulator a re-open spawned.
    child.on('error', (err) => {
      if (this.#child !== child) return;
      this.#down = `emulator ('${bin}') failed to launch: ${err.message}`;
      this.#child = null;
    });
    child.on('exit', (code, signal) => {
      if (this.#child !== child) return;
      this.#down ??= `emulator ('${bin}') exited before boot (${signal ?? code ?? 'unknown'})`;
      this.#child = null;
    });
    this.#child = child;
    this.#group = child.pid ?? null;
  }

  /**
   * SIGTERM the group, escalate to SIGKILL, and keep the handle until death is
   * confirmed — a dropped handle leaves a SIGTERM-ignoring emulator orphaned for good.
   */
  async terminate(): Promise<void> {
    if (this.#group !== null) await terminateGroup(this.#group);
    this.#group = null;
    this.#child = null;
  }
}

/** What the boot poll needs to word its failures. */
export interface BootContext {
  avd: string | undefined;
  serial: string | null;
  bootWaitMs: number;
}

/**
 * Poll until the emulator answers `get-state` and reports `sys.boot_completed`, bounded
 * by the absolute `deadline`. Fails loud when the emulator died, the poll hit a real
 * error ({@link pendingStateOrThrow}) or the deadline passed — never hangs `open`.
 * Every call carries the deadline, so a wedged `adb` cannot hold the boot past it.
 */
export async function awaitBooted(
  adb: Adb,
  emulator: ManagedEmulator,
  deadline: number,
  ctx: BootContext,
): Promise<void> {
  const label = `emulator @${ctx.avd} (${ctx.serial})`;
  const downError = (): AdapterError | null =>
    emulator.down === null ? null : new AdapterError(`android: ${emulator.down}`);
  for (;;) {
    const died = downError();
    if (died) throw died;
    // `get-state` exits non-zero while no device is connected — that alone is "keep
    // waiting"; a missing `adb`, an ambiguous target or a wedged call surfaces now.
    const state = await adb.adb(['get-state'], deadline).catch(pendingStateOrThrow);
    if (Date.now() >= deadline) {
      throw new AdapterError(`android: no device appeared within ${ctx.bootWaitMs}ms (${label})`);
    }
    if (state.trim() === 'device') break;
    await delay(POLL_MS);
  }
  for (;;) {
    // The device can flap offline mid-boot, or the emulator can die after its device
    // appeared: retry the former, report the latter as what it is — not as the
    // `device not found` it makes `getprop` say.
    const out = (
      await adb.shell(['getprop', 'sys.boot_completed'], deadline).catch((error: unknown) => {
        const died = downError();
        if (died) throw died;
        return pendingStateOrThrow(error);
      })
    ).trim();
    // The emulator may have died while a successful reply was in flight.
    const died = downError();
    if (died) throw died;
    if (Date.now() >= deadline) {
      throw new AdapterError(`android: ${label} did not boot within ${ctx.bootWaitMs}ms`);
    }
    if (out === '1') return;
    await delay(POLL_MS);
  }
}
