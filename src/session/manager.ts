/**
 * Session manager — the cwd-keyed registry that enforces one debug run per project.
 *
 * One project (cwd) = one session (`idea/overview.md`, `idea/architecture.md`).
 * That project's persistent Chrome profile can only be driven by a single
 * browser at a time, so the manager is the in-process gate that holds the
 * profile lock: while a session is registered for a cwd, a second `start()`
 * fails loud with `SessionBusyError`. Ending the session frees the lock.
 *
 * The manager is deliberately blind to what a session *is* — it only needs the
 * `ManagedSession` surface (an id + how to close it). The concrete session
 * (agent loop, adapter, findings store) is wired in later tasks.
 */

import { SessionBusyError, SessionNotFoundError } from '../errors.js';

/** The minimal surface the manager needs to own a session's lifecycle. */
export interface ManagedSession {
  /** Stable session id (e.g. from `generateSessionId`). */
  readonly id: string;
  /** Release everything the run holds — abort the loop, close the adapter, free the profile. */
  close(): Promise<void>;
}

/**
 * Registry of active debug sessions, keyed by absolute cwd.
 * @typeParam S - concrete session type (defaults to the bare `ManagedSession` surface).
 */
export class SessionManager<S extends ManagedSession = ManagedSession> {
  /** Active sessions keyed by absolute cwd. Presence of an entry = the project's profile is locked. */
  readonly #sessions = new Map<string, S>();

  /**
   * Register `session` as the active run for `cwd`, taking the project's profile lock.
   * @returns the same session, for ergonomic inline construction.
   * @throws {SessionBusyError} if a session is already active for this cwd.
   */
  start(cwd: string, session: S): S {
    const existing = this.#sessions.get(cwd);
    if (existing) {
      throw new SessionBusyError(
        `A debug session ('${existing.id}') is already active for '${cwd}'. ` +
          'End it before starting another — one run per project at a time.',
      );
    }
    this.#sessions.set(cwd, session);
    return session;
  }

  /**
   * Get the active session for `cwd`.
   * @throws {SessionNotFoundError} if no session is active for this cwd.
   */
  get(cwd: string): S {
    const session = this.#sessions.get(cwd);
    if (!session) {
      throw new SessionNotFoundError(`No active debug session for '${cwd}'.`);
    }
    return session;
  }

  /** Whether a session is currently active for `cwd` (non-throwing). */
  has(cwd: string): boolean {
    return this.#sessions.has(cwd);
  }

  /**
   * End the active session for `cwd`: free the profile lock, then close the session.
   * The slot is released *before* `close()` runs, so a failed teardown never wedges
   * the project — the close error still propagates to the caller.
   * @throws {SessionNotFoundError} if no session is active for this cwd.
   */
  async end(cwd: string): Promise<void> {
    const session = this.#sessions.get(cwd);
    if (!session) {
      throw new SessionNotFoundError(`No active debug session to end for '${cwd}'.`);
    }
    this.#sessions.delete(cwd);
    await session.close();
  }
}
