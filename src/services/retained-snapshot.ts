/**
 * The retained snapshot — the last run that ended WITHOUT the caller asking.
 *
 * A run that auto-ends (wall-clock timeout, SIGTERM, the MCP client dying) is
 * torn down, but its findings must not vanish with it: the settled session is
 * kept so `get_findings` still serves its terminal snapshot and `describe` can
 * still name it. `end_session` is the explicit forget; the next `start_debug`
 * supersedes it.
 *
 * Split out of `debug-service.ts` to keep that file under the 500-LOC cap. The
 * slot is deliberately NOT a gate: a retained snapshot never blocks a start and
 * never takes new work — the one-run rule stays with the manager.
 */

import { SessionNotFoundError } from '../errors.js';
import type { Session } from '../session/session.js';

/** The retained slot: one settled run, kept readable until it is forgotten. */
export class RetainedSnapshot {
  /**
   * The last run that auto-ended (timeout / SIGTERM / client death), kept settled
   * and closed so `get_findings` can still read its partial findings + evidence.
   * Dropped by `end_session` (the explicit forget) and superseded by the next run.
   */
  #session: Session | undefined;

  /** Keep `session` as the retained snapshot — the run that auto-ended. */
  retain(session: Session): void {
    this.#session = session;
  }

  /** Forget the retained snapshot (the explicit `end_session` forget, or a superseding run). */
  clear(): void {
    this.#session = undefined;
  }

  /** The retained snapshot, or `undefined` when there is none. */
  peek(): Session | undefined {
    return this.#session;
  }

  /**
   * Forget the snapshot when `sessionId` names it — the run is already torn down,
   * so there is nothing left to close. Returns whether the id WAS the retained one
   * (and it is now forgotten).
   */
  forget(sessionId: string): boolean {
    if (this.#session?.id !== sessionId) return false;
    this.#session = undefined;
    return true;
  }

  /**
   * The session a read names among the retained ones: the retained run itself, or
   * a loud miss that names the run that IS readable — a caller holding a stale id
   * must not be told the findings are gone when they are one id away.
   */
  requireRetained(sessionId: string, cwd: string): Session {
    const retained = this.#session;
    if (retained === undefined) {
      throw new SessionNotFoundError(`No active debug session '${sessionId}' for '${cwd}'.`);
    }
    if (retained.id !== sessionId) {
      throw new SessionNotFoundError(
        `No active debug session '${sessionId}' for '${cwd}' (the last run '${retained.id}' ` +
          'has ended; its findings are still readable under that id).',
      );
    }
    return retained;
  }
}
