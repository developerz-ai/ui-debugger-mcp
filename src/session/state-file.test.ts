import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBusyError } from '../errors.js';
import { ownerLockPath } from './owner-lock.js';
import { captureIdentity } from './process-identity.js';
import type { StateFile } from './state-file.js';
import {
  FileStatePort,
  markStatus,
  readState,
  restoreRunning,
  StateFileSchema,
  type StateIo,
  writeState,
} from './state-file.js';
import { workspacePaths } from './workspace.js';

let dir: string;
/** Live child processes spawned by the ownership tests — killed after each case. */
let children: ReturnType<typeof Bun.spawn>[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
  children = [];
});
afterEach(async () => {
  for (const child of children) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  await rm(dir, { recursive: true, force: true });
});

/**
 * A second LIVE pid, distinct from this process's.
 *
 * The ownership claim is decided by pid + process identity, so a test needs a
 * real second process — a dead pid would be reclaimed as stale, and a
 * fabricated one would not be provably alive. The child just sleeps; its pid is
 * all the test needs.
 */
function spawnLivePid(): number {
  const child = Bun.spawn({
    cmd: ['bun', '-e', 'await Bun.sleep(30_000)'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  children.push(child);
  return child.pid;
}

const SAMPLE: StateFile = {
  pid: 4242,
  sessionId: '1700000000000-0001',
  target: 'web',
  goal: 'check the signup flow',
  status: 'running',
  startedAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
  sessionDir: '/ws/proj/sessions/1700000000000-0001',
  identity: { startTicks: 987_654 },
};

test('writeState + readState round-trips', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, SAMPLE);
  expect(await readState(path)).toEqual(SAMPLE);
});

test('readState returns null when the file is absent', async () => {
  expect(await readState(join(dir, 'nope.json'))).toBeNull();
});

test('readState returns null on malformed json', async () => {
  const path = join(dir, 'state.json');
  await writeFile(path, '{ not json', 'utf8');
  expect(await readState(path)).toBeNull();
});

test('readState returns null when the shape fails the schema', async () => {
  const path = join(dir, 'state.json');
  await writeFile(path, JSON.stringify({ pid: 'x', sessionId: 1 }), 'utf8');
  expect(await readState(path)).toBeNull();
});

test('markStatus flips status + updatedAt in place, leaving identity intact', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, SAMPLE);
  await markStatus(path, 'stopped', new Date('2026-06-29T01:00:00.000Z'));
  const after = await readState(path);
  expect(after?.status).toBe('stopped');
  expect(after?.updatedAt).toBe('2026-06-29T01:00:00.000Z');
  expect(after?.sessionId).toBe(SAMPLE.sessionId);
});

test('markStatus preserves a terminal stopped when a later shutdown marks ended', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, { ...SAMPLE, status: 'stopped' });
  await markStatus(path, 'ended');
  expect((await readState(path))?.status).toBe('stopped');
});

test('writeState publishes atomically — the CLI never reads a torn state.json', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, SAMPLE);
  // Repeated + concurrent writes (server records, CLI marks) must leave exactly
  // one file: a shared temp name would litter the workspace or publish garbage.
  await Promise.all([
    writeState(path, { ...SAMPLE, status: 'ended' }),
    writeState(path, { ...SAMPLE, status: 'stopped' }),
    writeState(path, { ...SAMPLE, goal: 'other' }),
  ]);

  expect(await readdir(dir)).toEqual(['state.json']);
  expect(await readState(path)).not.toBeNull();
});

test('restoreRunning rolls a premature stopped back to running', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, { ...SAMPLE, status: 'stopped' });
  await restoreRunning(path, new Date('2026-06-29T03:00:00.000Z'));
  const after = await readState(path);
  expect(after?.status).toBe('running');
  expect(after?.updatedAt).toBe('2026-06-29T03:00:00.000Z');
  expect(after?.sessionId).toBe(SAMPLE.sessionId);
});

test('restoreRunning leaves a status it did not write (and a missing file) alone', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, { ...SAMPLE, status: 'ended' });
  await restoreRunning(path);
  expect((await readState(path))?.status).toBe('ended');

  const absent = join(dir, 'nope.json');
  await restoreRunning(absent);
  expect(await readState(absent)).toBeNull();
});

test('markStatus is a no-op when there is no state file', async () => {
  const path = join(dir, 'state.json');
  await markStatus(path, 'stopped');
  expect(await readState(path)).toBeNull();
});

test('FileStatePort.record writes a running breadcrumb with a derived sessionDir', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const port = new FileStatePort(ws, {
    pid: 99,
    now: () => new Date('2026-06-29T02:00:00.000Z'),
  });
  await port.record({ sessionId: '1700000000000-0007', target: 'web', goal: 'g' });

  const state = await readState(ws.stateJson);
  expect(state).toMatchObject({
    pid: 99,
    sessionId: '1700000000000-0007',
    target: 'web',
    status: 'running',
    startedAt: '2026-06-29T02:00:00.000Z',
  });
  expect(state?.sessionDir).toBe(join(ws.sessions, '1700000000000-0007'));
});

test('FileStatePort.record fails loud when the breadcrumb cannot be written', async () => {
  // Swallowed, this is the silent fallback that hurts most: `start_debug` hands
  // back a session id and Chrome runs, but `state.json` never exists — `status`
  // and `stop` both report "no debug run" and the only way to free the profile is
  // killing the server by hand. The service's teardown path depends on this throw.
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  await mkdir(join(dir, 'ws'), { recursive: true });
  await writeFile(ws.root, 'a file where the workspace dir belongs', 'utf8');
  const port = new FileStatePort(ws, { pid: 99 });

  await expect(port.record({ sessionId: 's', target: 'web', goal: 'g' })).rejects.toThrow();
});

test('FileStatePort.clear stays best-effort (the run is already down)', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const port = new FileStatePort(ws, { pid: 99 });
  // Nothing recorded, nothing writable — clearing must not throw into teardown.
  await port.clear('s');
});

test('FileStatePort.clear marks the run ended', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const port = new FileStatePort(ws, { pid: 99, now: () => new Date('2026-06-29T02:00:00.000Z') });
  await port.record({ sessionId: 's', target: 'web', goal: 'g' });
  await port.clear('s');
  expect((await readState(ws.stateJson))?.status).toBe('ended');
});

test('FileStatePort.clear is scoped to the ending run — a successor breadcrumb is never ended', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const port = new FileStatePort(ws, { pid: 99, now: () => new Date('2026-06-29T02:00:00.000Z') });
  await port.record({ sessionId: 'old', target: 'web', goal: 'done' });
  // A successor started while the old run's teardown was still in flight.
  await port.record({ sessionId: 'new', target: 'web', goal: 'next' });

  await port.clear('old'); // the late teardown clear

  // The successor the CLI `stop` reads stays live: status, id and goal untouched.
  expect(await readState(ws.stateJson)).toMatchObject({
    status: 'running',
    sessionId: 'new',
    goal: 'next',
  });
});

test('a record racing an in-flight clear queues behind it — the live successor survives', async () => {
  // The interleaving the id guard alone cannot survive: the teardown's clear
  // READS the old breadcrumb, a successor start records itself, and THEN the
  // clear's write publishes — the guard passed on the stale read, and the live
  // successor is overwritten with the old ended run, so `ui-debugger-mcp stop`
  // skips a run that is actually going. The workspace write queue must make the
  // successor's record wait out the clear's whole read-modify-write.
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const old: StateFile = {
    ...SAMPLE,
    pid: process.pid,
    identity: captureIdentity(process.pid),
    sessionId: 'old',
    goal: 'done',
    sessionDir: join(ws.sessions, 'old'),
  };
  let contents: string | undefined = `${JSON.stringify(old, null, 2)}\n`;
  // Park exactly ONE write — the clear's — mid-flight, deterministically (real-fs
  // timing could never pin this interleaving).
  let releaseFirstWrite: () => void = () => undefined;
  const firstWriteGate = new Promise<void>((resolve) => {
    releaseFirstWrite = resolve;
  });
  let writes = 0;
  const onDisk = (): StateFile | null =>
    contents === undefined ? null : StateFileSchema.parse(JSON.parse(contents));
  const io: StateIo = {
    async read() {
      return onDisk();
    },
    async write(_path, state) {
      writes += 1;
      if (writes === 1) await firstWriteGate;
      contents = `${JSON.stringify(state, null, 2)}\n`;
    },
  };
  const port = new FileStatePort(ws, { pid: process.pid, io });
  // The owner holds the workspace — otherwise the clear below would (rightly)
  // refuse to touch somebody else's breadcrumb.
  await mkdir(ws.root, { recursive: true });
  await writeFile(
    ownerLockPath(ws),
    `${JSON.stringify(
      {
        pid: process.pid,
        identity: captureIdentity(process.pid),
        sessionId: 'old',
        acquiredAt: '2026-06-29T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // The clear starts (and reads 'old'); the successor's record is issued while
  // that clear is still mid-flight.
  const clearing = port.clear('old');
  const recording = port.record({ sessionId: 'new', target: 'web', goal: 'next' });
  // Wait for the clear's write to actually START: the queue ahead of it does
  // real-fs reads (the ownership claim, the process identity) that do not
  // reliably beat a single tick under load. The record must still be parked
  // BEHIND that in-flight write.
  for (let waited = 0; writes === 0 && waited < 2000; waited += 5) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  expect(writes).toBe(1);
  expect(onDisk()).toMatchObject({ sessionId: 'old', status: 'running' });

  releaseFirstWrite(); // the clear publishes (old, ended)...
  await Promise.all([clearing, recording]); // ...then the queued record (new, running)

  expect(writes).toBe(2);
  // The successor the CLI `stop` must signal is the one left on disk.
  expect(onDisk()).toMatchObject({
    status: 'running',
    sessionId: 'new',
    goal: 'next',
  });
});

// --- foreignRun: the cross-process one-run gate -----------------------------

/** A workspace + port pair; `pid` is the *port's* own process id. */
function portFor(pid: number) {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  return { ws, port: new FileStatePort(ws, { pid }) };
}

test('foreignRun reports a running breadcrumb owned by another live server', async () => {
  // A different server's pid, alive and verifiable: this very process.
  const { ws, port } = portFor(1);
  await writeState(ws.stateJson, {
    ...SAMPLE,
    pid: process.pid,
    identity: captureIdentity(process.pid),
  });

  expect(await port.foreignRun()).toEqual({
    pid: process.pid,
    sessionId: SAMPLE.sessionId,
    sessionDir: SAMPLE.sessionDir,
  });
});

test('foreignRun ignores our own breadcrumb (the in-process gate owns that case)', async () => {
  const { ws, port } = portFor(process.pid);
  await writeState(ws.stateJson, {
    ...SAMPLE,
    pid: process.pid,
    identity: captureIdentity(process.pid),
  });

  expect(await port.foreignRun()).toBeNull();
});

test('foreignRun ignores a dead server: a crashed run never wedges the project', async () => {
  const { ws, port } = portFor(1);
  // 999_999_999 is effectively never a live process — the stale `running` file
  // a SIGKILLed server leaves behind.
  await writeState(ws.stateJson, { ...SAMPLE, pid: 999_999_999 });

  expect(await port.foreignRun()).toBeNull();
});

test('foreignRun ignores a recycled PID (live, but not our server)', async () => {
  const { ws, port } = portFor(1);
  const ticks = captureIdentity(process.pid).startTicks;
  if (ticks === null) return; // non-Linux: no fingerprint to mismatch
  await writeState(ws.stateJson, {
    ...SAMPLE,
    pid: process.pid,
    identity: { startTicks: ticks + 1 },
  });

  expect(await port.foreignRun()).toBeNull();
});

test('foreignRun ignores terminal breadcrumbs and a missing state file', async () => {
  const { ws, port } = portFor(1);
  expect(await port.foreignRun()).toBeNull(); // nothing recorded yet

  const live = { ...SAMPLE, pid: process.pid, identity: captureIdentity(process.pid) };
  await writeState(ws.stateJson, { ...live, status: 'ended' });
  expect(await port.foreignRun()).toBeNull();
  await writeState(ws.stateJson, { ...live, status: 'stopped' });
  expect(await port.foreignRun()).toBeNull();
});

test('the written file is valid pretty JSON ending in a newline', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, SAMPLE);
  const raw = await readFile(path, 'utf8');
  expect(raw.endsWith('}\n')).toBe(true);
  expect(JSON.parse(raw)).toEqual(SAMPLE);
});

// --- exclusive admission: the workspace ownership claim ----------------------

test('a second port with a distinct LIVE pid is refused — the owner keeps the workspace', async () => {
  // The defect this closes: `record()` used to be an unconditional overwrite.
  // Two servers starting inside the same launch window both read "no foreign
  // run" and both wrote, so the second write hid the first owner's live run
  // from `status`/`stop` — the owner's browser became invisible.
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const ownerPid = process.pid;
  const otherPid = spawnLivePid();
  const owner = new FileStatePort(ws, { pid: ownerPid });
  const other = new FileStatePort(ws, { pid: otherPid });

  await owner.record({ sessionId: 'owner-run', target: 'web', goal: 'first' });
  const claimBefore = await readFile(ownerLockPath(ws), 'utf8');

  // The second server is refused — loudly, naming the owner.
  const failure = await other
    .record({ sessionId: 'other-run', target: 'web', goal: 'second' })
    .catch((err: unknown) => err);
  expect(failure).toBeInstanceOf(SessionBusyError);
  const message = (failure as SessionBusyError).message;
  expect(message).toContain(`pid ${ownerPid}`);
  expect(message).toContain('owner-run');
  expect(message).toContain('ui-debugger-mcp stop');

  // The owner's live run is untouched — still visible to the CLI.
  expect(await readState(ws.stateJson)).toMatchObject({
    pid: ownerPid,
    sessionId: 'owner-run',
    status: 'running',
  });
  // …and the owner's claim was not stolen.
  expect(await readFile(ownerLockPath(ws), 'utf8')).toBe(claimBefore);
});

test('a claim left behind by a dead owner is reclaimed — a crashed server never wedges the project', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  await mkdir(ws.root, { recursive: true });
  // A claim whose holder is dead (a SIGKILLed server) — the pid is not alive.
  await writeFile(
    ownerLockPath(ws),
    `${JSON.stringify(
      { pid: 999_999_999, identity: { startTicks: 1 }, sessionId: 'crashed', acquiredAt: 'x' },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const port = new FileStatePort(ws, { pid: process.pid });
  await port.record({ sessionId: 'fresh-run', target: 'web', goal: 'go' });

  expect(await readState(ws.stateJson)).toMatchObject({
    sessionId: 'fresh-run',
    status: 'running',
  });
  const claim = JSON.parse(await readFile(ownerLockPath(ws), 'utf8'));
  expect(claim.pid).toBe(process.pid); // the claim now names us
});

test("a non-owner clear() leaves the owner's claim AND its running breadcrumb untouched", async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const owner = new FileStatePort(ws, { pid: process.pid });
  const other = new FileStatePort(ws, { pid: spawnLivePid() });

  await owner.record({ sessionId: 'owner-run', target: 'web', goal: 'first' });
  const claimBefore = await readFile(ownerLockPath(ws), 'utf8');

  // The stranger tries to end the owner's run.
  await other.clear('owner-run');

  expect(await readState(ws.stateJson)).toMatchObject({
    sessionId: 'owner-run',
    status: 'running',
  });
  expect(await readFile(ownerLockPath(ws), 'utf8')).toBe(claimBefore);
});

test("a non-owner whose session id MATCHES the owner's still cannot end that owner's run", async () => {
  // The session id is NOT proof of ownership: two processes mint the same id in
  // the same second (`YYYY-MM-DD_HH-MM-SS-NNNN` has a per-PROCESS counter), so
  // a matching id must not be enough to end somebody else's live run.
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const owner = new FileStatePort(ws, { pid: process.pid });
  const other = new FileStatePort(ws, { pid: spawnLivePid() });

  await owner.record({ sessionId: 'shared-id', target: 'web', goal: 'first' });
  const claimBefore = await readFile(ownerLockPath(ws), 'utf8');

  await other.clear('shared-id'); // the SAME id the owner's run is recorded under

  expect(await readState(ws.stateJson)).toMatchObject({
    sessionId: 'shared-id',
    status: 'running',
  });
  expect(await readFile(ownerLockPath(ws), 'utf8')).toBe(claimBefore);
});

test("the owner's own clear() ends the run and releases the claim", async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const owner = new FileStatePort(ws, { pid: process.pid });

  await owner.record({ sessionId: 'owner-run', target: 'web', goal: 'first' });
  expect(existsSync(ownerLockPath(ws))).toBe(true);

  await owner.clear('owner-run');

  expect((await readState(ws.stateJson))?.status).toBe('ended');
  // The claim is given back — the project is free for the next server.
  expect(existsSync(ownerLockPath(ws))).toBe(false);
});

test('a failed second record does not release the claim held by the first record', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  let writes = 0;
  const io: StateIo = {
    async read() {
      return null;
    },
    async write() {
      writes += 1;
      if (writes === 2) throw new Error('breadcrumb write failed');
    },
  };
  const port = new FileStatePort(ws, { pid: process.pid, io });

  await port.record({ sessionId: 'first-run', target: 'web', goal: 'first' });
  await expect(
    port.record({ sessionId: 'second-run', target: 'web', goal: 'second' }),
  ).rejects.toThrow('breadcrumb write failed');

  // The first record still owns the workspace: a failed successor write must
  // not hand the live claim away.
  expect(existsSync(ownerLockPath(ws))).toBe(true);
  const claim = JSON.parse(await readFile(ownerLockPath(ws), 'utf8'));
  expect(claim.pid).toBe(process.pid);
});

test('a failing breadcrumb write during teardown still releases the claim', async () => {
  // markStatus throwing inside clear() used to be swallowed BEFORE the claim
  // was released: an ended run kept a live-process claim, so every other
  // server was refused the workspace until this one exited — with no run left
  // to end. The release runs in a finally, once the ending session is
  // confirmed ours.
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  await mkdir(ws.root, { recursive: true });
  await writeFile(
    ownerLockPath(ws),
    `${JSON.stringify(
      {
        pid: process.pid,
        identity: captureIdentity(process.pid),
        sessionId: 'owner-run',
        acquiredAt: '2026-06-29T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const prior: StateFile = {
    ...SAMPLE,
    pid: process.pid,
    identity: captureIdentity(process.pid),
    sessionId: 'owner-run',
    sessionDir: join(ws.sessions, 'owner-run'),
  };
  const io: StateIo = {
    async read() {
      return prior;
    },
    async write() {
      throw new Error('breadcrumb write failed');
    },
  };
  const port = new FileStatePort(ws, { pid: process.pid, io });

  // Teardown stays best-effort — it must not throw into the close path…
  await port.clear('owner-run');

  // …and the claim must be given back even though the write threw.
  expect(existsSync(ownerLockPath(ws))).toBe(false);
});

test('a breadcrumb written without a claim still publishes', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const port = new FileStatePort(ws, { pid: process.pid });

  // The CLI `stop` writes a terminal breadcrumb directly, without taking the
  // workspace claim. The state file must still be readable afterwards.
  await writeState(ws.stateJson, {
    ...SAMPLE,
    pid: process.pid,
    identity: captureIdentity(process.pid),
    status: 'stopped',
  });

  expect(await readState(ws.stateJson)).toMatchObject({ status: 'stopped' });
  await port.clear(SAMPLE.sessionId);
  expect(await readState(ws.stateJson)).toMatchObject({ status: 'stopped' });
});

test('record() by the owner twice is re-entrant — the second record keeps the claim', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const owner = new FileStatePort(ws, { pid: process.pid });

  await owner.record({ sessionId: 'first-run', target: 'web', goal: 'first' });
  await owner.record({ sessionId: 'second-run', target: 'web', goal: 'second' });

  expect(await readState(ws.stateJson)).toMatchObject({
    sessionId: 'second-run',
    status: 'running',
  });
  // Still ours — the re-entrant acquire did not hand the workspace away.
  const claim = JSON.parse(await readFile(ownerLockPath(ws), 'utf8'));
  expect(claim.pid).toBe(process.pid);
});
