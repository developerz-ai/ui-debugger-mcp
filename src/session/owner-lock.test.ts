import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  const stale = owner(999_999_999, 'crashed');
  await writeFile(lockPath, `${JSON.stringify(stale, null, 2)}\n`, 'utf8');

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

test('a claim whose pid was recycled is reclaimed', async () => {
  const recycled = owner(process.pid, 'recycled');
  recycled.identity = { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 };
  await writeFile(lockPath, `${JSON.stringify(recycled, null, 2)}\n`, 'utf8');

  const current = owner(process.pid, 'successor');
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toEqual(current);
});

test('release refuses to remove another owner claim and leaves it intact', async () => {
  const holder = owner(process.pid, 'holder');
  await writeFile(lockPath, `${JSON.stringify(holder, null, 2)}\n`, 'utf8');

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
  const modulePath = join(import.meta.dir, 'owner-lock.ts');
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
      console.log('ACQUIRED');
      await Bun.sleep(300);
      process.exit(0);
    }
    console.log('BUSY');
    process.exit(0);
  `;
  const env = {
    ...process.env,
    OWNER_LOCK_MODULE: modulePath,
    PROCESS_IDENTITY_MODULE: join(import.meta.dir, 'process-identity.ts'),
    OWNER_LOCK_PATH: lockPath,
  };
  const children = ['child-a', 'child-b'].map((sessionId) =>
    Bun.spawn({
      cmd: ['bun', '-e', script],
      env: { ...env, CHILD_SESSION_ID: sessionId },
      stdout: 'pipe',
      stderr: 'pipe',
    }),
  );
  const outputs = await Promise.all(
    children.map(async (child) => {
      const stdout = new Response(child.stdout).text();
      const stderr = new Response(child.stderr).text();
      const exitCode = await child.exited;
      return { stdout: await stdout, stderr: await stderr, exitCode };
    }),
  );

  for (const output of outputs) {
    expect(output.exitCode).toBe(0);
    expect(output.stderr).toBe('');
  }
  const results = outputs.map((output) => output.stdout.trim());
  expect(results.filter((result) => result === 'ACQUIRED')).toHaveLength(1);
  expect(results.filter((result) => result === 'BUSY')).toHaveLength(1);

  const current = owner();
  expect(await acquireOwnerLock(lockPath, current)).toEqual({ acquired: true, created: true });
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
