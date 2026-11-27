/**
 * Bounded graceful shutdown — the signal/client-death path out of the server.
 *
 * A SIGTERM (a CLI `stop`), a SIGINT, or the MCP client disconnecting all mean the
 * same thing: end the active run, free the profile, exit. That teardown awaits the
 * agent loop, which awaits whatever tool call is in flight — and a call that never
 * observes its abort signal (CDP parked on a modal/`beforeunload`, a wedged `adb
 * exec`) never returns. An unbounded wait there is fatal, not merely slow: `stop`
 * has already written `status: 'stopped'` and sent its one SIGTERM, so a second
 * `stop` refuses to signal again — the run becomes unstoppable from the CLI, and
 * the project unstartable, with Chrome still holding the lock.
 *
 * So the wait is capped. A clean teardown exits as soon as it finishes; a wedged
 * one exits anyway once the deadline passes, dropping the run rather than the whole
 * project. Everything is injected, so the timing is unit-testable with no signals
 * and no `process.exit`.
 */

/** How long a graceful teardown gets before the process exits regardless. */
export const SHUTDOWN_TIMEOUT_MS = 10_000;

/** The seams {@link createShutdown} drives — the service teardown and the exit. */
export interface ShutdownDeps {
  /** End whatever run is active (`DebugService.endActive`). */
  endActive: () => Promise<void>;
  /** Terminate the process; called exactly once. */
  exit: (code: number) => void;
  /** Cap on the graceful wait; defaults to {@link SHUTDOWN_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Sink for the "gave up waiting" / "teardown failed" lines; defaults to `console.error`. */
  warn?: (line: string) => void;
}

/**
 * Build the shutdown handler: tear the run down, then exit with `code` — after
 * `timeoutMs` at the very latest. Fire-and-forget (signal handlers are sync).
 *
 * Single-flight: the FIRST invocation owns the teardown and its exit code; every
 * later one is a no-op. A dying client closes stdin AND signals, so two triggers
 * are the normal case — and `endActive` answers the second at once (the manager
 * frees the slot before the close), which used to exit the process while the
 * first teardown was still closing the browser and writing the verdict.
 */
export function createShutdown(deps: ShutdownDeps): (code: number) => void {
  const timeoutMs = deps.timeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  const warn = deps.warn ?? ((line: string) => console.error(line));
  let started = false;
  return (code: number) => {
    if (started) return;
    started = true;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      deps.exit(code);
    };
    const timer = setTimeout(() => {
      warn(
        `ui-debugger-mcp: graceful shutdown did not finish within ${timeoutMs}ms — exiting anyway. ` +
          'The debug run may not have closed its target cleanly.',
      );
      finish();
    }, timeoutMs);
    deps
      .endActive()
      // Still exits — but a teardown that failed may have left its target up, and
      // this process is about to be the last witness: say so before it goes.
      .catch((error: unknown) => {
        warn(
          `ui-debugger-mcp: teardown failed during shutdown — ${error instanceof Error ? error.message : String(error)}. ` +
            'The debug run may not have closed its target cleanly.',
        );
      })
      .finally(() => {
        clearTimeout(timer);
        finish();
      });
  };
}
