/**
 * Session retention — keep the workspace from growing without bound.
 *
 * Every run drops a `sessions/<id>/` directory holding `story.md`,
 * `findings.json`, the full `logs/` trail, every screenshot and (when ffmpeg is
 * around) a `replay.mp4`. A single dogfood afternoon is hundreds of megabytes,
 * and nothing ever removed them: the workspace only ever grew.
 *
 * So a new run prunes the old ones: the {@link SESSION_RETENTION} newest survive,
 * the rest are removed. "Newest" is the id's own byte order — {@link
 * generateSessionId} emits fixed-width `YYYY-MM-DD_HH-MM-SS-NNNN`, so sorting the
 * directory names IS sorting by time, with no `stat` per entry and no race with a
 * run that is still writing.
 *
 * Fails LOUD ({@link WorkspaceError}): a workspace we cannot manage is a real
 * problem, and silently accumulating gigabytes is exactly the failure this exists
 * to end. The message names the directories so the fix is one `rm` away.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { WorkspaceError } from '../errors.js';
import type { WorkspacePaths } from './workspace.js';

/** How many session directories survive a prune — the newest N by id. */
export const SESSION_RETENTION = 5;

/** Knobs for {@link pruneSessions}; both have sensible defaults. */
export interface PruneOptions {
  /** How many to keep (newest first). Defaults to {@link SESSION_RETENTION}. */
  keep?: number;
  /**
   * A session id that must survive regardless of where it sorts — the run being
   * started. Its id is normally the newest anyway; this holds even if the clock
   * moved backwards (NTP correction, DST) between runs.
   */
  protect?: string;
}

/**
 * Remove all but the newest `keep` session directories under `workspace.sessions`.
 *
 * A missing `sessions/` dir is not an error (nothing has run here yet) — it prunes
 * nothing. Loose files in `sessions/` are left alone; only directories are runs.
 *
 * @returns the ids that were removed, oldest first.
 * @throws {WorkspaceError} if the directory cannot be read, or any removal fails.
 */
export async function pruneSessions(
  workspace: WorkspacePaths,
  { keep = SESSION_RETENTION, protect }: PruneOptions = {},
): Promise<string[]> {
  let ids: string[];
  try {
    const entries = await readdir(workspace.sessions, { withFileTypes: true });
    ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new WorkspaceError(
      `Failed to list session directories in '${workspace.sessions}': ${message(err)}`,
    );
  }

  // Descending byte order == newest first (ids are fixed-width and time-ordered).
  const newestFirst = ids.sort().reverse();
  const doomed = newestFirst.slice(Math.max(0, keep)).filter((id) => id !== protect);
  if (doomed.length === 0) return [];

  const failures: string[] = [];
  for (const id of doomed) {
    try {
      await rm(join(workspace.sessions, id), { recursive: true, force: true });
    } catch (err) {
      failures.push(`${id} (${message(err)})`);
    }
  }
  if (failures.length > 0) {
    throw new WorkspaceError(
      `Failed to prune old session directories under '${workspace.sessions}': ` +
        `${failures.join('; ')}. Remove them by hand, or point 'workspace' somewhere writable.`,
    );
  }
  // Oldest first reads naturally in a log line ("pruned A, B, C").
  return doomed.reverse();
}

/** Best-effort message off an unknown thrown value. */
function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
