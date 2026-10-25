import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  type AcquireHooks,
  acquireOwnerLock,
  type OwnerLock,
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

/** The exact bytes a publish writes for a claim — byte comparisons use this. */
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
 * Race two REAL child processes against `acquireOwnerLock` on the same path.
 * Ownership is decided by pid + identity, so cross-process contention can only
 * be exercised by actual second processes — an in-process rival would share
 * this process's pid and read as re-entrant.
 */
async function contendViaChildren(
  path: string,
  sessionIds: [string, string],
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
    const result = await acquireOwnerLock(process.env.OWNER_LOCK_PATH, owner).catch(
      (err: unknown) => {
        // A contender whose attempts run out while the winner is still
        // mid-reclaim gets the loud busy error — that is a refusal too.
        if (err instanceof Error && err.name === 'SessionBusyError') {
          return { acquired: false, holder: null };
        }
        throw err;
      },
    );
    if (result.acquired) {
      // Stay alive until the rival has decided — its refusal needs our pid alive.
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
  expect(outcomes.filter((outcome) => outcome === 'BUSY')).toHaveLength(1);
}

test('a second acquire against a live foreign holder is refused and returns the holder', async () => {
  const first = owner(process.pid, 'first');
  expect(await acquireOwnerLock(lockPath, first)).toEqual({ acquired: true, created: true });

  const foreign = owner(process.pid, 'foreign');
  foreign.identity = { startTicks: (first.identity.startTicks ?? 0) + 1 };
  const result = await acquireOwnerLock(lockPath, foreign);

  expect(result.acquired).toBe(false);
  if (!result.acquired) expect(result.holder).toEqual(first);
});

test('acquire is re-entrant for the same pid and process identity', async () => {
  const first = owner();
  expect(await acquireOwnerLock(lockPath, first)).toEqual({ acquired: true, created: true });
  expect(await acquireOwnerLock(lockPath, first)).toEqual({ acquired: true, created: false });
});

test('a claim left by a dead pid is reclaimed', async () => {
  await seedClaim(lockPath, staleOwner('crashed'));

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

test('a claim whose pid was recycled is reclaimed', async () => {
  const recycled = owner(process.pid, 'recycled');
  recycled.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };
  await seedClaim(lockPath, recycled);

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

test('release refuses to remove another owner claim and leaves it intact', async () => {
  const holder = owner(process.pid, 'holder');
  await seedClaim(lockPath, holder);

  const foreign = owner(process.pid, 'foreign');
  foreign.identity = { startTicks: (holder.identity.startTicks ?? 0) + 1 };
  expect(await releaseOwnerLock(lockPath, foreign)).toBe(false);
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(holder);
});

test('release removes our own claim', async () => {
  const holder = owner();
  expect(await acquireOwnerLock(lockPath, holder)).toEqual({ acquired: true, created: true });
  expect(await releaseOwnerLock(lockPath, holder)).toBe(true);
  expect(await releaseOwnerLock(lockPath, holder)).toBe(false);
});

test('two real child processes contend: exactly one acquires and one is busy', async () => {
  const results = await contendViaChildren(lockPath, ['child-a', 'child-b']);
  expectExactlyOneAcquired(results);

  // The winner exited, so its claim is stale for us: a fresh acquire reclaims.
  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
});

test('two real child processes contend over a stale claim: exactly one reclaims it', async () => {
  // Both children read the same dead holder; each reclamation is a verified
  // rename, and only the first finds anything to move — the other gets ENOENT
  // and re-runs its publish against the winner's live claim. Exactly one owner.
  await seedClaim(lockPath, staleOwner('crashed'));
  const results = await contendViaChildren(lockPath, ['child-a', 'child-b']);
  expectExactlyOneAcquired(results);

  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
});

test('two real child processes contend over a stale claim and a stray pre-version mutex file: exactly one acquires', async () => {
  // `owner.lock.reclaim` was the old design's serialization mutex. It no
  // longer exists in the protocol; a leftover from a previous version is
  // litter — neither read nor removed by acquisition.
  await seedClaim(lockPath, staleOwner('crashed'));
  const litter = staleOwner('crashed-reclaimer');
  await seedClaim(`${lockPath}.reclaim`, litter);
  const results = await contendViaChildren(lockPath, ['child-a', 'child-b']);
  expectExactlyOneAcquired(results);
  expect(await readFile(`${lockPath}.reclaim`, 'utf8')).toBe(serialize(litter));

  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
});

test('a contender that observed a stale claim never unlinks a rival acquired after it', async () => {
  // The interleaving that used to double-acquire: B reads the dead holder; A
  // reclaims the same dead holder and publishes its live claim; B's blind
  // unlink then removed A's claim and B published into the hole — two owners,
  // and B's breadcrumb hid A's run from `status`/`stop`. The reclamation is
  // now a verified rename: B moves whatever is at the claim path and finds a
  // rival's live claim, not the bytes it judged — so it restores them and
  // refuses. The destructive act carries its own authorization; nothing that
  // happened after B's observation can make it remove the wrong bytes.
  await seedClaim(lockPath, staleOwner('crashed'));
  const rival = owner(process.pid, 'rival');
  const parked = owner(process.pid, 'parked');
  // A distinct (fabricated) identity: the parked contender must not read the
  // rival's claim as its own re-entrant acquire.
  parked.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };

  const hooks: AcquireHooks = {
    afterStaleObservation: async () => {
      // The rival completes a full acquire while B is parked between its
      // observation of the dead holder and its reclamation.
      expect(await acquireOwnerLock(lockPath, rival)).toEqual({ acquired: true, created: true });
    },
  };

  const result = await acquireOwnerLock(lockPath, parked, hooks);

  // B is refused — its rename landed on the rival's live claim.
  expect(result.acquired).toBe(false);
  if (!result.acquired) expect(result.holder).toEqual(rival);
  // The rival's claim survived B's reclaim attempt, verbatim.
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(rival);
  // And the reclamation left nothing behind.
  const leftovers = (await readdir(dirname(lockPath))).filter(
    (name) => name.includes('.reclaiming-') || name.includes('.reclaim'),
  );
  expect(leftovers).toEqual([]);
});

test('a reclaimer whose rename lands on a rival fresh claim restores it byte for byte and refuses', async () => {
  // The post-check interleaving forced directly: B judged the claim stale and
  // is parked at its destructive act; the slot changes hands under it (here a
  // live rival's claim is published into the path exactly as a rival that won
  // the reclaim race would); B's rename then moves the RIVAL's claim. Moving
  // is unconditional, but removal is not: the moved bytes are verified at the
  // private quarantine name, the rival's claim is restored byte for byte, and
  // B refuses instead of publishing into a hole it cut under a live owner.
  const crashed = staleOwner('crashed');
  await seedClaim(lockPath, crashed);

  const rival = owner(process.pid, 'fresh-owner'); // live: real identity
  const contender = owner(process.pid, 'contender');
  // A distinct (fabricated) identity: the contender must not read the
  // rival's claim as its own re-entrant acquire.
  contender.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };

  const hooks: AcquireHooks = {
    afterStaleObservation: async () => {
      // The slot changed hands while B was parked between its judgment and
      // its act: the path now holds a live rival's claim.
      await seedClaim(lockPath, rival);
    },
  };

  const result = await acquireOwnerLock(lockPath, contender, hooks);

  expect(result.acquired).toBe(false);
  if (!result.acquired) expect(result.holder).toEqual(rival);
  // The rival's claim survived B's reclamation, byte for byte.
  expect(await readFile(lockPath, 'utf8')).toBe(serialize(rival));
  // The verified rename left no quarantine copy behind.
  const leftovers = (await readdir(dirname(lockPath))).filter((name) =>
    name.includes('.reclaiming-'),
  );
  expect(leftovers).toEqual([]);
});

test('a reclaimer that crashed after moving the claim cannot wedge the workspace', async () => {
  // A reclaimer that died between the rename and the quarantine cleanup leaves
  // an EMPTY claim slot and a private quarantine file nobody reads. The next
  // contender simply publishes into the empty slot — no recovery, no mutex to
  // recover, nothing to worship.
  const stranded = staleOwner('crashed');
  const quarantine = `${lockPath}.reclaiming-999999-1`;
  await writeFile(quarantine, serialize(stranded), 'utf8');

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
  // The litter is not ours to clean; acquisition neither reads nor removes it.
  expect(await readFile(quarantine, 'utf8')).toBe(serialize(stranded));
});

test('a half-written claim is refused, not reclaimed as malformed', async () => {
  // A create-then-fill publish leaves an EMPTY claim visible to another
  // acquirer. It must never be mistaken for a stale malformed claim: the
  // first owner's claim stays intact and the second acquirer is refused.
  const handle = await open(lockPath, 'wx');
  await handle.writeFile('', 'utf8');
  await handle.close();
  const holder = owner(process.pid, 'first');

  const foreign = owner(process.pid, 'foreign');
  foreign.identity = { startTicks: (holder.identity.startTicks ?? 0) + 1 };
  const result = await acquireOwnerLock(lockPath, foreign).catch((err: unknown) => err);

  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain('empty');
  expect((result as Error).name).toBe('SessionBusyError');
  expect(await readFile(lockPath, 'utf8')).toBe('');
});
