/**
 * The managed desktop app's process lifecycle — spawn, death latch, teardown.
 *
 * Split out of `desktop-adapter.ts` (one responsibility per file): the adapter
 * drives the window, this owns the `launch` command's process group.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { AdapterError } from '../../errors.js';
import { groupAlive, terminateGroup } from './proc.js';

/**
 * Appended to the early-exit diagnosis when the launch command itself exits (code
 * or signal) before any window appears. A possibility, never a proof: the exit
 * code alone cannot show the command daemonized, so the hint names the likely
 * shape and the fix, not a cause.
 */
const EARLY_EXIT_HINT =
  '. The command may have backgrounded or daemonized itself (e.g. a trailing &, nohup, or a wrapper that forks) — that exits before any window can appear. Use a foreground launch command that stays alive holding the window';

/** The managed child, paired with the death latch `open` races the window wait against. */
export interface Launched {
  proc: ChildProcess;
  /** Rejects (loud, naming the exit code/signal) the moment the child dies. Never resolves. */
  died: Promise<never>;
}

/** Owns the launched app's detached process group. */
export class ManagedApp {
  readonly #command: string;
  readonly #env: NodeJS.ProcessEnv;
  #child: Launched | null = null;
  /**
   * Process group of a launch leader that already exited. The leader dying does not
   * mean the group is empty: a wrapper that backgrounds the app (`app &`) exits while
   * the app lives on in the group — and with `#child` cleared nothing else would ever
   * signal it, leaving the app (and its X/profile locks) orphaned past `stop`.
   */
  #lingering: number | null = null;

  constructor(command: string, env: NodeJS.ProcessEnv) {
    this.#command = command;
    this.#env = env;
  }

  /**
   * Spawn the managed app (a live child is reused) and latch its death.
   *
   * `stdio: 'ignore'` keeps the app detached from our stdio MCP channel, so the exit
   * code is the only signal we get — hence the latch: {@link Launched.died} carries it
   * to whoever is waiting in `open`.
   */
  launch(): Launched {
    const running = this.#child;
    if (running) return running;
    const command = this.#command;
    const proc = spawn('/bin/sh', ['-c', command], {
      env: this.#env,
      detached: true,
      stdio: 'ignore',
    });
    const died = new Promise<never>((_resolve, reject) => {
      const down = (reason: string, hint = ''): void => {
        // A dead app must not pin `#child`: clear it so a later `open` relaunches
        // and `stop` never kills a recycled process group.
        if (this.#child?.proc === proc) {
          this.#child = null;
          // Remember the group only while it still has members: a pgid cannot be
          // reused while one lives, but an EMPTY group's number can name an unrelated
          // group by the time `stop` signals it.
          this.#lingering = proc.pid !== undefined && groupAlive(proc.pid) ? proc.pid : null;
        }
        reject(
          new AdapterError(
            `desktop: launch command exited (${reason}) before the window appeared: ${command}${hint}`,
          ),
        );
      };
      // The daemonization hint rides the exit event only — on 'error' (spawn
      // failed) the command never ran, so the hint would mislead there.
      proc.once('exit', (code, signal) =>
        down(signal ? `killed by ${signal}` : `exit code ${code ?? 'unknown'}`, EARLY_EXIT_HINT),
      );
      // 'error' fires async: unlistened, a missing `/bin/sh` would crash the server.
      proc.once('error', (error) => down(`spawn failed: ${error.message}`));
    });
    // The app normally outlives `open`, so its eventual exit rejects with nobody racing
    // it — pre-handle so a clean quit is never an unhandled rejection.
    died.catch(() => {});
    const launched: Launched = { proc, died };
    this.#child = launched;
    return launched;
  }

  /**
   * Managed teardown: SIGTERM the launched process group, then SIGKILL it if it is still
   * alive after the grace period; an already-dead process is a no-op.
   *
   * The handle is dropped only once the group is confirmed gone — an app that traps
   * SIGTERM (prompting "save changes?") would otherwise survive, with nothing left to
   * kill it and its X/profile locks held until the user does it by hand.
   */
  async stop(): Promise<void> {
    const pid = this.#child?.proc.pid;
    if (pid !== undefined) {
      await terminateGroup(pid);
      this.#child = null;
    }
    await this.reapLingering();
  }

  /** Stop whatever an exited launch leader left behind in its group (no-op when empty). */
  async reapLingering(): Promise<void> {
    const pid = this.#lingering;
    if (pid === null) return;
    await terminateGroup(pid);
    this.#lingering = null;
  }
}

/**
 * A window xdotool cannot find, on a Wayland session, is usually a native-Wayland
 * window: xdotool only sees (and can only drive) XWayland clients, and no input path
 * exists for the rest. Name that instead of leaving a bare timeout.
 */
export function withWaylandHint(error: unknown): unknown {
  if (!(error instanceof AdapterError) || !error.message.startsWith('desktop: window not found')) {
    return error;
  }
  return new AdapterError(
    `${error.message} — WAYLAND_DISPLAY is set: native Wayland windows are invisible to xdotool ` +
      '(capture works via grim, but input does not). Run the app under XWayland ' +
      '(e.g. GDK_BACKEND=x11, QT_QPA_PLATFORM=xcb) or point `display` at an Xvfb',
    { cause: error },
  );
}
