import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StateFile } from '../session/state-file.js';
import { readState, writeState } from '../session/state-file.js';
import { workspacePaths } from '../session/workspace.js';
import { runStatus, runStop } from './control.js';

let cwd: string;
const logs: string[] = [];
const origLog = console.log;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cli-'));
  logs.length = 0;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
  };
});
afterEach(async () => {
  console.log = origLog;
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
  expect(out).toContain('not running'); // bogus pid is not alive
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
