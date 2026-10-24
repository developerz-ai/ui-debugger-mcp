/**
 * Session manager — the cwd-keyed registry that enforces one debug run per project.
 *
 * One project (cwd) = one session (`idea/overview.md`, `idea/architecture.md`).
 * That project's persistent Chrome profile can only be driven by a single
 * browser at a time, so the manager is the in-process gate that holds the
 * profile lock: while a session is registered for a cwd, a second `start()`
 * fails loud with `SessionBusyError`. Ending frees the slot at once — a failed
 * teardown must never wedge the project — but slot-free ≠ project-free: `end()`
 * keeps a per-cwd *closing* gate shut until the teardown's `close()` settles
 * (success OR failure), so a successor start never launches onto resources the
 * ending run was still releasing.
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
   * Sessions whose teardown is still in flight, keyed by absolute cwd — the
   * delayed-teardown gate. The slot is freed before `close()` (see `end`), so
   * this map is what tells a starting run "the previous one is STILL letting go".
   */
  readonly #closing = new Map<string, { id: string; closed: Promise<void> }>();

  /**
   * Register `session` as the active run for `cwd`, taking the project's profile lock.
   * @returns the same session, for ergonomic inline construction.
   * @throws {SessionBusyError} if a session is already active for this cwd.
   */
  start(cwd: string, session: S): S {
    // The closing gate is checked ahead of the slot: a teardown still in flight
    // owns no slot, so the check below would sail straight past it.
    const closing = this.#closing.get(cwd);
    if (closing) {
      throw new SessionBusyError(
        `The previous debug session ('${closing.id}') for '${cwd}' is still closing — its ` +
          'teardown is releasing the profile lock. Wait a moment, then retry.',
      );
    }
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
   * The id of the session whose teardown is still in flight for `cwd`, or
   * `undefined` once the close has settled (success or failure) and a start is
   * allowed again. Refusals name it so the caller knows what they are waiting on.
   */
  closingId(cwd: string): string | undefined {
    return this.#closing.get(cwd)?.id;
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
    // The slot frees BEFORE the close (unchanged contract: a failed teardown must
    // never wedge the project) — but the project is not free yet: the teardown is
    // still releasing the browser/profile this cwd's runs share. Register the
    // closing session before awaiting it, so a start landing mid-teardown is
    // refused instead of launching onto resources the ending run still holds.
    const closed = session.close();
    const entry = { id: session.id, closed };
    this.#closing.set(cwd, entry);
    // Forget on settle — success OR failure, so a failed close reopens the gate
    // too. Identity-checked: only OUR entry may lift it (an end→start→end cycle
    // can have registered a newer closing session by the time this one settles).
    const forget = (): void => {
      if (this.#closing.get(cwd) === entry) this.#closing.delete(cwd);
    };
    // Attached ahead of the await, so the gate is already open when the caller
    // below sees the outcome.
    closed.then(forget, forget);
    // The close error still propagates to the caller.
    await closed;
  }
}
