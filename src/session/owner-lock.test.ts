import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { acquireOwnerLock, type OwnerLock, ownerLockPath, releaseOwnerLock } from './owner-lock.js';
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
