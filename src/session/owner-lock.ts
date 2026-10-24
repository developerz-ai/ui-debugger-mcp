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

/** Whether two owners identify the same live process. */
function sameOwner(left: OwnerLock, right: OwnerLock): boolean {
  return left.pid === right.pid && left.identity.startTicks === right.identity.startTicks;
}

/** Read and validate an existing claim. `null` means absent or malformed. */
async function readHolder(lockPath: string): Promise<OwnerLock | null> {
  try {
    const raw = await readFile(lockPath, 'utf8');
    const parsed = OwnerLockSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Acquire the exclusive workspace claim.
 *
 * The link is atomic, so only one process can publish the claim. An existing
 * claim held by this same process is re-entrant. A live foreign claim is
 * refused. A dead or recycled claim is reclaimed once and the publish retried.
 */
export async function acquireOwnerLock(
  lockPath: string,
  owner: OwnerLock,
): Promise<{ acquired: true; created: boolean } | { acquired: false; holder: OwnerLock }> {
  const serialized = `${JSON.stringify(owner, null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Publish the COMPLETE claim first, then link it into place. `link(2)` is
      // atomic and fails when the destination exists, so another acquirer never
      // observes a reserved-but-empty claim and cannot mistake it for a
      // malformed one, reclaim it, and leave both processes believing they own
      // the workspace.
      const staging = `${lockPath}.candidate-${process.pid}-${attempt}`;
      try {
        await writeFile(staging, serialized, { encoding: 'utf8', flag: 'wx' });
        await link(staging, lockPath);
      } finally {
        await unlink(staging).catch(() => undefined);
      }
      return { acquired: true, created: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }

    const holder = await readHolder(lockPath);
    if (holder === null) {
      // A malformed claim cannot identify a live owner — UNLESS it is empty,
      // which is the visible window of a create-then-fill publish. Never
      // reclaim an empty claim: doing so lets two processes both believe they
      // own the workspace.
      let empty = false;
      try {
        empty = (await readFile(lockPath, 'utf8')).trim() === '';
      } catch {
        empty = false;
      }
      if (empty) {
        throw new OwnerLockBusyError(
          'owner lock is empty; refusing to reclaim an in-progress claim',
        );
      }
      // A malformed claim cannot identify a live owner. Remove it and retry once.
      await unlink(lockPath).catch(() => undefined);
      continue;
    }
    if (sameOwner(holder, owner)) return { acquired: true, created: false };
    if (ownerAlive(holder.pid, holder.identity).alive) {
      return { acquired: false, holder };
    }
    await unlink(lockPath).catch(() => undefined);
  }

  const holder = await readHolder(lockPath);
  if (holder !== null && ownerAlive(holder.pid, holder.identity).alive) {
    return { acquired: false, holder };
  }
  throw new Error('owner lock changed while it was being reclaimed');
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
