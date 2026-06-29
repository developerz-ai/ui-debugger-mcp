/**
 * Cross-process run state — the `state.json` the CLI reads.
 *
 * The live session lives in the server process's memory ({@link SessionManager}).
 * A separate `ui-debugger-mcp status` / `stop` invocation can't see that memory,
 * so the running server drops a small breadcrumb to `<workspace>/state.json`:
 * which run is active, the server `pid` (so `stop` can signal it and `status` can
 * tell live from stale), and where the session's `findings.json` lives (so
 * `status` can read the authoritative verdict + counts). Written on start, marked
 * `ended` on a clean end. Best-effort: a failed write never breaks a debug run.
 *
 * The {@link StatePort} seam keeps {@link DebugService} fs-free in unit tests — a
 * no-op port by default, the real {@link FileStatePort} wired at boot.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
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
});

export type StateFile = z.infer<typeof StateFileSchema>;

/** Write `state.json` (creates the parent dir; best-effort overwrite). */
export async function writeState(path: string, state: StateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

/** What a run reports to the state file when it opens. */
export interface RunState {
  sessionId: string;
  target: string;
  goal: string;
}

/** The seam {@link DebugService} writes run lifecycle through (no-op in tests). */
export interface StatePort {
  /** Record a freshly-opened run as `running`. */
  record(run: RunState): Promise<void>;
  /** Mark the active run `ended` (clean end). */
  clear(): Promise<void>;
}

/** Default port: writes nothing (keeps the service fs-free under unit test). */
export const noopStatePort: StatePort = {
  async record() {},
  async clear() {},
};

/** fs-backed {@link StatePort} — drops the breadcrumb to `<workspace>/state.json`. */
export class FileStatePort implements StatePort {
  readonly #workspace: WorkspacePaths;
  readonly #pid: number;
  readonly #now: () => Date;

  constructor(workspace: WorkspacePaths, opts: { pid?: number; now?: () => Date } = {}) {
    this.#workspace = workspace;
    this.#pid = opts.pid ?? process.pid;
    this.#now = opts.now ?? (() => new Date());
  }

  async record(run: RunState): Promise<void> {
    const iso = this.#now().toISOString();
    await writeState(this.#workspace.stateJson, {
      pid: this.#pid,
      sessionId: run.sessionId,
      target: run.target,
      goal: run.goal,
      status: 'running',
      startedAt: iso,
      updatedAt: iso,
      sessionDir: sessionPaths(this.#workspace, run.sessionId).root,
    }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await markStatus(this.#workspace.stateJson, 'ended', this.#now()).catch(() => undefined);
  }
}

/**
 * Flip the recorded status (`ended`/`stopped`) in place, if a state file exists.
 *
 * `stopped` is terminal and wins: a CLI `stop` records it first, then the server's
 * SIGTERM path calls `clear()` → `markStatus(..., 'ended')`. Preserve the existing
 * `stopped` here so `status` keeps reporting the true terminal state after a stop.
 */
export async function markStatus(
  path: string,
  status: 'ended' | 'stopped',
  now: Date = new Date(),
): Promise<void> {
  const prior = await readState(path);
  if (!prior) return;
  const nextStatus = prior.status === 'stopped' ? 'stopped' : status;
  await writeState(path, { ...prior, status: nextStatus, updatedAt: now.toISOString() });
}
