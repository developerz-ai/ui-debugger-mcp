/**
 * Cross-process run state — the `state.json` the CLI reads.
 *
 * The live session lives in the server process's memory ({@link SessionManager}).
 * A separate `ui-debugger-mcp status` / `stop` invocation can't see that memory,
 * so the running server drops a small breadcrumb to `<workspace>/state.json`:
 * which run is active, the server `pid` (so `stop` can signal it and `status` can
 * tell live from stale), and where the session's `findings.json` lives (so
 * `status` can read the authoritative verdict + counts). Written on start, marked
 * `ended` on a clean end.
 *
 * The breadcrumb alone is ADVISORY: two servers can both read it before either
 * writes, and the second write hides the first owner's live run from
 * `status`/`stop`. The authority is the workspace's exclusive ownership lock
 * (`owner.lock`, see {@link ownerLockPath}) — a kernel-held `flock` that
 * {@link FileStatePort} takes BEFORE it publishes a breadcrumb, so exactly one
 * live server may own a workspace. A refused claim is a {@link SessionBusyError}
 * naming the owner; a crashed server's lock dies with its process, so a dead
 * run never wedges the project — there is nothing to reclaim.
 *
 * `record()` fails LOUD: a run nobody can see is a run nobody can stop — the
 * profile would stay locked with no way to reach the owner short of killing the
 * server by hand — so the service tears the start down instead. `clear(sessionId)`
 * stays best-effort: the run is already down, and the stale breadcrumb it leaves names
 * a pid whose liveness the CLI checks anyway.
 *
 * The {@link StatePort} seam keeps {@link DebugService} fs-free in unit tests — a
 * no-op port by default, the real {@link FileStatePort} wired at boot.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { SessionBusyError } from '../errors.js';
import { writeFileAtomic } from './atomic-write.js';
import {
  acquireOwnerLock,
  type OwnerLock,
  OwnerLockSchema,
  ownerLockPath,
  releaseOwnerLock,
} from './owner-lock.js';
import { captureIdentity, ownerAlive, ProcessIdentitySchema } from './process-identity.js';
import { sessionPaths, type WorkspacePaths } from './workspace.js';

/** `state.json` shape — the breadcrumb a separate CLI process reads. */
export const StateFileSchema = z.object({
  /** Server process id — `status` checks liveness, `stop` signals it. */
  pid: z.number().int().positive(),
  /** Active (or last) run's session id. */
  sessionId: z.string(),
  /** Configured target name the run drives. */
  target: z.string(),
  /** The goal handed to the run. */
  goal: z.string(),
  /** `running` while the server owns it; `ended` after a clean end; `stopped` after a CLI stop. */
  status: z.enum(['running', 'ended', 'stopped']),
  /** ISO timestamp the run started. */
  startedAt: z.string(),
  /** ISO timestamp of the last state write. */
  updatedAt: z.string(),
  /** Absolute path to the session dir (holds `findings.json`). */
  sessionDir: z.string(),
  /** Process fingerprint — lets the CLI tell our live server from a recycled `pid`. */
  identity: ProcessIdentitySchema,
});

export type StateFile = z.infer<typeof StateFileSchema>;

/**
 * Write `state.json` (creates the parent dir), replacing it atomically.
 *
 * The CLI reads this file from another process while the server writes it, so
 * the swap goes through {@link writeFileAtomic} — a `status`/`stop` that lands
 * mid-write must never read a truncated file and report "no debug run".
 */
export async function writeState(path: string, state: StateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

/** Read + validate `state.json`; `null` when absent or malformed (never throws). */
export async function readState(path: string): Promise<StateFile | null> {
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = StateFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * The two seams a breadcrumb lifecycle write flows through, as one injectable
 * unit — the real fs by default, a controllable fake in tests (so the
 * record-vs-clear write ordering can be pinned deterministically, without
 * racing real-fs timings).
 */
export interface StateIo {
  read(path: string): Promise<StateFile | null>;
  write(path: string, state: StateFile): Promise<void>;
}

/** The real fs — {@link StateIo} as {@link writeState}/{@link readState} implement it. */
export const fsStateIo: StateIo = { read: readState, write: writeState };

/** What a run reports to the state file when it opens. */
export interface RunState {
  sessionId: string;
  target: string;
  goal: string;
}

/** A run another live server owns for this workspace — the cross-process busy signal. */
export interface ForeignRun {
  /** The other server's process id (it is provably alive). */
  pid: number;
  /** The run it has active. */
  sessionId: string;
  /** Where that run writes its `findings.json` — how we read a run we do not own. */
  sessionDir: string;
}

/**
 * The seam {@link DebugService} writes run lifecycle through (no-op in tests).
 *
 * `record` and `clear` must be serialized per workspace: `clear` is a
 * read-modify-write whose id guard only holds when no `record` can publish
 * between its read and its write ({@link FileStatePort} queues them) — an
 * interleaved record would be overwritten with the ending run's stale
 * breadcrumb, leaving `ui-debugger-mcp stop` nothing live to signal.
 */
export interface StatePort {
  /**
   * Record the run as `running`. Throws when the breadcrumb cannot be written —
   * and when the workspace is already owned by another live server
   * ({@link SessionBusyError}).
   */
  record(run: RunState): Promise<void>;
  /**
   * Mark `ended` — ONLY the run whose session id this is, and ONLY by the
   * workspace's owner. If the breadcrumb names a different session (a successor
   * recorded itself while this teardown was in flight), leave it untouched:
   * ending a live successor's breadcrumb makes `ui-debugger-mcp stop` refuse the
   * run that is actually going.
   */
  clear(sessionId: string): Promise<void>;
  /**
   * The run a *different, live* server holds on this workspace, if any — the
   * cross-process half of the one-run gate. `null` when nobody else owns it.
   */
  foreignRun(): Promise<ForeignRun | null>;

  /**
   * The findings a foreign run has flushed to disk, by session id — `null` when
   * that id is not the foreign run, or nothing readable is there yet.
   *
   * Without this, a second client is told "pid N holds session S" by `start_debug`
   * and "no session S exists" by `get_findings` — two answers that cannot both be
   * true, and no way to learn whether S is still working or long dead.
   */
  foreignFindings(sessionId: string): Promise<unknown | null>;
}

/** Default port: writes nothing, sees nobody (keeps the service fs-free under unit test). */
export const noopStatePort: StatePort = {
  async record() {},
  async clear() {},
  async foreignRun() {
    return null;
  },
  async foreignFindings() {
    return null;
  },
};

/** fs-backed {@link StatePort} — drops the breadcrumb to `<workspace>/state.json`. */
export class FileStatePort implements StatePort {
  readonly #workspace: WorkspacePaths;
  readonly #pid: number;
  readonly #now: () => Date;
  readonly #io: StateIo;
  /**
   * Tail of this workspace's breadcrumb-write queue.
   *
   * `clear()` is a read-modify-write: read the breadcrumb, check the session
   * id, write it back. `record()` is an overwrite. Letting the two interleave
   * breaks the id guard — a teardown's clear reads the OLD breadcrumb, a
   * successor start records itself, the clear's write publishes last and
   * overwrites the live successor with the old ended run, so `stop` skips it.
   * Lifecycle writes therefore run one at a time per workspace: each finishes
   * before the next begins, so a clear's read never goes stale.
   */
  #writes: Promise<void> = Promise.resolve();

  constructor(
    workspace: WorkspacePaths,
    opts: { pid?: number; now?: () => Date; io?: StateIo } = {},
  ) {
    this.#workspace = workspace;
    this.#pid = opts.pid ?? process.pid;
    this.#now = opts.now ?? (() => new Date());
    this.#io = opts.io ?? fsStateIo;
  }

  /** Run `task` only once every breadcrumb write issued before it has fully settled. */
  #serialize(task: () => Promise<void>): Promise<void> {
    const run = this.#writes.then(task, task);
    // The tail must advance on a failed write too — one lost breadcrumb must
    // never jam every later lifecycle write behind it.
    this.#writes = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async record(run: RunState): Promise<void> {
    const iso = this.#now().toISOString();
    await this.#serialize(async () => {
      // The claim comes FIRST: it is the admission decision, and the breadcrumb
      // must never be published by a server that does not own the workspace.
      // A live foreign owner refuses here, before a single byte is written.
      const createdClaim = await this.#acquireClaim(run.sessionId, iso);
      try {
        await this.#io.write(this.#workspace.stateJson, {
          pid: this.#pid,
          sessionId: run.sessionId,
          target: run.target,
          goal: run.goal,
          status: 'running',
          startedAt: iso,
          updatedAt: iso,
          sessionDir: sessionPaths(this.#workspace, run.sessionId).root,
          identity: captureIdentity(this.#pid),
        });
      } catch (err) {
        // The breadcrumb never landed. Give back ONLY a claim this call
        // created: a re-entrant claim belongs to an earlier successful
        // record, and releasing it would hand a live workspace away.
        if (createdClaim) await this.#releaseClaim();
        throw err;
      }
    });
  }

  /**
   * Take the workspace's exclusive ownership lock, or fail loud.
   *
   * The lock is the AUTHORITATIVE one-run gate: the kernel grants it to one
   * process at a time and holds it for the owner's lifetime, so two servers
   * starting in the same window cannot both win, and no admission can be
   * invalidated after the fact. A live foreign owner is named in the refusal
   * (pid + session id) so the caller knows which server to stop; a crashed
   * owner's lock died with its process — the workspace is simply free.
   *
   * Returns whether this call CREATED the claim. A re-entrant acquire did not
   * create it, so a later failed breadcrumb write must not release the claim
   * held by an earlier successful record.
   */
  async #acquireClaim(sessionId: string, acquiredAt: string): Promise<boolean> {
    const lockPath = ownerLockPath(this.#workspace);
    await mkdir(dirname(lockPath), { recursive: true });
    const owner: OwnerLock = {
      pid: this.#pid,
      identity: captureIdentity(this.#pid),
      sessionId,
      acquiredAt,
    };
    const result = await acquireOwnerLock(lockPath, owner);
    if (result.acquired) return result.created;
    throw new SessionBusyError(
      `Another ui-debugger-mcp server (pid ${result.holder.pid}) already owns the debug ` +
        `session ('${result.holder.sessionId}') for this project. One run per project at a ` +
        "time. To take the project over, run 'ui-debugger-mcp stop' in this directory, then " +
        'start again.',
    );
  }

  /**
   * Release the lock — but ONLY when it still names us.
   *
   * Only the process holding the kernel lock can release it; the claim file is
   * a notice board, not the lock, and is never unlinked (unlinking the path
   * would put a fresh inode where a live owner's lock lives). The holder is
   * read back from disk rather than remembered, so a claim whose session id
   * moved on (a re-entrant acquire keeps the first id) is still recognised as
   * ours.
   */
  async #releaseClaim(): Promise<void> {
    const lockPath = ownerLockPath(this.#workspace);
    const holder = await this.#readClaim();
    if (holder === null) return; // no claim to release
    await releaseOwnerLock(lockPath, holder);
  }

  /** The claim currently on disk, or `null` when there is none (or it is malformed). */
  async #readClaim(): Promise<OwnerLock | null> {
    try {
      const raw = await readFile(ownerLockPath(this.#workspace), 'utf8');
      const parsed = OwnerLockSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  /**
   * Does this claim name US — our pid, and our process (not a recycled one)?
   *
   * Identity is compared on the start ticks: a recycled pid has a different
   * start time, so it never passes as us.
   */
  #isUs(holder: OwnerLock): boolean {
    if (holder.pid !== this.#pid) return false;
    const ours = captureIdentity(this.#pid);
    return holder.identity.startTicks === ours.startTicks;
  }

  async clear(sessionId: string): Promise<void> {
    // Best-effort stays: the run is already down, and a swallowed clear only
    // leaves a breadcrumb naming a pid whose liveness the CLI checks anyway.
    await this.#serialize(async () => {
      // Only the OWNER may end a run here. A stranger that knows (or guesses)
      // the session id must never mark somebody else's live run ended — that
      // would hide the live run from `ui-debugger-mcp stop`.
      const holder = await this.#readClaim();
      if (holder === null || !this.#isUs(holder)) return;
      const prior = await this.#io.read(this.#workspace.stateJson);
      // Scoped to the run being ended: a successor that recorded itself while
      // this teardown was in flight keeps its own breadcrumb AND its claim.
      if (prior?.sessionId !== sessionId) return;
      try {
        await markStatus(
          this.#workspace.stateJson,
          'ended',
          this.#now(),
          sessionId,
          this.#io,
          (state) => state.pid === this.#pid,
        );
      } finally {
        // The run is over either way: a breadcrumb write that THREW must not
        // leave a live-process claim behind — an ended run still holding the
        // claim wedges the workspace for every other server until this one
        // exits, with nothing left to end.
        await this.#releaseClaim();
      }
    }).catch(() => undefined);
  }

  /**
   * Who else is debugging this workspace? Only a breadcrumb that is `running`,
   * written by a pid that is *not* ours, and whose owner is provably still alive
   * ({@link ownerAlive} — a recycled or dead pid does not count) reports a
   * foreign run. Everything else is `null`: nobody to collide with.
   *
   * Advisory, not the gate: the breadcrumb is written once a run is open, so two
   * servers starting within the same launch window can both read "no foreign
   * run". The AUTHORITATIVE admission is the workspace's ownership claim, taken
   * atomically by {@link FileStatePort.record} — this read is the friendly
   * early refusal that names the other server before any browser is launched.
   */
  async foreignRun(): Promise<ForeignRun | null> {
    const state = await readState(this.#workspace.stateJson);
    if (state?.status !== 'running') return null; // absent, malformed, or already terminal
    if (state.pid === this.#pid) return null; // our own breadcrumb — the in-process gate rules
    if (!ownerAlive(state.pid, state.identity).alive) return null; // crashed server, stale file
    return { pid: state.pid, sessionId: state.sessionId, sessionDir: state.sessionDir };
  }

  /** Read the foreign run's on-disk findings; `null` unless `sessionId` is that run. */
  async foreignFindings(sessionId: string): Promise<unknown | null> {
    const foreign = await this.foreignRun();
    if (foreign === null || foreign.sessionId !== sessionId) return null;
    try {
      return JSON.parse(await readFile(join(foreign.sessionDir, 'findings.json'), 'utf8'));
    } catch {
      return null; // not flushed yet, or unreadable — the caller falls back to its own error
    }
  }
}

/**
 * Flip the recorded status (`ended`/`stopped`) in place, if a state file exists.
 *
 * Pass `onlySessionId` to scope the flip to ONE run: the ending teardown does.
 * A teardown can settle after the next run already recorded itself (a takeover,
 * a successor start racing the close) — without the id, that late write would
 * mark a LIVE successor `ended` and `ui-debugger-mcp stop` would refuse it.
 * When the file names a different session, nothing is written at all.
 *
 * `stopped` is terminal and wins: a CLI `stop` records it *before* signaling, then
 * the server's SIGTERM path calls `clear(sessionId)` →
 * `markStatus(..., 'ended', sessionId)`. Preserve
 * the existing `stopped` here so `status` keeps reporting the true terminal state
 * after a stop.
 *
 * This read-modify-write is not a cross-process lock — the ordering is what makes
 * it deterministic. The server cannot begin its teardown until the signal lands,
 * and the signal is only sent once `stopped` is durably on disk (see
 * `runStop`), so the server's read always observes `stopped` and keeps it.
 *
 * In-process callers (the server's own `clear`) must not rely on that ordering:
 * a `clear` racing a successor's `record` is exactly the interleaving the port's
 * write queue closes, which is why `FileStatePort` routes this through its queue.
 *
 * `ownedBy` is an OPTIONAL trailing predicate: it receives the recorded run and
 * decides whether THIS caller may flip it. It exists so ownership is enforced
 * where the write happens — a caller that does not own the run must not end it,
 * however well it knows its session id. Omitting it keeps the historical
 * behaviour (the CLI's `stop` marks a run it does not own, on purpose).
 */
export async function markStatus(
  path: string,
  status: 'ended' | 'stopped',
  now: Date = new Date(),
  onlySessionId?: string,
  io: StateIo = fsStateIo,
  ownedBy?: (prior: StateFile) => boolean,
): Promise<void> {
  const prior = await io.read(path);
  if (!prior) return;
  // Not our run anymore (a successor owns the breadcrumb) — never write over it.
  if (onlySessionId !== undefined && prior.sessionId !== onlySessionId) return;
  // Not ours to end — never write over it.
  if (ownedBy !== undefined && !ownedBy(prior)) return;
  const nextStatus = prior.status === 'stopped' ? 'stopped' : status;
  await io.write(path, { ...prior, status: nextStatus, updatedAt: now.toISOString() });
}

/**
 * Roll a `stopped` mark back to `running` — the CLI's undo when the signal that
 * was supposed to follow it never landed (e.g. `EPERM`).
 *
 * `stop` records `stopped` first so the server's `markStatus('ended')` can't win
 * the race; when nothing is actually tearing down, that record would be a lie.
 * Only a `stopped` still on disk is rolled back: any other status was written by
 * someone else and is left alone.
 */
export async function restoreRunning(path: string, now: Date = new Date()): Promise<void> {
  const prior = await readState(path);
  if (prior?.status !== 'stopped') return;
  await writeState(path, { ...prior, status: 'running', updatedAt: now.toISOString() });
}
