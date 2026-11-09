/**
 * Live-workspace pointer — how `status` / `stop` find a run after the config moved.
 *
 * The server resolves its workspace from the config at boot; the CLI runs later,
 * in another process, and re-derives it from the config AS IT IS NOW. Edit the
 * `workspace` key while a run is live and the two disagree: `status` reads an
 * empty workspace and `stop` cannot reach the server. `state.json` cannot fix
 * that — the CLI would need the root to find it.
 *
 * So the server drops this pointer at a FIXED, config-independent location — the
 * default workspace root for this cwd ({@link workspacePaths} with no base) — naming
 * the workspace root it actually owns.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from './atomic-write.js';
import { workspacePaths } from './workspace.js';

const LivePointerSchema = z.object({ root: z.string().min(1) });

/** Where the pointer lives for `cwd` — derived from the cwd alone, never from config. */
export function livePointerPath(cwd: string): string {
  return join(workspacePaths(cwd).root, 'live-workspace.json');
}

/** Record `root` as the workspace the live server owns. Throws on a failed write (fail loud). */
export async function writeLivePointer(cwd: string, root: string): Promise<void> {
  const path = livePointerPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify({ root }, null, 2)}\n`);
}

/** The recorded live workspace root, or `null` when absent or malformed (never throws). */
export async function readLivePointer(cwd: string): Promise<string | null> {
  try {
    const raw = await readFile(livePointerPath(cwd), 'utf8');
    const parsed = LivePointerSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.root : null;
  } catch {
    return null;
  }
}
