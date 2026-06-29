import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StateFile } from './state-file.js';
import { FileStatePort, markStatus, readState, writeState } from './state-file.js';
import { workspacePaths } from './workspace.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const SAMPLE: StateFile = {
  pid: 4242,
  sessionId: '1700000000000-0001',
  target: 'web',
  goal: 'check the signup flow',
  status: 'running',
  startedAt: '2026-06-29T00:00:00.000Z',
  updatedAt: '2026-06-29T00:00:00.000Z',
  sessionDir: '/ws/proj/sessions/1700000000000-0001',
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

test('FileStatePort.clear marks the run ended', async () => {
  const ws = workspacePaths(join(dir, 'proj'), join(dir, 'ws'));
  const port = new FileStatePort(ws, { pid: 99, now: () => new Date('2026-06-29T02:00:00.000Z') });
  await port.record({ sessionId: 's', target: 'web', goal: 'g' });
  await port.clear();
  expect((await readState(ws.stateJson))?.status).toBe('ended');
});

test('the written file is valid pretty JSON ending in a newline', async () => {
  const path = join(dir, 'state.json');
  await writeState(path, SAMPLE);
  const raw = await readFile(path, 'utf8');
  expect(raw.endsWith('}\n')).toBe(true);
  expect(JSON.parse(raw)).toEqual(SAMPLE);
});
