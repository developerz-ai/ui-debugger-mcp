/**
 * Detect that `.ui-debugger-mcp.json` changed after the server read it.
 *
 * Config is resolved ONCE at boot (`main.ts`): it decides the workspace layout,
 * the provider, the per-role models and the self-look probe, all of which are
 * wired into long-lived objects. Re-reading it mid-process would leave those
 * half-updated, so the server keeps its boot-time view — correctly.
 *
 * What was NOT correct is doing that silently. Observed end-to-end: a run failed
 * on a bad model id, the caller found the typo, fixed the file, started a new run
 * — and got the identical error, because the server was still on the old config.
 * From the caller's side the fix simply had no effect, with nothing anywhere
 * saying why. It then retried the same thing again.
 *
 * So: fingerprint the file at boot, compare before each run, and if it moved,
 * fail loud with the one instruction that actually resolves it. A stale config is
 * a bad assumption, and the house rule is to crash on those rather than run on.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILENAME } from './load.js';

/**
 * Content fingerprint of the project's config file — `null` when it is absent or
 * unreadable (a project running on defaults has nothing to drift from).
 *
 * Contents, not mtime: editors and formatters rewrite files without changing
 * anything that matters, and a spurious "restart me" is its own kind of noise.
 *
 * `node:crypto`, not `Bun.hash`: the package ships as `bin: dist/main.js` behind
 * `#!/usr/bin/env node`, so the published server runs on Node, where `Bun` is
 * undefined. Hashing with a Bun global threw a `ReferenceError` straight into the
 * catch below — the fingerprint was permanently `null` and drift detection was
 * dead in every installed copy, while working fine under `bun run dev`.
 */
export function configFingerprint(cwd: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(join(cwd, CONFIG_FILENAME), 'utf8');
  } catch (err) {
    // Absent config = nothing to drift from. Anything else (permissions, I/O) is a
    // bad assumption, and the house rule is to crash on those rather than run on.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw err;
  }
  return createHash('sha256').update(raw).digest('hex');
}

/**
 * A comparison against the fingerprint taken at boot. Returns whether the file
 * has changed since — including a config that was created or deleted while the
 * server was up, both of which change what a run would do.
 */
export function makeConfigWatch(cwd: string): () => boolean {
  const atBoot = configFingerprint(cwd);
  return () => configFingerprint(cwd) !== atBoot;
}
