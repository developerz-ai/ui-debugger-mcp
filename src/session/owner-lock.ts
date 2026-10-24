/**
 * Exclusive workspace ownership claim.
 *
 * The `state.json` breadcrumb is advisory: two servers can both read it before
 * either writes. This lock closes that window by publishing the complete claim
 * and linking it into place atomically, so only one process can win.
 *
 * The claim identifies its holder by PID and process identity, not session id.
 * Session ids are only unique within one process and two processes can mint
 * the same id in the same second. A dead or PID-recycled holder is reclaimed
 * so a crashed server cannot wedge the workspace.
 *
 * Reclamation is serialized against acquisition with a second atomic claim —
 * `<lockPath>.reclaim`. Judging a claim stale and unlinking it are two steps,
 * so an unserialized reclaimer can read the same dead holder a rival read,
 * unlink only after the rival has already published its fresh claim, and steal
 * it: two processes both believing they own the workspace. The reclaim mutex
 * makes observe → re-verify → unlink one serialized section, and the
 * re-verification under the mutex — byte-for-byte against what was judged
 * stale — turns a rival's fresh claim into a visible change the contender must
 * re-run against instead of unlinking. The final publish stays an atomic
 * `link(2)`, so even contenders that both slip past the mutex (possible only
 * when a reclaimer crashed while holding it and two rivals reclaim the dead
 * mutex at once) cannot both win: the loser's `link` hits `EEXIST`, re-reads a
 * LIVE holder, and refuses. The mutex itself is reclaimed only from a provably
 * dead holder — a reclaimer that crashed mid-reclaim — so a crashed reclaimer
 * cannot wedge the workspace either.
 */

import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { SessionBusyError } from '../errors.js';
import { ownerAlive, ProcessIdentitySchema } from './process-identity.js';
import type { WorkspacePaths } from './workspace.js';

/** The owner recorded in `<workspace>/owner.lock`. */
export const OwnerLockSchema = z.object({
  /** Server process id. */
  pid: z.number().int().positive(),
  /** Process fingerprint that distinguishes this owner from a recycled PID. */
  identity: ProcessIdentitySchema,
  /** Session that acquired the claim. */
  sessionId: z.string(),
  /** ISO timestamp the claim was acquired. */
  acquiredAt: z.string(),
});

export type OwnerLock = z.infer<typeof OwnerLockSchema>;

/** A live owner holds the claim (or it is visibly still being published). */
export class OwnerLockBusyError extends SessionBusyError {}

/** `<workspace.root>/owner.lock` */
export function ownerLockPath(workspace: WorkspacePaths): string {
  return join(workspace.root, 'owner.lock');
}

/** `<lockPath>.reclaim` — serializes stale-claim reclamation across processes. */
function reclaimLockPath(lockPath: string): string {
  return `${lockPath}.reclaim`;
}

/**
 * Test seam for {@link acquireOwnerLock} — production callers run none of it.
 */
export interface AcquireHooks {
  /**
   * Runs once the existing claim has been judged stale, before it is
   * reclaimed. Lets a regression test park one contender between its
   * observation and its reclamation while a rival completes a full acquire —
   * the interleaving in which an unserialized reclaimer's unlink stole the
   * rival's fresh claim.
   */
  afterStaleObservation?: () => Promise<void> | void;
}

/** Whether two owners identify the same live process. */
function sameOwner(left: OwnerLock, right: OwnerLock): boolean {
  return left.pid === right.pid && left.identity.startTicks === right.identity.startTicks;
}

/** Read the file's bytes; `null` when absent or unreadable. */
async function readRaw(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** Parse a claim file's bytes; `null` when malformed. */
function parseHolder(raw: string): OwnerLock | null {
  try {
    const parsed = OwnerLockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Read and validate an existing claim. `null` means absent or malformed. */
async function readHolder(path: string): Promise<OwnerLock | null> {
  const raw = await readRaw(path);
  return raw === null ? null : parseHolder(raw);
}

/**
 * Publish `serialized` at `path`: write the COMPLETE content to a private
 * staging name, then link it into place. `link(2)` is atomic and fails when
 * the destination exists, so a rival never observes a reserved-but-empty
 * claim and cannot mistake it for a malformed one. `false` means the
 * destination exists.
 */
async function publishAtomically(path: string, serialized: string, tag: string): Promise<boolean> {
  const staging = `${path}.candidate-${process.pid}-${tag}`;
  try {
    await writeFile(staging, serialized, { encoding: 'utf8', flag: 'wx' });
    await link(staging, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  } finally {
    await unlink(staging).catch(() => undefined);
  }
}

/**
 * Take the reclaim mutex — atomic, like the claim itself.
 *
 * `false` means another LIVE process is mid-reclamation: the caller must not
 * touch the claim. A mutex naming a dead holder (a reclaimer that crashed
 * mid-reclaim) is reclaimed, so a crashed reclaimer cannot wedge the workspace
 * either; a malformed non-empty one cannot name a live holder and is removed.
 */
async function takeReclaimMutex(
  reclaimPath: string,
  owner: OwnerLock,
  serialized: string,
): Promise<boolean> {
  for (let take = 0; take < 2; take += 1) {
    if (await publishAtomically(reclaimPath, serialized, `r${take}`)) return true;
    const observed = await readRaw(reclaimPath);
    if (observed === null) continue; // vanished between the failed link and the read: retry
    const holder = parseHolder(observed);
    if (holder === null) {
      // Empty is the visible window of an in-progress publish — never reclaim
      // it, or two processes could both believe they hold the mutex.
      if (observed.trim() === '') {
        throw new OwnerLockBusyError(
          'owner lock reclaim mutex is empty; refusing to reclaim an in-progress reclamation',
        );
      }
      await unlink(reclaimPath).catch(() => undefined);
      continue;
    }
    if (sameOwner(holder, owner)) return true; // re-entrant
    if (ownerAlive(holder.pid, holder.identity).alive) return false;
    await unlink(reclaimPath).catch(() => undefined); // the reclaimer crashed mid-reclaim
  }
  return false;
}

/**
 * Reclaim a stale claim, serialized with every other contender's acquisition.
 *
 * The mutex guards the unlink; the re-verification under it closes the race:
 * this contender judged the claim stale from `staleRaw`, but a rival may have
 * acquired since. Under the mutex the claim is read back and unlinked ONLY
 * when it still holds exactly those stale bytes — anything else means the
 * workspace changed hands while this contender was deciding, so the claim is
 * left alone and the caller re-runs its publish against what is there now.
 */
async function reclaimStale(
  lockPath: string,
  owner: OwnerLock,
  serialized: string,
  staleRaw: string,
  hooks: AcquireHooks,
): Promise<void> {
  await hooks.afterStaleObservation?.();
  const reclaimPath = reclaimLockPath(lockPath);
  if (!(await takeReclaimMutex(reclaimPath, owner, serialized))) return;
  try {
    const current = await readRaw(lockPath);
    if (current !== staleRaw) return; // acquired (or changed) since it was judged stale
    await unlink(lockPath).catch(() => undefined);
  } finally {
    await releaseOwnerLock(reclaimPath, owner);
  }
}

/**
 * Acquire the exclusive workspace claim.
 *
 * The publish is an atomic `link(2)`, so only one process can win. An existing
 * claim held by this same process is re-entrant. A live foreign claim is
 * refused. A dead, recycled or malformed claim is reclaimed once — serialized
 * with every other contender's acquisition — and the publish retried.
 */
export async function acquireOwnerLock(
  lockPath: string,
  owner: OwnerLock,
  hooks: AcquireHooks = {},
): Promise<{ acquired: true; created: boolean } | { acquired: false; holder: OwnerLock }> {
  const serialized = `${JSON.stringify(owner, null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await publishAtomically(lockPath, serialized, `a${attempt}`)) {
      return { acquired: true, created: true };
    }

    const observed = await readRaw(lockPath);
    if (observed === null) continue; // vanished between the failed link and the read: retry

    const holder = parseHolder(observed);
    if (holder !== null) {
      if (sameOwner(holder, owner)) return { acquired: true, created: false };
      if (ownerAlive(holder.pid, holder.identity).alive) {
        return { acquired: false, holder };
      }
    } else if (observed.trim() === '') {
      // An empty claim is the visible window of a create-then-fill publish.
      // Never reclaim it: doing so lets two processes both believe they own
      // the workspace.
      throw new OwnerLockBusyError('owner lock is empty; refusing to reclaim an in-progress claim');
    }

    // Dead, PID-recycled or malformed — reclaim it, serialized with every
    // other contender's acquisition so the unlink can only ever remove the
    // exact bytes this contender judged stale.
    await reclaimStale(lockPath, owner, serialized, observed, hooks);
  }

  const holder = await readHolder(lockPath);
  if (holder !== null && ownerAlive(holder.pid, holder.identity).alive) {
    return { acquired: false, holder };
  }
  const reclaimer = await readHolder(reclaimLockPath(lockPath));
  throw new OwnerLockBusyError(
    reclaimer === null
      ? 'owner lock changed while it was being reclaimed'
      : `owner lock is stale; another process (pid ${reclaimer.pid}) is reclaiming it`,
  );
}

/**
 * Release the claim only when it still names this owner.
 *
 * Returns `false` when the claim belongs to another process or is already
 * gone; another owner's claim is never unlinked.
 */
export async function releaseOwnerLock(lockPath: string, owner: OwnerLock): Promise<boolean> {
  const holder = await readHolder(lockPath);
  if (holder === null || !sameOwner(holder, owner)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
