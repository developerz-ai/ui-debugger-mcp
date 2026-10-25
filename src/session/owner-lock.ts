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
 * Cross-process exclusion rests on two atomic primitives alone. `link(2)`
 * publishes: a contender that slips past every judgment still cannot win a
 * slot someone else filled — its `link` hits `EEXIST`, it re-reads a live
 * holder, and refuses. `rename(2)` removes — but a rename moves WHATEVER is
 * at the claim path, so the destructive step carries its own authorization
 * instead of trusting the check that precedes it: the moved bytes are
 * verified at the private quarantine name, and anything other than the
 * judged-stale claim — a rival's fresh claim that raced in — is restored
 * byte for byte with a second rename, and the contender refuses.
 *
 * The residual danger of that rename-aside is the hole it opens in the claim
 * path: a third contender could publish into it while a displaced live claim
 * sits in the quarantine. Two rules close it.
 *
 * 1. The hole and the quarantine are born in the SAME atomic rename, so an
 *    absent claim path always has a visible `.reclaiming-*` sibling — and an
 *    admission is not final while one is visible: the contender re-runs and
 *    the restore supersedes it. What the restore displaces is therefore only
 *    ever an orphan nobody was admitted on, never a live owner.
 * 2. The restore is itself a `rename`, so it lands byte for byte over such an
 *    orphan. A `link` restore would fail `EEXIST` against the orphan and DROP
 *    the live owner's claim — the exact bug this protocol exists to prevent.
 *    The admission check reads in the same order (quarantine first, then the
 *    claim bytes): the restore is one atomic swap of (quarantine visible,
 *    orphan at the path) for (no quarantine, live claim at the path), so that
 *    order can never straddle it.
 *
 * A reclaimer that crashes between the rename and its cleanup leaves the
 * quarantine behind. The next acquirer resolves it before publishing: a
 * quarantine whose claim's owner is still alive is restored to the claim
 * path; a dead or malformed one finishes being removed. No second mutex file
 * is involved: the previous design fenced the unlink with a reclaim mutex
 * (`owner.lock.reclaim`) plus crash recovery for that mutex, and the recovery
 * could still dispossess a live holder AFTER its fence — a check never covers
 * the act that follows it.
 */

import { link, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
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
  /**
   * Runs once the judged claim has been moved to its quarantine name and
   * before its bytes are verified — the moment the claim path is an open
   * hole (absent path, quarantine visible). Lets a regression test run a
   * rival acquire — or seed an orphan claim — into exactly the window in
   * which a displaced live claim could otherwise be lost.
   */
  afterQuarantineRename?: () => Promise<void> | void;
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

/** Swallow only "already gone" — a rival resolver won the race. Anything else is loud. */
function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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

/** Every quarantine sibling of the claim (`<claim path>.reclaiming-*`). */
async function quarantines(lockPath: string): Promise<string[]> {
  const dir = dirname(lockPath);
  const prefix = `${basename(lockPath)}.reclaiming-`;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return names.filter((name) => name.startsWith(prefix)).map((name) => join(dir, name));
}

/**
 * Resolve orphaned reclaim quarantines — the recovery of a reclaimer that
 * died between its rename and its cleanup.
 *
 * A quarantine holding a LIVE owner's claim is that owner's claim, displaced
 * mid-reclaim: restore it to the claim path. A dead or malformed one is a
 * removal that was interrupted: finish it. Either way the slot ends up in a
 * state the ordinary acquire loop understands, and no claim is ever lost —
 * resolution races another resolver only on ENOENT, which is benign.
 */
async function resolveOrphanedQuarantines(lockPath: string): Promise<void> {
  for (const quarantine of await quarantines(lockPath)) {
    const holder = parseHolder((await readRaw(quarantine)) ?? '');
    if (holder !== null && ownerAlive(holder.pid, holder.identity).alive) {
      // rename, not link: the slot may hold a void orphan (or nothing), and
      // the restore must land either way, byte for byte.
      await rename(quarantine, lockPath).catch(ignoreMissing);
    } else {
      await unlink(quarantine).catch(ignoreMissing);
    }
  }
}

/**
 * Whether an admission may be treated as FINAL: no reclaim quarantine is
 * visible (a visible one means a reclaim hole may be open — this claim may
 * sit inside it, void), and the claim at the path is still the one this
 * contender means to admit. Quarantine first, bytes second — see the module
 * doc for why that order can never straddle a restore.
 */
async function admissionFinal(
  lockPath: string,
  ours: (raw: string | null) => boolean,
): Promise<boolean> {
  if ((await quarantines(lockPath)).length > 0) return false;
  return ours(await readRaw(lockPath));
}

/**
 * Remove `judgedRaw` from `path` — or remove nothing.
 *
 * The move and the judgment travel together: `rename(2)` is atomic, so this
 * process either moves WHATEVER is at `path` — and then verifies, at the
 * private quarantine name where no rival can substitute bytes, that it moved
 * exactly what it judged stale — or moves nothing (`ENOENT`: a rival
 * reclaimer won the race). A mismatch means a rival's claim was legitimately
 * published after this contender's judgment: its live claim is what we are
 * holding, so it is restored byte for byte with a second rename and the
 * contender refuses. The restore must be a `rename`, not a `link`: while the
 * hole this rename opened was visible, any contender publishing into it voids
 * its own admission — so the slot may hold such a void orphan, and a `link`
 * restore would fail `EEXIST` against it and DROP the live owner's claim.
 * `true` means the judged claim was removed; `false` means the caller must
 * re-run its publish against whatever is there now.
 */
async function removeExactly(
  path: string,
  judgedRaw: string,
  hooks: AcquireHooks,
): Promise<boolean> {
  reclaimSeq += 1;
  const quarantine = `${path}.reclaiming-${process.pid}-${reclaimSeq}`;
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  await hooks.afterQuarantineRename?.();
  const moved = await readRaw(quarantine);
  if (moved === judgedRaw) {
    await unlink(quarantine).catch(ignoreMissing);
    return true;
  }
  await rename(quarantine, path).catch(ignoreMissing);
  return false;
}

/**
 * Acquire the exclusive workspace claim.
 *
 * The publish is an atomic `link(2)`, so only one process can win. An existing
 * claim held by this same process is re-entrant. A live foreign claim is
 * refused. A dead, recycled or malformed claim is reclaimed once — the removal
 * itself carries the authorization (`removeExactly`) — and the publish retried.
 *
 * No admission goes final while a reclaim quarantine is visible: a publish
 * that landed in a reclaim hole is an orphan the reclaimer's restore
 * supersedes, and the loop re-runs against whatever the restore put back.
 */
export async function acquireOwnerLock(
  lockPath: string,
  owner: OwnerLock,
  hooks: AcquireHooks = {},
): Promise<{ acquired: true; created: boolean } | { acquired: false; holder: OwnerLock }> {
  const serialized = `${JSON.stringify(owner, null, 2)}\n`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // A reclaimer that died mid-reclaim left its quarantine behind; resolve it
    // before publishing, so the slot below is never wedged by that litter.
    await resolveOrphanedQuarantines(lockPath);

    if (await publishAtomically(lockPath, serialized, `a${attempt}`)) {
      if (await admissionFinal(lockPath, (raw) => raw === serialized)) {
        return { acquired: true, created: true };
      }
      continue; // published into a reclaim hole — void; the restore supersedes it
    }

    const observed = await readRaw(lockPath);
    if (observed === null) continue; // vanished between the failed link and the read: retry

    const holder = parseHolder(observed);
    if (holder !== null) {
      if (sameOwner(holder, owner)) {
        const stillOurs = (raw: string | null): boolean => {
          const parsed = raw === null ? null : parseHolder(raw);
          return parsed !== null && sameOwner(parsed, owner);
        };
        if (await admissionFinal(lockPath, stillOurs)) {
          return { acquired: true, created: false };
        }
        continue; // our own orphan in a reclaim hole — the restore supersedes it
      }
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
    // remove bytes that were genuinely judged stale, and while the removal's
    // hole is open no rival admission can go final — so no rival, however it
    // raced past this judgment, can lose its claim here.
    await hooks.afterStaleObservation?.();
    await removeExactly(lockPath, observed, hooks);
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
