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
 * `flock` comes from libc via `bun:ffi`, and that FFI access is DYNAMIC: the
 * published bin runs on Node (`package.json` → `dist/main.js` behind
 * `#!/usr/bin/env node`), where `bun:ffi` does not exist — a static import
 * would crash the module on LOAD, before any probe could report why. The
 * server targets Linux (see CLAUDE.md); the glibc and musl sonames and the
 * macOS libc are covered, and anything else fails loud at BOOT (see
 * `assertOwnerLockBackend`) — a silent fallback here would be two processes
 * both believing they own the workspace.
 */

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
export const LIBC_CANDIDATES = [
  'libc.so.6',
  'libc.musl-x86_64.so.1',
  'libc.musl-aarch64.so.1',
  'libc.dylib',
] as const;

/** `flock(2)` — the C function: (fd, operation) → 0 on success. */
export type FlockFn = (fd: number, operation: number) => number;

/**
 * Opens ONE libc soname and hands back its `flock` symbol.
 *
 * Throws when that soname cannot be opened or carries no `flock`. This is the
 * seam the boot gate AND the acquire path are injected through — never a
 * module mock, which would leak into the suites running alongside.
 */
export type FlockOpener = (soname: string) => Promise<FlockFn>;

/**
 * The FFI module, loaded DYNAMICALLY.
 *
 * `bun:ffi` exists only under Bun, and the published bin runs on Node: a
 * static import of it crashes the module on LOAD, before any probe can report
 * why the backend is missing. A failed load is NOT cached — the next attempt
 * retries, so a host that gains the backend (or a later boot in the same
 * process) is not stuck with the first failure.
 */
let ffiModule: typeof import('bun:ffi') | undefined;

async function loadFfi(): Promise<typeof import('bun:ffi')> {
  if (ffiModule !== undefined) return ffiModule;
  let loaded: typeof import('bun:ffi');
  try {
    loaded = await import('bun:ffi');
  } catch (error) {
    // The runtime has no FFI backend AT ALL (Node): say so plainly. "flock is
    // missing" would send an operator hunting for the wrong libc, when the
    // backend that could have opened one was never there.
    throw new WorkspaceError(
      `no FFI backend on this runtime — bun:ffi is unavailable: ${(error as Error).message}`,
    );
  }
  ffiModule = loaded;
  return loaded;
}

/**
 * The default opener: the platform's libc, through Bun's FFI.
 *
 * Exported so a test can compose a failing opener with the REAL backend: a
 * stub symbol cannot prove that a kernel lock was actually taken.
 */
export async function openFlockInLibc(soname: string): Promise<FlockFn> {
  const ffi = await loadFfi();
  const lib = ffi.dlopen(soname, {
    flock: { args: [ffi.FFIType.int, ffi.FFIType.int], returns: ffi.FFIType.int },
  });
  return lib.symbols.flock as FlockFn;
}

/**
 * Probe the libc candidates for `flock(2)`.
 *
 * Fails loud, naming the platform and EVERY soname tried with what each one
 * said: an operator needs to know which libc was looked for, not just that
 * "something went wrong".
 */
async function resolveFlock(opener: FlockOpener): Promise<FlockFn> {
  const misses: string[] = [];
  for (const name of LIBC_CANDIDATES) {
    try {
      return await opener(name);
    } catch (error) {
      // A house error is a BACKEND-level failure, not a soname-level miss: the
      // FFI itself could not be loaded, so no libc was ever opened. Folding it
      // into the misses would name sonames that were never tried and bury the
      // one fact that matters ("this runtime has no FFI backend") — so it goes
      // out unchanged.
      if (error instanceof WorkspaceError) throw error;
      misses.push(`${name}: ${(error as Error).message}`);
    }
  }
  throw new WorkspaceError(
    `cannot load flock(2) for the workspace ownership lock on ${process.platform} ` +
      `(tried ${LIBC_CANDIDATES.join(', ')}): ${misses.join('; ')}`,
  );
}

/**
 * The BOOT GATE: resolve this host's `flock(2)` WITHOUT taking a lock.
 *
 * The workspace's one-run rule rests on a kernel-held lock. A host that cannot
 * provide that backend can never enforce it — two servers would each believe
 * they own the workspace — so the server refuses to come up instead. This
 * runs BEFORE the workspace exists, before a config is read and before the MCP
 * server starts.
 *
 * It RESOLVES the symbol and nothing more: no file is opened, no `flock` is
 * called, `<workspace>/owner.lock` is never created, and the acquire path's
 * module cache is never written — an injected opener must not leak into the
 * real one. A failed resolution is not cached either: the next attempt
 * retries. A backend that failed outright (no FFI on this runtime) is
 * reported as it is — never as a hunt through sonames it never opened.
 */
export async function assertOwnerLockBackend(opener: FlockOpener = openFlockInLibc): Promise<void> {
  await resolveFlock(opener);
}

/** The acquire path's own resolved symbol. */
let flockFn: FlockFn | undefined;

/**
 * Resolve `flock(2)` for the acquire path; fail loud when the platform has
 * none.
 *
 * The cache holds SUCCESSES only — a failed resolution is never cached, so
 * the next attempt retries instead of replaying a dead verdict. An INJECTED
 * opener never reaches that cache: it resolves fresh every time, so a test's
 * stub can never become the workspace's real lock backend.
 */
async function loadFlock(opener?: FlockOpener): Promise<FlockFn> {
  if (opener !== undefined) return resolveFlock(opener);
  if (flockFn !== undefined) return flockFn;
  const resolved = await resolveFlock(openFlockInLibc);
  flockFn = resolved;
  return resolved;
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
 *
 * @param opener the backend to resolve `flock(2)` through — the real one by
 *   default, injectable so a failed resolution is testable. An injected
 *   opener resolves fresh on every call and never enters the module cache.
 */
export async function acquireOwnerLock(
  lockPath: string,
  owner: OwnerLock,
  opener?: FlockOpener,
): Promise<{ acquired: true; created: boolean } | { acquired: false; holder: OwnerLock }> {
  const flock = await loadFlock(opener);
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
 * The `flock(LOCK_UN)` on the held fd — injectable so a failing unlock is
 * testable (the same seam doctrine as `emptyBoard`).
 */
export type UnlockFn = (fd: number) => void | Promise<void>;

/**
 * Release the claim only when this process still holds it.
 *
 * Returns `false` when this process holds nothing here (or a different owner
 * does) — another owner's lock is never touched. The notice board is emptied,
 * never unlinked: a stale claim file must never be mistaken for a held lock,
 * and unlinking the path would put a fresh inode where the owner's lock lives.
 *
 * The lock ALWAYS comes home: unlock + close run in a `finally`, so a failed
 * board write (a read-only remount, say) fails loud but cannot leave this
 * process holding the kernel lock with no registry entry to reach it by —
 * that would wedge every rival until the process exits (PR #104 review).
 *
 * @param emptyBoard the notice-board teardown, injectable for tests (defaults
 *   to truncating the file to nothing) — the same seam doctrine as `makeExec`'s
 *   `now`: a failure injected through the parameter never leaks into other
 *   test files the way a module mock does.
 * @param unlock the `flock(LOCK_UN)` call, injectable for tests (defaults to
 *   the real one). Its failure must not keep the fd open: closing it alone
 *   releases the flock, and a fd left open would keep the kernel lock alive
 *   with no registry entry to reach it by.
 */
export async function releaseOwnerLock(
  lockPath: string,
  owner: OwnerLock,
  emptyBoard: (fd: number) => void = (fd) => ftruncateSync(fd, 0),
  unlock: UnlockFn = async (fd) => {
    (await loadFlock())(fd, LOCK_UN);
  },
): Promise<boolean> {
  const held = holds.get(lockPath);
  if (held === undefined || !sameOwner(held.owner, owner)) return false;
  holds.delete(lockPath); // teardown has begun — the registry names no hold from here
  try {
    emptyBoard(held.fd); // the board names no owner once we are out
  } finally {
    try {
      await unlock(held.fd);
    } finally {
      // The fd closes even when the unlock fails: closing alone releases the
      // flock, and a fd left open would keep the kernel lock alive with no
      // registry entry to reach it by.
      closeSync(held.fd);
    }
  }
  return true;
}
