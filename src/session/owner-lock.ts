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
 * `flock` comes from the kernel. Under Bun it is libc's, reached through Bun's
 * FFI; under Node there is no FFI, so the very same kernel lock is taken by
 * util-linux's `flock(1)`, applied to the descriptor this process already
 * holds. Either way it is ONE lock on ONE file: the kernel refuses every
 * other `flock` on it, and it dies with the descriptor. The server targets
 * Linux (see CLAUDE.md); the glibc and musl sonames and the macOS libc are
 * covered, and anything else fails loud at first use — a silent fallback here
 * would be two processes both believing they own the workspace.
 */

import { spawn } from 'node:child_process';
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

/**
 * Taking the kernel's `flock(2)` on a descriptor.
 *
 * Both backends lock the SAME open file description — the one this process
 * holds on `owner.lock` — so every invariant above survives either one: a
 * rival is refused by the kernel, the lock is not revocable, and it dies with
 * the descriptor.
 */
export interface FlockBackend {
  /**
   * Take the exclusive, non-blocking lock on `fd`.
   *
   * `false` means a rival holds it — a fact the kernel reported, not a
   * judgment this process made. Anything else (no `flock(1)`, a platform
   * without one) throws: a lock nobody took is not a busy workspace.
   */
  tryLock(fd: number): Promise<boolean>;
  /**
   * Give the lock back and dispose of the descriptor.
   *
   * The kernel drops a flock when the last descriptor referring to it is
   * closed, so releasing means closing — the explicit unlock is only there
   * for the runtime that can make one.
   */
  release(fd: number): void;
}

/** libc sonames carrying `flock`, in probe order (glibc, musl, macOS). */
const LIBC_CANDIDATES = [
  'libc.so.6',
  'libc.musl-x86_64.so.1',
  'libc.musl-aarch64.so.1',
  'libc.dylib',
];

type FlockFn = (fd: number, operation: number) => number;

/**
 * `flock(2)` from libc, through Bun's FFI.
 *
 * `bun:ffi` is a Bun-only module, and a STATIC import of it would make every
 * installed copy die on Node with ERR_UNSUPPORTED_ESM_URL_SCHEME before it
 * could print its own help — the published bin runs on the node floor
 * package.json declares. So the import is dynamic, and only the runtime check
 * in {@link loadBackend} ever reaches it.
 */
async function bunFlockBackend(): Promise<FlockBackend> {
  let ffi: typeof import('bun:ffi');
  try {
    ffi = await import('bun:ffi');
  } catch (error) {
    throw new WorkspaceError(
      `cannot load flock(2) for the workspace ownership lock: ${(error as Error).message}`,
    );
  }

  const misses: string[] = [];
  for (const name of LIBC_CANDIDATES) {
    let flock: FlockFn;
    try {
      const lib = ffi.dlopen(name, {
        flock: { args: [ffi.FFIType.int, ffi.FFIType.int], returns: ffi.FFIType.int },
      });
      flock = lib.symbols.flock as FlockFn;
    } catch (error) {
      misses.push(`${name}: ${(error as Error).message}`);
      continue;
    }
    return {
      async tryLock(fd: number): Promise<boolean> {
        return flock(fd, LOCK_EX | LOCK_NB) === 0;
      },
      release(fd: number): void {
        flock(fd, LOCK_UN);
        closeSync(fd);
      },
    };
  }
  throw new WorkspaceError(
    `cannot load flock(2) for the workspace ownership lock on ${process.platform} ` +
      `(tried ${LIBC_CANDIDATES.join(', ')}): ${misses.join('; ')}`,
  );
}

/** util-linux `flock(1)`'s exit code for "another process holds the lock". */
const FLOCK_CONFLICT_EXIT = 42;

/**
 * The slot our descriptor rides in on the child's stdio.
 *
 * `flock(1)` locks THAT descriptor — the one this process already holds — so
 * the lock lands on the open file description we keep: it stays ours after the
 * child exits, every rival is refused by the kernel, and the kernel drops it
 * when we close the descriptor or die.
 */
const CHILD_FD = 3;

/** What `flock(1)` decided about our descriptor. */
interface FlockOutcome {
  /** The lock is ours. */
  granted: boolean;
  /** A rival holds it. */
  conflict: boolean;
  /** What went wrong, when something did. */
  detail: string;
}

/** Run util-linux's `flock(1)` against our descriptor and read what it decided. */
function runFlockCli(fd: number, bin: string): Promise<FlockOutcome> {
  return new Promise((resolve) => {
    const child = spawn(
      bin,
      [
        '--exclusive',
        '--nonblock',
        '--conflict-exit-code',
        String(FLOCK_CONFLICT_EXIT),
        String(CHILD_FD),
      ],
      { stdio: ['ignore', 'ignore', 'pipe', fd] },
    );
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error: Error) => {
      resolve({
        granted: false,
        conflict: false,
        detail: `cannot run ${bin} to take the workspace lock: ${error.message}`,
      });
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve({ granted: true, conflict: false, detail: '' });
        return;
      }
      if (code === FLOCK_CONFLICT_EXIT) {
        resolve({ granted: false, conflict: true, detail: '' });
        return;
      }
      resolve({
        granted: false,
        conflict: false,
        detail:
          `${bin} could not take the workspace lock (exit ${code ?? 'none'}): ` +
          (stderr.trim() || 'no output'),
      });
    });
  });
}

/**
 * `flock(2)` through util-linux's `flock(1)` — how Node reaches the syscall.
 *
 * Node has no FFI, so a short-lived child inherits our descriptor and locks
 * it. The child exits at once; the lock stays ours because it lives on the
 * open file description we still hold, and the kernel drops it when that
 * descriptor closes or this process dies — a crashed owner never wedges the
 * workspace.
 *
 * `bin` is a seam: the tests point it at a binary that does not exist to
 * prove the failure is loud instead of a quiet "nobody holds this".
 */
export async function nodeFlockBackend(bin = 'flock'): Promise<FlockBackend> {
  return {
    async tryLock(fd: number): Promise<boolean> {
      const outcome = await runFlockCli(fd, bin);
      if (outcome.granted) return true;
      if (outcome.conflict) return false;
      throw new WorkspaceError(
        `cannot take the workspace ownership lock on ${process.platform}: ${outcome.detail}`,
      );
    },
    release(fd: number): void {
      // Closing IS the unlock here: the child is long gone, so ours is the
      // last descriptor referring to the locked description, and the kernel
      // drops the flock when it closes.
      closeSync(fd);
    },
  };
}

/**
 * The backend for THIS runtime, resolved once.
 *
 * Bun reaches libc through its own FFI; Node has none, so the same kernel
 * lock comes from util-linux's `flock(1)`. The choice is the runtime's, made
 * once and cached — never a fallback: a platform with neither fails loud at
 * first use rather than pretending the workspace is free.
 */
let backend: Promise<FlockBackend> | undefined;

function loadBackend(): Promise<FlockBackend> {
  backend ??= 'bun' in process.versions ? bunFlockBackend() : nodeFlockBackend();
  return backend;
}

/**
 * The locks this process holds, keyed by lock path. The fd must live as long
 * as the ownership: `flock` is released when the fd closes, and the kernel
 * releases it when the process dies — a crashed server never wedges anything.
 */
const holds = new Map<string, { fd: number; owner: OwnerLock; flock: FlockBackend }>();

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
  const flock = await loadBackend();
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
      locked = await flock.tryLock(fd);
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
      holds.set(lockPath, { fd, owner, flock });
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
 *
 * The lock ALWAYS comes home: the release runs in a `finally`, so a failed
 * board write (a read-only remount, say) fails loud but cannot leave this
 * process holding the kernel lock with no registry entry to reach it by —
 * that would wedge every rival until the process exits (PR #104 review).
 *
 * @param emptyBoard the notice-board teardown, injectable for tests (defaults
 *   to truncating the file to nothing) — the same seam doctrine as `makeExec`'s
 *   `now`: a failure injected through the parameter never leaks into other
 *   test files the way a module mock does.
 */
export async function releaseOwnerLock(
  lockPath: string,
  owner: OwnerLock,
  emptyBoard: (fd: number) => void = (fd) => ftruncateSync(fd, 0),
): Promise<boolean> {
  const held = holds.get(lockPath);
  if (held === undefined || !sameOwner(held.owner, owner)) return false;
  holds.delete(lockPath); // teardown has begun — the registry names no hold from here
  try {
    emptyBoard(held.fd); // the board names no owner once we are out
  } finally {
    // The backend that took the lock gives it back — and disposes of the
    // descriptor, which alone releases the flock even after a failed write.
    held.flock.release(held.fd);
  }
  return true;
}
