/**
 * The `flock(2)` backend behind the workspace ownership lock (`owner-lock.ts`).
 *
 * `flock` comes from the kernel, and the RUNTIME decides how this process
 * reaches it. Under Bun it is libc's, through Bun's FFI; under Node there is
 * no FFI, so the very same kernel lock is taken by util-linux's `flock(1)`,
 * applied to the descriptor this process already holds. Either way it is ONE
 * lock on ONE file: the kernel refuses every other `flock` on it, and it dies
 * with the descriptor. The server targets Linux (see CLAUDE.md); the glibc and
 * musl sonames and the macOS libc are covered, and anything else fails loud —
 * a silent fallback here would be two processes both believing they own the
 * workspace.
 *
 * The FFI access is DYNAMIC: the published bin runs on Node (`package.json` →
 * `dist/main.js` behind `#!/usr/bin/env node`), where `bun:ffi` does not
 * exist — a static import would crash the module on LOAD, before any probe
 * could report why. The boot gate ({@link assertOwnerLockBackend}) resolves
 * the backend BEFORE the server comes up: a host that cannot provide one can
 * never enforce the one-run rule.
 */

import { spawn } from 'node:child_process';
import { accessSync, closeSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { WorkspaceError } from '../errors.js';

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
export async function resolveFlock(opener: FlockOpener): Promise<FlockFn> {
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
 * The backend over a RESOLVED `flock(2)` symbol.
 *
 * The symbol is the libc one, so the unlock is an explicit `LOCK_UN` — and
 * the descriptor is closed even when that call fails, because closing alone
 * releases the flock and a descriptor left open would keep the kernel lock
 * alive with no registry entry to reach it by.
 */
export function symbolBackend(flock: FlockFn): FlockBackend {
  return {
    async tryLock(fd: number): Promise<boolean> {
      return flock(fd, LOCK_EX | LOCK_NB) === 0;
    },
    release(fd: number): void {
      try {
        flock(fd, LOCK_UN);
      } finally {
        closeSync(fd);
      }
    },
  };
}

/**
 * The Bun-side backend: libc's `flock(2)`, through Bun's FFI.
 *
 * `bun:ffi` is a Bun-only module, and a STATIC import of it would make every
 * installed copy die on Node with ERR_UNSUPPORTED_ESM_URL_SCHEME before it
 * could print its own help — the published bin runs on the node floor
 * package.json declares. So the import is dynamic ({@link loadFfi}), and only
 * the runtime check that picks this backend ever reaches it.
 */
async function bunFlockBackend(): Promise<FlockBackend> {
  return symbolBackend(await resolveFlock(openFlockInLibc));
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
 * The backend for THIS runtime, resolved fresh.
 *
 * Bun reaches libc through its own FFI; Node has none, so the same kernel
 * lock comes from util-linux's `flock(1)`. The choice is the runtime's, made
 * once — never a fallback: a platform with neither fails loud at first use
 * rather than pretending the workspace is free.
 */
function createBackend(): Promise<FlockBackend> {
  return 'bun' in process.versions ? bunFlockBackend() : nodeFlockBackend();
}

/** The resolved backend of THIS runtime, cached once it is known to work. */
let backend: Promise<FlockBackend> | undefined;

export function loadBackend(): Promise<FlockBackend> {
  backend ??= createBackend().catch((error: unknown) => {
    // A failed resolution is not a verdict: the next attempt retries instead
    // of replaying a dead one.
    backend = undefined;
    throw error;
  });
  return backend;
}

/**
 * The gate's Node-side check: util-linux's `flock(1)` must be reachable.
 *
 * The Node backend reaches the kernel through that binary, so a host without
 * it can never enforce the one-run rule — the same hole the libc probe closes
 * on Bun. Nothing is locked and no file is touched: this only asks whether
 * the binary is there.
 */
function assertFlockCli(bin = 'flock'): void {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (dir === '') continue;
    try {
      accessSync(join(dir, bin), fsConstants.X_OK);
      return;
    } catch {
      // not this directory — keep looking
    }
  }
  throw new WorkspaceError(
    `cannot take the workspace ownership lock on ${process.platform}: ` +
      `${bin}(1) is not on PATH — the workspace lock needs util-linux's flock`,
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
 * It RESOLVES the backend and nothing more: no file is opened, no `flock` is
 * called, `<workspace>/owner.lock` is never created, and the acquire path's
 * module cache is never written — an injected opener must not leak into the
 * real one. A failed resolution is not cached either: the next attempt
 * retries. A backend that failed outright (no FFI on this runtime) is
 * reported as it is — never as a hunt through sonames it never opened.
 *
 * @param opener the libc seam to resolve through — the real one by default,
 *   injectable so a failed resolution is testable. An injected opener probes
 *   the libc candidates; without one, THIS runtime's own backend is resolved.
 */
export async function assertOwnerLockBackend(opener?: FlockOpener): Promise<void> {
  if (opener !== undefined) {
    await resolveFlock(opener);
    return;
  }
  if ('bun' in process.versions) {
    await bunFlockBackend(); // resolves libc's `flock(2)` — takes no lock
    return;
  }
  assertFlockCli(); // Node has no FFI: util-linux's `flock(1)` is the backend
}
