/**
 * Exclusive workspace ownership — a kernel-held lock.
 *
 * Exclusion is `flock(2)` (`LOCK_EX | LOCK_NB`) on `<workspace>/owner.lock`,
 * held on an open fd for as long as this process owns the workspace. A live
 * owner's exclusion is NON-REVOCABLE: no contender, and no recovery logic, can
 * take it or remove it — the kernel refuses every other `flock` on the file —
 * and the kernel releases it when the owner dies. Both halves replace the
 * previous claim-file protocol, which published a link(2)'d claim and reclaimed
 * a stale one with a verified rename-aside into a `.reclaiming-*` quarantine.
 * That protocol's recovery could restore one live owner's claim over another
 * (two stranded quarantines, resolved in readdir order, left the wrong holder
 * at the path and admitted a second owner — PR #104). With the kernel as the
 * referee there is no judgment about a previous holder's liveness, no reclaim,
 * no hole, no quarantine, and nothing to recover: a dead holder is simply a
 * lock nobody holds.
 *
 * `owner.lock` is a NOTICE BOARD, not the lock: the owner writes its claim
 * (pid + process identity + session) under the lock, and a refused contender
 * reads it to name the holder in its error. Two invariants keep the flock
 * sound, and both are absolute:
 *
 * 1. The file is NEVER unlinked. `flock` binds to the inode; unlinking the
 *    path and letting a rival create a fresh file hands that rival a lock on a
 *    different inode while the old one is still held — two owners. Release
 *    empties the file and unlocks; the empty file itself is litter.
 * 2. Only the process holding the lock ever writes or unlocks. A refused
 *    contender only ever reads.
 *
 * Re-entrancy is per process identity (pid + start ticks): `flock` treats each
 * open file description as an independent contender — even two fds in ONE
 * process contend — so the acquiring fd is kept in a registry keyed by lock
 * path and reused. A second claim from this process with a DIFFERENT identity
 * is refused like a foreign process: it opens its own fd and the kernel
 * refuses it.
 *
 * Litter from the previous protocol (`.reclaiming-*` quarantines, a stray
 * `owner.lock.reclaim` mutex, an empty or stale claim file) is inert: nothing
 * reads or removes it. It cannot resurrect an owner — exclusion lives in the
 * kernel, not in file contents.
 *
 * `flock` comes from libc via `bun:ffi`. The server targets Linux (see
 * CLAUDE.md); the glibc and musl sonames and the macOS libc are covered, and
 * anything else fails loud at first use — a silent fallback here would be two
 * processes both believing they own the workspace.
 */

import { dlopen, FFIType } from 'bun:ffi';
import {
  closeSync,
  constants as fsConstants,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SessionBusyError, WorkspaceError } from '../errors.js';
import { ProcessIdentitySchema } from './process-identity.js';
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

/** A live owner holds the lock. */
export class OwnerLockBusyError extends SessionBusyError {}

/** `<workspace.root>/owner.lock` */
export function ownerLockPath(workspace: WorkspacePaths): string {
  return join(workspace.root, 'owner.lock');
}

/** flock(2) operations — the Linux/glibc values, identical on the BSDs and macOS. */
const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

/** libc sonames carrying `flock`, in probe order (glibc, musl, macOS). */
const LIBC_CANDIDATES = [
  'libc.so.6',
  'libc.musl-x86_64.so.1',
  'libc.musl-aarch64.so.1',
  'libc.dylib',
];

type FlockFn = (fd: number, operation: number) => number;

let flockFn: FlockFn | undefined;

/** Resolve `flock(2)` from libc once; fail loud when the platform has none. */
function loadFlock(): FlockFn {
  if (flockFn !== undefined) return flockFn;
  const misses: string[] = [];
  for (const name of LIBC_CANDIDATES) {
    try {
      const lib = dlopen(name, {
        flock: { args: [FFIType.int, FFIType.int], returns: FFIType.int },
      });
      flockFn = lib.symbols.flock as FlockFn;
      return flockFn;
    } catch (error) {
      misses.push(`${name}: ${(error as Error).message}`);
    }
  }
  throw new WorkspaceError(
    `cannot load flock(2) for the workspace ownership lock on ${process.platform} ` +
      `(tried ${LIBC_CANDIDATES.join(', ')}): ${misses.join('; ')}`,
  );
}

/**
 * The locks this process holds, keyed by lock path. The fd must live as long
 * as the ownership: `flock` is released when the fd closes, and the kernel
 * releases it when the process dies — a crashed server never wedges anything.
 */
const holds = new Map<string, { fd: number; owner: OwnerLock }>();

/** Whether two owners identify the same live process. */
function sameOwner(left: OwnerLock, right: OwnerLock): boolean {
  return left.pid === right.pid && left.identity.startTicks === right.identity.startTicks;
}

/** The exact bytes an acquire writes for a claim. */
function serialize(owner: OwnerLock): string {
  return `${JSON.stringify(owner, null, 2)}\n`;
}

/** Read and validate the claim on the notice board; `null` when absent or unreadable. */
function readHolder(lockPath: string): OwnerLock | null {
  try {
    const parsed = OwnerLockSchema.safeParse(JSON.parse(readFileSync(lockPath, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Rewrite the notice board under the lock we hold. */
function writeClaim(fd: number, owner: OwnerLock): void {
  ftruncateSync(fd, 0);
  writeSync(fd, serialize(owner), 0, 'utf8');
}

/** How often a busy contender re-reads an unreadable claim before failing loud. */
const BUSY_ATTEMPTS = 3;
/** Pause between those reads — covers a release (truncate → unlock) racing the read. */
const BUSY_RETRY_MS = 5;

/**
 * Acquire the exclusive workspace claim.
 *
 * The publish is one non-blocking `flock(2)`: the kernel either grants this
 * process the workspace or refuses it — there is no read-then-act window, so
 * no rival can slip between a judgment and the act, and no admission can be
 * invalidated after the fact. A refused contender reports the holder named on
 * the notice board.
 *
 * An existing claim held by this same process (same pid + start ticks) is
 * re-entrant and reports `created: false`; any fresh take — an empty workspace
 * or one whose previous holder died — reports `created: true`.
 */
export async function acquireOwnerLock(
  lockPath: string,
  owner: OwnerLock,
): Promise<{ acquired: true; created: boolean } | { acquired: false; holder: OwnerLock }> {
  const flock = loadFlock();
  const held = holds.get(lockPath);
  if (held !== undefined && sameOwner(held.owner, owner)) {
    return { acquired: true, created: false }; // re-entrant: this process already owns it
  }

  for (let attempt = 0; attempt < BUSY_ATTEMPTS; attempt += 1) {
    // O_RDWR | O_CREAT: create the notice board on the first take, never
    // truncate it here — truncation is a write, and writes belong under the lock.
    const fd = openSync(lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o644);
    let locked = false;
    try {
      locked = flock(fd, LOCK_EX | LOCK_NB) === 0;
    } finally {
      if (!locked) closeSync(fd);
    }
    if (locked) {
      try {
        writeClaim(fd, owner);
      } catch (error) {
        closeSync(fd); // closing releases the lock — a half-written claim owns nothing
        throw error;
      }
      holds.set(lockPath, { fd, owner });
      return { acquired: true, created: true };
    }

    // The kernel refused: the holder is provably alive, whatever the file says.
    // Name it from the notice board — unless it names US, which happens when a
    // same-process acquire raced this one and won: that is re-entrance, not
    // busy (pid + start ticks cannot belong to another process).
    const holder = readHolder(lockPath);
    if (holder !== null) {
      if (sameOwner(holder, owner)) return { acquired: true, created: false };
      return { acquired: false, holder };
    }
    // A release (truncate → unlock) racing this read can leave the file
    // momentarily empty — retry the flock itself before concluding anything.
    await new Promise<void>((resolve) => setTimeout(resolve, BUSY_RETRY_MS));
  }

  throw new OwnerLockBusyError(
    'owner lock is held by another process, but its claim file could not be read',
  );
}

/**
 * Release the claim only when this process still holds it.
 *
 * Returns `false` when this process holds nothing here (or a different owner
 * does) — another owner's lock is never touched. The notice board is emptied,
 * never unlinked: a stale claim file must never be mistaken for a held lock,
 * and unlinking the path would put a fresh inode where the owner's lock lives.
 */
export async function releaseOwnerLock(lockPath: string, owner: OwnerLock): Promise<boolean> {
  const held = holds.get(lockPath);
  if (held === undefined || !sameOwner(held.owner, owner)) return false;
  holds.delete(lockPath);
  ftruncateSync(held.fd, 0); // the board names no owner once we are out
  loadFlock()(held.fd, LOCK_UN);
  closeSync(held.fd);
  return true;
}
