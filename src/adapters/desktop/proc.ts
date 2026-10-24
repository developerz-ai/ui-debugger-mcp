/**
 * Subprocess + environment plumbing for the desktop adapter's CLI tools
 * (`xdotool`, `scrot`/`grim`, `busctl`), plus the managed-process teardown
 * ({@link terminateGroup}) the android adapter shares.
 *
 * The desktop adapter drives the target by shelling out — there is no in-process
 * SDK like CDP. Every tool runs on a chosen X11 `DISPLAY` (e.g. `:99` for an Xvfb
 * container), so {@link desktopEnv} threads that through. {@link makeExec} is the
 * one I/O seam: production binds the real `execFile`, tests inject a fake to drive
 * the pure orchestration without spawning anything.
 *
 * Fails loud — a non-zero exit rejects through `execFile`, and callers re-wrap it
 * as an {@link AdapterError}; never a silent fallback. Every invocation is also
 * wall-clock capped, so no wedged tool can park the run (see {@link makeExec}).
 *
 * The cap is per-invocation, so on its own it can OUTLAST the budget the caller
 * handed down (a run's remaining wall-clock, a `waitFor` timeout). Hence the
 * absolute deadline ({@link ExecOptions.deadline}): the subprocess is capped by the
 * time left until it, and a call that resolves after it rejects — an enclosing
 * budget is never outlived by the tool's own default.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ExecTimeoutError } from '../../errors.js';

const pExecFile = promisify(execFile);

/** 16 MiB stdout cap — busctl JSON is small; the screenshots route through a file. */
const MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Default per-invocation wall-clock cap. These tools do wedge in practice — `busctl`
 * against an unresponsive AT-SPI peer, `xdotool --sync` waiting on a window that never
 * settles — and an unbounded `execFile` parks the whole operation behind that one call
 * until the outer session timeout. 10 s is far above any healthy input/a11y round-trip;
 * capture passes its own, longer cap (`capture.ts`).
 */
export const DEFAULT_EXEC_TIMEOUT_MS = 10_000;

/**
 * Kill signal on expiry. SIGKILL, not SIGTERM: a tool blocked on a hung X11/D-Bus
 * round-trip is exactly the process that ignores a polite signal, and Node only
 * rejects once the child is actually gone.
 */
const KILL_SIGNAL = 'SIGKILL';

/** Per-call options for one {@link Exec} invocation. */
export interface ExecOptions {
  /**
   * Absolute wall-clock instant (epoch ms) the call must not run past. The
   * subprocess is capped by the time left until then (never above the adapter's own
   * default), and a call that resolves after it rejects as an
   * {@link ExecTimeoutError} instead of counting as a success.
   *
   * An absolute instant, not a duration: the enclosing budget is shared by every
   * call it covers, so each one has to be told the same instant.
   */
  deadline?: number;
}

/** Run a CLI tool, resolve its stdout, reject (loud) on a non-zero exit or a missing binary. */
export type Exec = (cmd: string, args: string[], opts?: ExecOptions) => Promise<string>;

/**
 * A child env with `DISPLAY` overridden when a target display is configured (else inherit).
 * An explicit display also drops any inherited `WAYLAND_DISPLAY` — the user pointed us at
 * an X11 display (e.g. Xvfb `:99`), so capture/input must not dispatch to the live
 * Wayland session ({@link chooseCaptureTool} checks `WAYLAND_DISPLAY` first).
 */
export function desktopEnv(display?: string): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (display) {
    env.DISPLAY = display;
    delete env.WAYLAND_DISPLAY;
  }
  return env;
}

/**
 * The real {@link Exec}: `execFile` bound to a fixed child env and a wall-clock cap
 * (`timeoutMs`, default {@link DEFAULT_EXEC_TIMEOUT_MS}). Expiry kills the child and
 * rejects as an {@link ExecTimeoutError} naming the cap; every other failure passes through
 * **raw** so callers can still triage the real `execFile` error (ENOENT, exit code,
 * stderr) — `xdotool search` exiting non-zero with empty stderr means "no window yet".
 *
 * With a {@link ExecOptions.deadline} the call is capped by the time left until that
 * instant instead of by its own default, and a result that arrives after it rejects —
 * the enclosing budget (a run's remaining time, a `waitFor` timeout) is never
 * outlived by a tool that happens to be slow.
 *
 * @param now the clock, injectable for tests (defaults to `Date.now`). Shifting the
 *   global clock from a test leaks into every test file `bun test` runs alongside it;
 *   a seam keeps the deadline logic deterministic with no cross-file blast radius.
 */
export function makeExec(
  env: NodeJS.ProcessEnv,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  now: () => number = Date.now,
): Exec {
  return async (cmd, args, opts = {}) => {
    const deadline = opts.deadline;
    if (deadline !== undefined && now() >= deadline) {
      // The budget is already spent — starting the tool would only outlive it.
      throw new ExecTimeoutError(
        `desktop: \`${cmd}\` was not started — its deadline (${deadline}) has already passed`,
      );
    }
    const cap =
      deadline === undefined ? timeoutMs : Math.max(1, Math.min(timeoutMs, deadline - now()));
    try {
      const { stdout } = await pExecFile(cmd, args, {
        env,
        maxBuffer: MAX_BUFFER,
        timeout: cap,
        killSignal: KILL_SIGNAL,
      });
      // The child may have finished right as the deadline passed (the kill timer and
      // the child's exit race). A result read after the deadline is stale: the caller
      // asked for an answer within its budget, so this is a failure, not a success.
      if (deadline !== undefined && now() >= deadline) {
        throw new ExecTimeoutError(
          `desktop: \`${cmd}\` resolved after its deadline (${deadline}) had passed`,
        );
      }
      return stdout;
    } catch (error) {
      if (!killedByTimeout(error)) throw error;
      throw new ExecTimeoutError(
        `desktop: \`${cmd}\` timed out after ${cap}ms (${KILL_SIGNAL}ed — the tool or its display/bus is wedged)`,
        { cause: error },
      );
    }
  };
}

/**
 * True when `execFile` killed the child on `timeout` expiry. `killed` alone is not
 * enough: a `maxBuffer` overflow also kills, and that is a different (still loud) bug.
 */
function killedByTimeout(error: unknown): boolean {
  if (!(error instanceof Error) || (error as { killed?: boolean }).killed !== true) return false;
  return (error as NodeJS.ErrnoException).code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
}

/** Grace a SIGTERMed process group gets to exit on its own before the SIGKILL escalation. */
const TERM_GRACE_MS = 2000;
const TERM_POLL_MS = 100;

/**
 * Signal a whole **detached process group** (`-pid`, so the shell *and* the app it
 * spawned). Returns false once the group is gone (`ESRCH`); any other errno is loud.
 */
function signalGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Tear a managed target down: SIGTERM its group, wait for it to actually die, escalate
 * to SIGKILL after `graceMs`.
 *
 * A polite signal is not a guarantee: an app with a SIGTERM handler (prompting "save
 * changes?") survives it, and once the caller drops the pid nothing can ever kill it —
 * the app is reparented to init, still holding its X/profile locks. So the caller must
 * keep the handle until this resolves.
 */
export async function terminateGroup(pid: number, graceMs = TERM_GRACE_MS): Promise<void> {
  if (!signalGroup(pid, 'SIGTERM')) return;
  const deadline = Date.now() + graceMs;
  while (signalGroup(pid, 0)) {
    if (Date.now() >= deadline) {
      signalGroup(pid, 'SIGKILL');
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, TERM_POLL_MS));
  }
}

/** True when an error is a "binary not found on PATH" (`ENOENT`) — for a clear, loud message. */
export function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Compact message extractor for wrapping a thrown subprocess error. */
export function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
