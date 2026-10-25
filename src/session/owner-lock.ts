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
 * re-run against instead of unlinking.
 *
 * The mutex can die with a crashed reclaimer, and ITS recovery is just as racy
 * done blindly: two contenders can both read the same dead mutex, and the
 * slower one's removal then lands on the winner's FRESH mutex — two processes
 * in the critical section at once. Recovery therefore never blind-unlinks: the
 * mutex is moved aside with an atomic `rename(2)` to a private quarantine name
 * and the moved bytes are verified there, where nothing can substitute them —
 * equality with the judged-dead bytes proves this process removed exactly what
 * it judged; anything else is a rival's live mutex, restored untouched. And
 * because a recovery can still dispossess a holder after its check (a restored
 * mutex can lose a publish race into the freed slot), the holder re-verifies
 * the mutex names it immediately before the destructive unlink: exclusion
 * holds THROUGH the claim read/unlink, not just up to the read. The final
 * publish stays an atomic `link(2)`, so a contender that slips past every
 * check still cannot win a slot someone else filled: its `link` hits `EEXIST`,
 * it re-reads a LIVE holder, and refuses. The mutex is reclaimed only from a
 * provably dead holder — a reclaimer that crashed mid-reclaim — so a crashed
 * reclaimer cannot wedge the workspace either.
 */

import { link, readFile, rename, unlink, writeFile } from 'node:fs/promises';
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
  /**
   * Runs once the reclaim mutex has been judged dead (a reclaimer that
   * crashed mid-reclaim), just before it is recovered. Lets a regression
   * test put a rival's fresh mutex in the dead one's place in that window —
   * the interleaving in which a late, blind recovery destroyed the rival's
   * live mutex and put two contenders into the critical section at once.
   */
  afterMutexJudgedDead?: () => Promise<void> | void;
  /**
   * Runs under the reclaim mutex, after the claim has been re-verified
   * stale and immediately before it is unlinked. Lets a regression test
   * dispossess the holder at the last instant — proving the holder refuses
   * the destructive unlink once the mutex no longer names it.
   */
  beforeClaimUnlink?: () => Promise<void> | void;
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
 * mid-reclaim) is recovered — verified, never blind-unlinked, see
 * {@link recoverStaleMutex} — so a crashed reclaimer cannot wedge the
 * workspace either; a malformed non-empty one cannot name a live holder and is
 * recovered the same way. Three rounds: a recovery that finds the slot already
 * emptied (`gone`) or already won (`clean`) still owes its publish a round.
 */
async function takeReclaimMutex(
  reclaimPath: string,
  owner: OwnerLock,
  serialized: string,
  hooks: AcquireHooks,
): Promise<boolean> {
  for (let take = 0; take < 3; take += 1) {
    if (await publishAtomically(reclaimPath, serialized, `r${take}`)) return true;
    const observed = await readRaw(reclaimPath);
    if (observed === null) continue; // vanished between the failed link and the read: retry
    // Empty is the visible window of an in-progress publish — never reclaim
    // it, or two processes could both believe they hold the mutex.
    if (observed.trim() === '') {
      throw new OwnerLockBusyError(
        'owner lock reclaim mutex is empty; refusing to reclaim an in-progress reclamation',
      );
    }
    const holder = parseHolder(observed);
    if (holder !== null) {
      if (sameOwner(holder, owner)) return true; // re-entrant
      if (ownerAlive(holder.pid, holder.identity).alive) return false;
    }
    // Dead reclaimer — or malformed bytes, which cannot name a live holder.
    await hooks.afterMutexJudgedDead?.();
    const recovered = await recoverStaleMutex(reclaimPath, observed);
    if (recovered === 'busy') return false; // a rival's live mutex — not ours to remove
  }
  return false;
}

/** What recovering a dead mutex found at its path. */
type MutexRecovery =
  /** Exactly the judged-dead mutex was removed — the caller may publish its own. */
  | 'clean'
  /** A rival's fresh mutex was in the way; it was restored and the caller refuses. */
  | 'busy'
  /** The path was already empty — another recovery got there first; retry. */
  | 'gone';

/** Counts a process's recoveries, keeping quarantine names unique within one. */
let recoverySeq = 0;

/**
 * Remove a provably dead mutex WITHOUT a blind unlink.
 *
 * Judging the mutex dead and removing it are two steps, so a removal that
 * executes late deletes whatever replaced the dead mutex in between — a
 * rival's FRESH mutex — and puts two contenders into the critical section at
 * once. Instead the file is moved aside atomically (`rename(2)`) to a
 * quarantine name only this process knows, and the moved bytes are verified
 * there, where nothing can substitute them: equality with the judged-dead
 * bytes proves THIS process removed exactly the mutex it judged.
 */
async function recoverStaleMutex(reclaimPath: string, judgedDead: string): Promise<MutexRecovery> {
  recoverySeq += 1;
  const quarantine = `${reclaimPath}.recovered-${process.pid}-${recoverySeq}`;
  try {
    await rename(reclaimPath, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone';
    throw error;
  }
  const moved = await readRaw(quarantine);
  if (moved !== null && moved === judgedDead) {
    await unlink(quarantine).catch(() => undefined);
    return 'clean';
  }
  // A rival republished between the judgment and the move — its live mutex is
  // what we are holding. Put it back exactly as it was. `link` fails with
  // EEXIST when another contender published into the freed slot meanwhile;
  // the stranded copy is dropped, and that rival stays safe because no holder
  // unlinks the claim without a fencing check on the mutex (see `reclaimStale`).
  await link(quarantine, reclaimPath).catch(() => undefined);
  await unlink(quarantine).catch(() => undefined);
  return 'busy';
}

/** Does the reclaim mutex still name THIS owner? `false` when gone or foreign. */
async function mutexIsOurs(reclaimPath: string, owner: OwnerLock): Promise<boolean> {
  const holder = await readHolder(reclaimPath);
  return holder !== null && sameOwner(holder, owner);
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
 * The mutex itself is re-checked (fenced) immediately before the unlink: a
 * dispossessed holder must not remove the claim it no longer guards.
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
  if (!(await takeReclaimMutex(reclaimPath, owner, serialized, hooks))) return;
  try {
    const current = await readRaw(lockPath);
    if (current !== staleRaw) return; // acquired (or changed) since it was judged stale
    await hooks.beforeClaimUnlink?.();
    // Exclusion must hold THROUGH the destructive step, not just up to the
    // read: a rival's recovery can dispossess this holder after its check (a
    // restored mutex losing the publish race into the freed slot). Re-verify
    // the mutex names us immediately before the unlink — a holder whose mutex
    // is gone or foreign refuses to touch the claim.
    if (!(await mutexIsOurs(reclaimPath, owner))) return;
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
