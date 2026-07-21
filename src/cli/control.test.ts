import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Findings } from '../findings/schema.js';
import { captureIdentity } from '../session/process-identity.js';
import type { StateFile } from '../session/state-file.js';
import { readState, writeState } from '../session/state-file.js';
import { workspacePaths } from '../session/workspace.js';
import { runStatus, runStop } from './control.js';

let cwd: string;
const logs: string[] = [];
const origLog = console.log;
let priorExitCode: number | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cli-'));
  logs.length = 0;
  priorExitCode = process.exitCode as number | undefined;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
  };
});
afterEach(async () => {
  console.log = origLog;
  // `runStop` reports failure by setting `process.exitCode` — a process-global the
  // test runner reads at the end, so a leak here fails the whole suite with 0 fails.
  // `?? 0` matters: Bun ignores an `undefined` assignment, so restoring the (usually
  // undefined) prior value directly would leave the 1 in place.
  process.exitCode = priorExitCode ?? 0;
  await rm(cwd, { recursive: true, force: true });
});

/** Seed a state.json in the (default) workspace for this cwd. */
async function seedState(overrides: Partial<StateFile> = {}): Promise<string> {
  const ws = workspacePaths(cwd); // no config → DEFAULT_WORKSPACE under cwd
  await mkdir(ws.root, { recursive: true });
  const state: StateFile = {
    pid: 999_999_999, // a pid that is essentially never alive
    sessionId: '1700000000000-0001',
    target: 'web',
    goal: 'check the page',
    status: 'running',
    startedAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    sessionDir: join(ws.sessions, '1700000000000-0001'),
    identity: { startTicks: 1 },
    ...overrides,
  };
  await writeState(ws.stateJson, state);
  return ws.stateJson;
}

test('status reports no run when there is no state file', async () => {
  await runStatus(cwd);
  expect(logs.join('\n')).toContain('no debug run recorded');
});

test('status prints the run identity + a dead-server line', async () => {
  await seedState();
  await runStatus(cwd);
  const out = logs.join('\n');
  expect(out).toContain('1700000000000-0001');
  expect(out).toContain('target:   web');
  expect(out).toContain('unknown (server died)'); // state says running but pid is not alive
});

test('status reports real findings counts from a written findings.json', async () => {
  const stateJson = await seedState(); // status: 'running', server dead
  const state = await readState(stateJson);
  if (!state) throw new Error('seedState did not write a readable state.json');
  await mkdir(state.sessionDir, { recursive: true });
  const findings: Findings = {
    status: 'passed',
    steps: [{ step: 'open', ok: true }],
    bugs: [{ kind: 'flow', detail: 'dead button' }],
    visual: [],
    summary: 'one bug found',
  };
  await writeFile(join(state.sessionDir, 'findings.json'), JSON.stringify(findings), 'utf8');

  await runStatus(cwd);
  const out = logs.join('\n');
  expect(out).toContain('1 bugs, 0 visual, 1 steps');
});

test('stop reports nothing to do when there is no state', async () => {
  await runStop(cwd);
  expect(logs.join('\n')).toContain('no active debug run to stop');
});

test('stop on a dead server marks the run stopped', async () => {
  const stateJson = await seedState();
  await runStop(cwd);
  expect(logs.join('\n')).toContain('not running');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('stop on an already-ended run neither signals nor rewrites the terminal status', async () => {
  // The pid is our own live process: before the guard, `stop` would SIGTERM the
  // healthy idle server and relabel `ended` → `stopped`.
  const stateJson = await seedState({ status: 'ended', pid: process.pid });
  await runStop(cwd);
  const out = logs.join('\n');
  expect(out).toContain('no active debug run to stop');
  expect(out).toContain("'1700000000000-0001' ended");
  expect((await readState(stateJson))?.status).toBe('ended'); // terminal state preserved
});

test('stop on an already-stopped run is a no-op', async () => {
  const stateJson = await seedState({ status: 'stopped' });
  await runStop(cwd);
  expect(logs.join('\n')).toContain('no active debug run to stop');
  expect(logs.join('\n')).toContain("'1700000000000-0001' stopped");
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('stop with a stale PID marks run stopped without signaling', async () => {
  // Requires /proc — Linux-only. On other platforms verifyIdentity returns 'unverifiable'
  // and would fall back to isAlive(process.pid) = true, then try to SIGTERM us.
  if (process.platform !== 'linux') return;

  // Use our own PID (alive) but a wrong startTicks (1) so verifyIdentity returns 'stale'.
  const stateJson = await seedState({ pid: process.pid, identity: { startTicks: 1 } });
  await runStop(cwd);
  const out = logs.join('\n');
  expect(out).toContain('without signaling');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

// --- stop-vs-end ordering ---------------------------------------------------

/** A live, verifiable owner: this very process. */
function liveOwner(): Partial<StateFile> {
  return { pid: process.pid, identity: captureIdentity(process.pid) };
}

test('stop records `stopped` before the signal reaches the server', async () => {
  const stateJson = await seedState(liveOwner());
  // The server's SIGTERM handler marks `ended` via a read-modify-write; it can
  // only preserve `stopped` if the mark is already on disk when the signal lands.
  let statusAtSignal: string | undefined;
  const kill = () => {
    statusAtSignal = JSON.parse(readFileSync(stateJson, 'utf8')).status;
  };

  await runStop(cwd, kill);

  expect(statusAtSignal).toBe('stopped');
  expect(logs.join('\n')).toContain('SIGTERM');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('a failed signal rolls the mark back — a live run is never reported stopped', async () => {
  const stateJson = await seedState(liveOwner());
  const kill = () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };

  try {
    await runStop(cwd, kill);
  } finally {
    console.error = origError;
  }

  expect(errors.join('\n')).toContain('failed to signal server');
  expect(process.exitCode).toBe(1); // the CLI must exit non-zero on a failed stop
  expect((await readState(stateJson))?.status).toBe('running'); // teardown never started
});

test('stop still marks stopped when the server exited between check and signal', async () => {
  const stateJson = await seedState(liveOwner());
  const kill = () => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };

  await runStop(cwd, kill);

  expect(logs.join('\n')).toContain('already exited');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('status shows PID-reused line when identity is stale', async () => {
  if (process.platform !== 'linux') return;

  await seedState({ pid: process.pid, identity: { startTicks: 1 } });
  await runStatus(cwd);
  expect(logs.join('\n')).toContain('PID reused');
});
