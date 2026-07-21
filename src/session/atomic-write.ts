/**
 * Atomic file replace — how every cross-process file in the workspace is written.
 *
 * `state.json` and `findings.json` are read by processes other than the writer:
 * `ui-debugger-mcp status` / `stop` run out-of-band, and a second server checks
 * the breadcrumb through {@link FileStatePort.foreignRun}. A plain `writeFile`
 * truncates first, so a reader that lands mid-write sees an empty or half-written
 * file — and both readers treat that as "no run" / "corrupt findings". Writing a
 * temp file and `rename(2)`-ing it into place is atomic on the same filesystem:
 * a reader sees either the old bytes or the new ones, never a torn mix.
 *
 * The temp name carries the writer's pid plus a per-process counter, because the
 * same target can have several writers at once (the server and a CLI invocation,
 * or two {@link FindingsStore} instances on one session dir). A shared `.tmp`
 * suffix would let one writer rename another's half-written bytes into place.
 */

import { rename, rm, writeFile } from 'node:fs/promises';

/** Per-process counter — keeps concurrent writes inside one process distinct. */
let seq = 0;

/**
 * Replace `path` with `contents` atomically (temp file + rename).
 *
 * The parent directory must already exist — callers own that (they create more
 * than just this file's dir). A failed write leaves no temp file behind and
 * rethrows: the original file is untouched, so the failure is never silent.
 */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  seq += 1;
  const tmp = `${path}.tmp-${process.pid}-${seq}`;
  try {
    await writeFile(tmp, contents, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}
