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
 * Reclamation is destructive, so the destructive step carries its own
 * authorization instead of trusting a check that precedes it: the judged claim
 * is moved aside with an atomic `rename(2)` to a private quarantine name and
 * the moved bytes are verified there, where nothing can substitute them.
 * Equality with the judged-stale bytes proves this process removed exactly
 * what it judged; anything else is a rival's fresh claim — restored untouched,
 * and this contender refuses. A check cannot do this job: the previous design
 * fenced the unlink with a second atomic claim (`owner.lock.reclaim`, a
 * reclaim mutex) plus crash recovery for that mutex, and the recovery could
 * still dispossess a live holder AFTER its fence — a check never covers the
 * act that follows it — letting a third contender reclaim and publish before
 * the dispossessed unlink landed, stealing a live claim. Removing the mutex
 * removes the recovery that could revoke a live holder; cross-process
 * exclusion now rests on two atomic primitives alone. `link(2)` publishes: a
 * contender that slips past every judgment still cannot win a slot someone
 * else filled — its `link` hits `EEXIST`, it re-reads a live holder, and
 * refuses. The verified rename removes: it can only ever remove bytes that
 * were genuinely judged stale. A reclaimer that crashes after the rename
 * leaves an empty claim slot (the next contender simply publishes) and a
 * private quarantine file nobody reads.
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

/**
 * Test seam for {@link acquireOwnerLock} — production callers run none of it.
 */
export interface AcquireHooks {
  /**
   * Runs once the existing claim has been judged stale, immediately before it
   * is reclaimed. Lets a regression test park one contender between its
   * judgment and its destructive act while a rival completes a full acquire —
   * the post-check interleaving in which an act authorized by an earlier
   * observation would remove a rival's live claim.
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

/** Counts a process's reclaims, keeping quarantine names unique within one. */
let reclaimSeq = 0;

/**
 * Remove `judgedRaw` from `path` — or remove nothing.
 *
 * The move and the judgment travel together: `rename(2)` is atomic, so this
 * process either moves WHATEVER is at `path` — and then verifies, at the
 * private quarantine name where no rival can substitute bytes, that it moved
 * exactly what it judged stale — or moves nothing (`ENOENT`: a rival
 * reclaimer won the race). A mismatch means a rival's claim was legitimately
 * published after this contender's judgment: its live claim is what we are
 * holding, so it is restored byte-for-byte and the contender refuses. `true`
 * means the judged claim was removed; `false` means the caller must re-run
 * its publish against whatever is there now.
 */
async function removeExactly(path: string, judgedRaw: string): Promise<boolean> {
  reclaimSeq += 1;
  const quarantine = `${path}.reclaiming-${process.pid}-${reclaimSeq}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  const moved = await readRaw(quarantine);
  if (moved === judgedRaw) {
    await unlink(quarantine).catch(() => undefined);
    return true;
  }
  // `link` back fails with EEXIST when yet another contender published into
  // the freed slot meanwhile; the stranded copy is then dropped — the slot
  // demonstrably holds a live claim, and losing the stranded owner's copy is
  // the one case this file-level protocol cannot undo (it needs a fourth
  // contender publishing within this restore window).
  await link(quarantine, path).catch(() => undefined);
  await unlink(quarantine).catch(() => undefined);
  return false;
}

/**
 * Acquire the exclusive workspace claim.
 *
 * The publish is an atomic `link(2)`, so only one process can win. An existing
 * claim held by this same process is re-entrant. A live foreign claim is
 * refused. A dead, recycled or malformed claim is reclaimed once — the removal
 * itself carries the authorization (`removeExactly`) — and the publish retried.
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

    // Dead, PID-recycled or malformed — reclaim it. The removal can only ever
    // remove bytes that were genuinely judged stale, so no rival — however it
    // raced past this judgment — can have its fresh claim removed here.
    await hooks.afterStaleObservation?.();
    await removeExactly(lockPath, observed);
  }

  const holder = await readHolder(lockPath);
  if (holder !== null && ownerAlive(holder.pid, holder.identity).alive) {
    return { acquired: false, holder };
  }
  throw new OwnerLockBusyError('owner lock changed while it was being reclaimed');
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
