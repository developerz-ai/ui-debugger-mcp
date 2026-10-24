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
import { writeFileAtomic } from './atomic-write.js';
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
  /** Record the run as `running`. Throws when the breadcrumb cannot be written. */
  record(run: RunState): Promise<void>;
  /**
   * Mark `ended` — ONLY the run whose session id this is. If the breadcrumb names
   * a different session (a successor recorded itself while this teardown was in
   * flight), leave it untouched: ending a live successor's breadcrumb makes
   * `ui-debugger-mcp stop` refuse the run that is actually going.
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
    await this.#serialize(() =>
      this.#io.write(this.#workspace.stateJson, {
        pid: this.#pid,
        sessionId: run.sessionId,
        target: run.target,
        goal: run.goal,
        status: 'running',
        startedAt: iso,
        updatedAt: iso,
        sessionDir: sessionPaths(this.#workspace, run.sessionId).root,
        identity: captureIdentity(this.#pid),
      }),
    );
  }

  async clear(sessionId: string): Promise<void> {
    // Best-effort stays: the run is already down, and a swallowed clear only
    // leaves a breadcrumb naming a pid whose liveness the CLI checks anyway.
    await this.#serialize(() =>
      markStatus(this.#workspace.stateJson, 'ended', this.#now(), sessionId, this.#io),
    ).catch(() => undefined);
  }

  /**
   * Who else is debugging this workspace? Only a breadcrumb that is `running`,
   * written by a pid that is *not* ours, and whose owner is provably still alive
   * ({@link ownerAlive} — a recycled or dead pid does not count) reports a
   * foreign run. Everything else is `null`: nobody to collide with.
   *
   * Advisory, not a lock: the breadcrumb is written once a run is open, so two
   * servers starting within the same launch window can still both get through.
   * It closes the common case (a second MCP client on the same project) without
   * a lock file, and Chrome's own profile lock still backstops managed web runs.
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
 */
export async function markStatus(
  path: string,
  status: 'ended' | 'stopped',
  now: Date = new Date(),
  onlySessionId?: string,
  io: StateIo = fsStateIo,
): Promise<void> {
  const prior = await io.read(path);
  if (!prior) return;
  // Not our run anymore (a successor owns the breadcrumb) — never write over it.
  if (onlySessionId !== undefined && prior.sessionId !== onlySessionId) return;
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
