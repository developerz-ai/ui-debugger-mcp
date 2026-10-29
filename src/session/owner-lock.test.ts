import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WorkspaceError } from '../errors.js';
import {
  acquireOwnerLock,
  assertOwnerLockBackend,
  type FlockOpener,
  LIBC_CANDIDATES,
  type OwnerLock,
  openFlockInLibc,
  ownerLockPath,
  releaseOwnerLock,
} from './owner-lock.js';
import { captureIdentity } from './process-identity.js';
import { workspacePaths } from './workspace.js';

let dir: string;
let lockPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'owner-lock-'));
  const workspace = workspacePaths(join(dir, 'project'), join(dir, 'workspace'));
  await mkdir(workspace.root, { recursive: true });
  lockPath = ownerLockPath(workspace);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function owner(pid = process.pid, sessionId = 'session-1'): OwnerLock {
  return {
    pid,
    identity: captureIdentity(pid),
    sessionId,
    acquiredAt: '2026-07-27T14:30:05.000Z',
  };
}

/** The exact bytes an acquire writes for a claim — byte comparisons use this. */
function serialize(claim: OwnerLock): string {
  return `${JSON.stringify(claim, null, 2)}\n`;
}

/** Write a claim file directly, as a crashed server would have left it. */
async function seedClaim(path: string, claim: OwnerLock): Promise<void> {
  await writeFile(path, serialize(claim), 'utf8');
}

/** A stale-claim holder: a pid that is not alive. */
function staleOwner(sessionId: string): OwnerLock {
  return owner(999_999_999, sessionId);
}

interface ChildResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Race REAL child processes against `acquireOwnerLock` on the same path.
 * Exclusion is a kernel lock, so cross-process contention can only be
 * exercised by actual second processes — an in-process rival would share this
 * process's pid and read as re-entrant (or be refused as a same-process
 * foreign identity, which is not the same race).
 */
async function contendViaChildren(
  path: string,
  sessionIds: [string, ...string[]],
): Promise<ChildResult[]> {
  const script = `
    const { acquireOwnerLock } = await import(process.env.OWNER_LOCK_MODULE);
    const { captureIdentity } = await import(process.env.PROCESS_IDENTITY_MODULE);
    const owner = {
      pid: process.pid,
      identity: captureIdentity(process.pid),
      sessionId: process.env.CHILD_SESSION_ID,
      acquiredAt: new Date().toISOString(),
    };
    const result = await acquireOwnerLock(process.env.OWNER_LOCK_PATH, owner);
    if (result.acquired) {
      // Stay alive until the rival has decided — its refusal needs our lock held.
      await Bun.sleep(300);
    }
    console.log(result.acquired ? 'ACQUIRED' : 'BUSY');
    process.exit(0);
  `;
  const env = {
    ...process.env,
    OWNER_LOCK_MODULE: join(import.meta.dir, 'owner-lock.ts'),
    PROCESS_IDENTITY_MODULE: join(import.meta.dir, 'process-identity.ts'),
    OWNER_LOCK_PATH: path,
  };
  const spawned = sessionIds.map((sessionId) =>
    Bun.spawn({
      cmd: ['bun', '-e', script],
      env: { ...env, CHILD_SESSION_ID: sessionId },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  return Promise.all(
    spawned.map(async (child) => {
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const exitCode = await child.exited;
      return { stdout: await stdout, stderr: await stderr, exitCode };
    }),
  );
}

function expectExactlyOneAcquired(results: ChildResult[]): void {
  for (const result of results) {
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
  }
  const outcomes = results.map((result) => result.stdout.trim());
  expect(outcomes.filter((outcome) => outcome === 'ACQUIRED')).toHaveLength(1);
  expect(outcomes.filter((outcome) => outcome === 'BUSY')).toHaveLength(outcomes.length - 1);
}

test('a second acquire against a live foreign holder is refused and returns the holder', async () => {
  const first = owner(process.pid, 'first');
  expect(await acquireOwnerLock(lockPath, first)).toEqual({ acquired: true, created: true });

  const foreign = owner(process.pid, 'foreign');
  foreign.identity = { startTicks: (first.identity.startTicks ?? 0) + 1 };
  const result = await acquireOwnerLock(lockPath, foreign);

  // The kernel refused the second fd — the refusal is not a judgment this
  // process made about a file, so no rival observation can invalidate it.
  expect(result.acquired).toBe(false);
  if (!result.acquired) expect(result.holder).toEqual(first);
});

test('acquire is re-entrant for the same pid and process identity', async () => {
  const first = owner();
  expect(await acquireOwnerLock(lockPath, first)).toEqual({ acquired: true, created: true });
  expect(await acquireOwnerLock(lockPath, first)).toEqual({ acquired: true, created: false });
});

test('two concurrent acquires by one owner in one process: both admitted, exactly one fresh', async () => {
  // The registry cannot see a same-process rival that races between the
  // registry miss and the flock; the loser's refusal reads the winner's claim
  // and must recognise its own identity — re-entrant, never busy.
  const first = owner();
  const results = await Promise.all([
    acquireOwnerLock(lockPath, first),
    acquireOwnerLock(lockPath, first),
  ]);
  for (const result of results) expect(result.acquired).toBe(true);
  expect(results.filter((result) => result.acquired && result.created)).toHaveLength(1);
});

test('a claim left by a dead pid is taken over', async () => {
  // No process holds the lock (the holder died), so the takeover is a plain
  // acquire — there is nothing to judge and nothing to reclaim.
  await seedClaim(lockPath, staleOwner('crashed'));

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

test('a claim whose pid was recycled is taken over', async () => {
  // Irrelevant under the kernel lock — identity matching exists for the CLI's
  // `stop` signal, never as a liveness judgment guarding exclusion.
  const recycled = owner(process.pid, 'recycled');
  recycled.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };
  await seedClaim(lockPath, recycled);

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

test('a failed resolution on the acquire path is retried, not replayed', async () => {
  // A resolution that failed is not a verdict — the next acquire must resolve
  // again instead of replaying the dead one. The failure is injected through
  // the acquire path's own seam (the opener), never a module mock: a mock
  // would leak into every test file running alongside.
  let attempts = 0;
  const opener: FlockOpener = async (soname) => {
    attempts += 1;
    if (attempts === 1) throw new WorkspaceError('no flock backend on this attempt');
    // The REAL backend: a stub symbol cannot prove a kernel lock was taken.
    return openFlockInLibc(soname);
  };

  await expect(
    acquireOwnerLock(lockPath, owner(process.pid, 'first'), opener),
  ).rejects.toBeInstanceOf(WorkspaceError);

  // The failed resolution was NOT cached: the next acquire resolves again —
  // through the same seam — and takes the workspace FRESH.
  expect(await acquireOwnerLock(lockPath, owner(process.pid, 'second'), opener)).toEqual({
    acquired: true,
    created: true,
  });
  expect(attempts).toBe(2);
});

test('release refuses a claim this process does not hold and leaves the file intact', async () => {
  // A claim file without a held lock is not ours to release — exclusion lives
  // in the kernel, so only the process holding the lock can give it back.
  const holder = owner(process.pid, 'holder');
  await seedClaim(lockPath, holder);

  const foreign = owner(process.pid, 'foreign');
  foreign.identity = { startTicks: (holder.identity.startTicks ?? 0) + 1 };
  expect(await releaseOwnerLock(lockPath, foreign)).toBe(false);
  // Even the exact holder named on the board cannot release without the lock.
  expect(await releaseOwnerLock(lockPath, holder)).toBe(false);
  expect(await readFile(lockPath, 'utf8')).toBe(serialize(holder));
});

test('release empties the board and frees the lock for the next owner', async () => {
  const holder = owner(process.pid, 'holder');
  expect(await acquireOwnerLock(lockPath, holder)).toEqual({ acquired: true, created: true });
  expect(await releaseOwnerLock(lockPath, holder)).toBe(true);
  expect(await releaseOwnerLock(lockPath, holder)).toBe(false);

  // The file stays (never unlinked — unlinking would swap the inode under a
  // live lock), but it names nobody and excludes nobody.
  expect(await readFile(lockPath, 'utf8')).toBe('');

  const next = owner(process.pid, 'next');
  next.identity = { startTicks: (holder.identity.startTicks ?? 0) + 1 };
  expect(await acquireOwnerLock(lockPath, next)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(next);
});

test('a failed notice-board teardown still frees the kernel lock', async () => {
  // The PR #104 review interleaving: emptying the board fails (a read-only
  // remount, say) AFTER the registry entry is gone. The fd must still be
  // unlocked and closed — otherwise this process keeps the kernel lock but has
  // no registry entry to reach it by, so no later release can help and every
  // rival is wedged until the process exits. The failure is injected through
  // releaseOwnerLock's `emptyBoard` seam — never a module mock, which would
  // leak into every test file running alongside.
  const holder = owner(process.pid, 'holder');
  expect(await acquireOwnerLock(lockPath, holder)).toEqual({ acquired: true, created: true });

  const failure = new Error('ftruncateSync failed: read-only file system');
  await expect(
    releaseOwnerLock(lockPath, holder, () => {
      throw failure;
    }),
  ).rejects.toBe(failure); // fails loud — but only after the lock is home

  // Nothing is held anymore: a repeat release is a plain "not held", and a
  // rival identity — a fresh fd the kernel MUST refuse if the lock leaked —
  // takes over immediately and publishes its own claim.
  expect(await releaseOwnerLock(lockPath, holder)).toBe(false);
  const rival = owner(process.pid, 'rival');
  rival.identity = { startTicks: (holder.identity.startTicks ?? 0) + 1 };
  expect(await acquireOwnerLock(lockPath, rival)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(rival);
});

test('a failed unlock still frees the kernel lock and reaches the caller', async () => {
  // The release's LAST step is the unlock. When it fails, the fd must still
  // come home — closing it alone releases the flock — and the failure must
  // reach the caller instead of vanishing into a silent "released". The
  // failure is injected through releaseOwnerLock's `unlock` seam — never a
  // module mock, which would leak into every test file running alongside.
  const holder = owner(process.pid, 'holder');
  expect(await acquireOwnerLock(lockPath, holder)).toEqual({ acquired: true, created: true });

  const failure = new Error('flock(LOCK_UN) failed');
  await expect(
    releaseOwnerLock(lockPath, holder, undefined, () => {
      throw failure;
    }),
  ).rejects.toBe(failure); // fails loud — but only after the lock is home

  // Nothing is held anymore: a repeat release is a plain "not held", and a
  // rival identity — a fresh fd the kernel MUST refuse if the lock leaked —
  // takes over immediately and publishes its own claim.
  expect(await releaseOwnerLock(lockPath, holder)).toBe(false);
  const rival = owner(process.pid, 'rival');
  rival.identity = { startTicks: (holder.identity.startTicks ?? 0) + 1 };
  expect(await acquireOwnerLock(lockPath, rival)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(rival);
});

test('two real child processes contend: exactly one acquires and one is busy', async () => {
  const results = await contendViaChildren(lockPath, ['child-a', 'child-b']);
  expectExactlyOneAcquired(results);

  // The winner exited, and its lock died with it: a fresh acquire takes over.
  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
});

test('two real child processes contend over a stale claim: exactly one acquires it', async () => {
  // A claim file from a crashed server excludes nobody: both children race one
  // kernel lock, and the kernel — not a reclaim protocol — picks the owner.
  await seedClaim(lockPath, staleOwner('crashed'));
  const results = await contendViaChildren(lockPath, ['child-a', 'child-b']);
  expectExactlyOneAcquired(results);

  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
});

test('two real child processes contend over a stale claim and a stray pre-version mutex file: exactly one acquires', async () => {
  // `owner.lock.reclaim` was the old design's serialization mutex. It no longer
  // exists in the protocol; a leftover from a previous version is litter —
  // neither read nor removed by acquisition.
  await seedClaim(lockPath, staleOwner('crashed'));
  const litter = staleOwner('crashed-reclaimer');
  await seedClaim(`${lockPath}.reclaim`, litter);
  const results = await contendViaChildren(lockPath, ['child-a', 'child-b']);
  expectExactlyOneAcquired(results);
  expect(await readFile(`${lockPath}.reclaim`, 'utf8')).toBe(serialize(litter));

  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
});

test('double-quarantine litter can never resurrect a second owner over a live holder', async () => {
  // THE PR #104 interleaving, pinned at the state it used to end in. A is the
  // admitted owner. The old protocol could strand TWO live quarantines: B
  // renamed A's claim aside (`.reclaiming-1`) and died; a contender published
  // a void claim into the hole; a delayed reclaimer quarantined that too
  // (`.reclaiming-2`) and died. Resolving both in readdir order restored the
  // SECOND one over the first — C over A — and C's retry admitted a second
  // owner while A was dispossessed. Under the kernel lock none of that
  // machinery exists: the litter is inert bytes, the holder keeps the
  // workspace, and no acquire can be admitted while A lives.
  const a = owner(process.pid, 'admitted');
  expect(await acquireOwnerLock(lockPath, a)).toEqual({ acquired: true, created: true });

  const c = owner(process.pid, 'void-claim');
  c.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };
  await seedClaim(`${lockPath}.reclaiming-1`, a);
  await seedClaim(`${lockPath}.reclaiming-2`, c);

  // C's retry: refused. A's claim survives verbatim; the litter is untouched.
  const result = await acquireOwnerLock(lockPath, c);
  expect(result.acquired).toBe(false);
  if (!result.acquired) expect(result.holder).toEqual(a);
  expect(await readFile(lockPath, 'utf8')).toBe(serialize(a));
  expect(await readFile(`${lockPath}.reclaiming-1`, 'utf8')).toBe(serialize(a));
  expect(await readFile(`${lockPath}.reclaiming-2`, 'utf8')).toBe(serialize(c));

  // A is still the one and only owner.
  expect(await acquireOwnerLock(lockPath, a)).toEqual({ acquired: true, created: false });
});

test('a real second process is refused even with double-quarantine litter seeded', async () => {
  // The same interleaving, cross-process: the litter cannot conjure a free
  // slot — the kernel lock is the only admission decision.
  const a = owner(process.pid, 'admitted');
  expect(await acquireOwnerLock(lockPath, a)).toEqual({ acquired: true, created: true });
  const c = owner(process.pid, 'void-claim');
  c.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };
  await seedClaim(`${lockPath}.reclaiming-1`, a);
  await seedClaim(`${lockPath}.reclaiming-2`, c);

  const [child] = await contendViaChildren(lockPath, ['child-c']);
  if (!child) throw new Error('child did not run');
  expect(child.exitCode).toBe(0);
  expect(child.stderr).toBe('');
  expect(child.stdout.trim()).toBe('BUSY');

  // And A's claim is exactly where it was.
  expect(await readFile(lockPath, 'utf8')).toBe(serialize(a));
});

test('a stale claim plus quarantine litter never wedges the next owner', async () => {
  // A crashed OLD-protocol reclaimer could leave all of this behind; a crashed
  // NEW-protocol owner leaves only the stale claim. Either way the next
  // acquirer takes over — recovery is the kernel releasing the lock, so there
  // is no resolution pass to strand or mis-order.
  await seedClaim(lockPath, staleOwner('crashed'));
  await seedClaim(`${lockPath}.reclaiming-1`, staleOwner('crashed-a'));
  await seedClaim(`${lockPath}.reclaiming-2`, staleOwner('crashed-b'));

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);

  const leftovers = (await readdir(dirname(lockPath))).filter((name) =>
    name.includes('.reclaiming-'),
  );
  expect(leftovers).toHaveLength(2); // inert litter is left alone
});

test('an empty claim file is litter, not an in-progress publish', async () => {
  // The old protocol wrote the claim file and filled it in two steps, so an
  // empty file was a live publish mid-flight and had to be refused. The kernel
  // lock is taken BEFORE any content is written, so an empty file can only be
  // litter — there is no create-then-fill window to protect.
  await writeFile(lockPath, '', 'utf8');

  const current = owner(process.pid, 'first');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

/**
 * The boot gate — `flock(2)` resolved BEFORE the server comes up.
 *
 * The one-run rule rests on a kernel-held lock, so a host that cannot provide
 * that backend can never enforce it: the server must refuse to boot rather
 * than come up unable to own anything. The gate RESOLVES the symbol and
 * nothing more — it opens no file, takes no lock, creates no `owner.lock`,
 * and never writes the acquire path's cache, so an injected backend cannot
 * leak into the real one.
 *
 * The failing backend is injected through the gate's own seam — never a
 * module mock, which would leak into the suites running alongside.
 */

/** A backend that resolves nothing — every soname misses. */
function failingBackend(reason: string): { opener: FlockOpener; attempts: string[] } {
  const attempts: string[] = [];
  return {
    attempts,
    opener: async (soname) => {
      attempts.push(soname);
      throw new Error(`${reason}: ${soname}`);
    },
  };
}

/** The rejection of a promise that failed — `undefined` when it resolved. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

test('the boot gate fails loud when no libc carries flock', async () => {
  const { opener, attempts } = failingBackend('no flock here');
  const error = await failure(assertOwnerLockBackend(opener));

  // A house error, not a generic one: the boot reports the gate's failure
  // verbatim, so the class has to survive to the caller.
  expect(error).toBeInstanceOf(WorkspaceError);
  const message = error instanceof Error ? error.message : '';

  // Actionable: the platform, and EVERY soname tried with what each one said.
  expect(message).toContain(process.platform);
  expect(attempts).toEqual([...LIBC_CANDIDATES]);
  for (const soname of LIBC_CANDIDATES) {
    expect(message).toContain(soname);
    expect(message).toContain(`no flock here: ${soname}`);
  }
});

test('the boot gate says a missing FFI backend plainly instead of naming sonames it never tried', async () => {
  // The runtime has no FFI backend AT ALL (the published bin runs on Node):
  // no libc was ever opened, so naming sonames would send the operator
  // hunting for a library that was never tried — and would bury the one fact
  // that matters.
  const thrown = new WorkspaceError('no FFI backend on this runtime — bun:ffi is unavailable');
  const attempts: string[] = [];
  const opener: FlockOpener = async (soname) => {
    attempts.push(soname);
    throw thrown;
  };

  const error = await failure(assertOwnerLockBackend(opener));

  // The backend failure comes out UNCHANGED — not folded into a soname miss.
  expect(error).toBe(thrown);
  expect(error).toBeInstanceOf(WorkspaceError);

  const message = error instanceof Error ? error.message : '';
  expect(message).toContain('no FFI backend on this runtime');
  for (const soname of LIBC_CANDIDATES) {
    expect(message).not.toContain(soname);
  }
  // And the probe stopped at the first failure: no soname was opened.
  expect(attempts).toEqual([LIBC_CANDIDATES[0]]);
});

test('the boot gate resolves when a backend carries flock', async () => {
  const attempts: string[] = [];
  const opener: FlockOpener = async (soname) => {
    attempts.push(soname);
    return () => 0; // a stub symbol — the gate resolves, it never calls it
  };

  await assertOwnerLockBackend(opener);
  // The first candidate that carries flock wins — the rest are not probed.
  expect(attempts).toEqual([LIBC_CANDIDATES[0]]);
});

test('the real gate resolves this host', async () => {
  // The default opener. The FFI load is DYNAMIC: a static `bun:ffi` import
  // made this module unloadable on the published Node runtime, where the gate
  // could not even report WHY the backend was missing.
  await assertOwnerLockBackend();
});

test('the boot gate takes no run lock and creates no lock file', async () => {
  const opener: FlockOpener = async () => () => 0;
  await assertOwnerLockBackend(opener);

  // Detection touched nothing on disk.
  expect(existsSync(lockPath)).toBe(false);

  // And it held no lock: the acquire below takes the workspace FRESH. A gate
  // that had taken (and kept) the lock would be refused by the kernel, and a
  // gate that had registered a hold would report a re-entrant take instead.
  expect(await acquireOwnerLock(lockPath, owner(process.pid, 'first'))).toEqual({
    acquired: true,
    created: true,
  });
});

test('a failed gate poisons nothing: the real acquire path still works', async () => {
  const { opener } = failingBackend('no flock here');
  await expect(assertOwnerLockBackend(opener)).rejects.toBeInstanceOf(WorkspaceError);

  // The failed resolution was NOT cached: the acquire path resolves on its
  // own and takes the lock for real.
  expect(await acquireOwnerLock(lockPath, owner(process.pid, 'after-failure'))).toEqual({
    acquired: true,
    created: true,
  });
});

/**
 * Run a script in a CHILD process, against this module.
 *
 * A child is the only place the module cache is COLD — and a cold cache is
 * what makes a poisoned or leaked cache visible: a warm one answers from the
 * symbol an earlier acquire already resolved.
 */
async function runInChild(script: string, path: string): Promise<ChildResult> {
  const child = Bun.spawn({
    cmd: ['bun', '-e', script],
    env: {
      ...process.env,
      OWNER_LOCK_MODULE: join(import.meta.dir, 'owner-lock.ts'),
      PROCESS_IDENTITY_MODULE: join(import.meta.dir, 'process-identity.ts'),
      OWNER_LOCK_PATH: path,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const exitCode = await child.exited;
  return { stdout: await stdout, stderr: await stderr, exitCode };
}

test('an injected backend never leaks into the real acquire path', async () => {
  // The stub symbol below always "succeeds", so a leaked one would admit the
  // second owner the kernel must refuse.
  const script = `
    const { assertOwnerLockBackend, acquireOwnerLock } = await import(process.env.OWNER_LOCK_MODULE);
    const { captureIdentity } = await import(process.env.PROCESS_IDENTITY_MODULE);
    await assertOwnerLockBackend(async () => () => 0);
    const first = {
      pid: process.pid,
      identity: captureIdentity(process.pid),
      sessionId: 'first',
      acquiredAt: new Date().toISOString(),
    };
    const acquired = await acquireOwnerLock(process.env.OWNER_LOCK_PATH, first);
    const foreign = { ...first, identity: { startTicks: (first.identity.startTicks ?? 0) + 1 } };
    const second = await acquireOwnerLock(process.env.OWNER_LOCK_PATH, foreign);
    console.log(acquired.acquired && !second.acquired ? 'CLEAN' : 'LEAKED');
    process.exit(0);
  `;

  const result = await runInChild(script, lockPath);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('CLEAN');
});

test('a failed gate in a cold process leaves the real acquire path working', async () => {
  // The boot order, in a child: the gate runs FIRST, on a cold cache, and the
  // first acquire follows. A gate that cached its failure would replay that
  // dead verdict at the acquire — the run would refuse to start for a reason
  // that was never true again. In a warm process the cache would hide it: the
  // symbol an earlier acquire resolved would answer instead.
  const script = `
    const { assertOwnerLockBackend, acquireOwnerLock } = await import(process.env.OWNER_LOCK_MODULE);
    const { captureIdentity } = await import(process.env.PROCESS_IDENTITY_MODULE);
    let failed = false;
    try {
      await assertOwnerLockBackend(async () => { throw new Error('no flock here'); });
    } catch (error) {
      failed = true;
    }
    if (!failed) {
      console.log('GATE-DID-NOT-FAIL');
      process.exit(0);
    }
    const claim = {
      pid: process.pid,
      identity: captureIdentity(process.pid),
      sessionId: 'after-failure',
      acquiredAt: new Date().toISOString(),
    };
    let verdict = 'POISONED';
    try {
      const result = await acquireOwnerLock(process.env.OWNER_LOCK_PATH, claim);
      verdict = result.acquired && result.created ? 'CLEAN' : 'POISONED';
    } catch (error) {
      verdict = 'POISONED';
    }
    console.log(verdict);
    process.exit(0);
  `;

  const result = await runInChild(script, lockPath);
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe('');
  expect(result.stdout.trim()).toBe('CLEAN');
});
