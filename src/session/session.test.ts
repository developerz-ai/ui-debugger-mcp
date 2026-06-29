import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Findings } from '../findings/schema.js';
import { FindingsStore } from './findings-store.js';
import { SessionManager } from './manager.js';
import { Session, type SessionAdapter } from './session.js';
import { sessionPaths, workspacePaths } from './workspace.js';

/** Adapter stub that records how many times it was closed. */
class FakeAdapter implements SessionAdapter {
  closeCalls = 0;
  async close(): Promise<void> {
    this.closeCalls += 1;
  }
}

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-session-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** A real FindingsStore rooted in the test's temp dir. */
function makeStore(id = 'sess-1'): FindingsStore {
  return new FindingsStore(sessionPaths(workspacePaths('/project/app', tmpDir), id));
}

function makeSession(): Session<FakeAdapter> {
  return new Session({
    id: 's1',
    story: 'log in and buy item 3',
    adapter: new FakeAdapter(),
    findingsStore: makeStore(),
  });
}

// --- construction -----------------------------------------------------------

test('holds identity and defaults status to running with an empty inbox', () => {
  const session = new Session({
    id: 's1',
    story: 'log in and buy item 3',
    criteria: 'cart shows 1 item',
    adapter: new FakeAdapter(),
    findingsStore: makeStore(),
  });
  expect(session.id).toBe('s1');
  expect(session.story).toBe('log in and buy item 3');
  expect(session.criteria).toBe('cart shows 1 item');
  expect(session.status).toBe('running');
  expect(session.inbox).toEqual([]);
});

test('criteria is optional', () => {
  expect(makeSession().criteria).toBeUndefined();
});

// --- pushMessage / inbox ----------------------------------------------------

test('pushMessage enqueues messages in order', () => {
  const session = makeSession();
  session.pushMessage('also check mobile');
  session.pushMessage('skip checkout, login is the bug');
  expect(session.inbox).toEqual(['also check mobile', 'skip checkout, login is the bug']);
});

test('inbox getter returns a defensive copy', () => {
  const session = makeSession();
  session.pushMessage('one');
  (session.inbox as string[]).push('two');
  expect(session.inbox).toEqual(['one']);
});

// --- snapshot ---------------------------------------------------------------

test('snapshot returns an empty running verdict before any findings exist', async () => {
  const snap = await makeSession().snapshot();
  expect(snap).toEqual({ status: 'running', steps: [], bugs: [], visual: [] });
});

test('snapshot returns the persisted findings body', async () => {
  const store = makeStore();
  const findings: Findings = {
    status: 'failed',
    steps: [{ step: 'open', ok: true }],
    bugs: [{ kind: 'console', detail: 'TypeError: x is undefined' }],
    visual: [],
    summary: 'login crashes',
  };
  await store.writeFindings(findings);
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  const snap = await session.snapshot();
  expect(snap.steps).toEqual([{ step: 'open', ok: true }]);
  expect(snap.bugs).toEqual([{ kind: 'console', detail: 'TypeError: x is undefined' }]);
  expect(snap.summary).toBe('login crashes');
});

test('snapshot overlays the live session status over the persisted one', async () => {
  const store = makeStore();
  await store.writeFindings({ status: 'failed', steps: [], bugs: [], visual: [] });
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });
  // No agent has run yet, so the live status is still `running` and wins over disk.
  expect((await session.snapshot()).status).toBe('running');
});

test('snapshot projects only the requested fields', async () => {
  const store = makeStore();
  await store.writeFindings({
    status: 'passed',
    steps: [],
    bugs: [{ kind: 'flow', detail: 'dead button' }],
    visual: [],
    summary: 'all good',
  });
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  const snap = await session.snapshot(['status', 'summary']);
  expect(snap).toEqual({ status: 'running', summary: 'all good' });
  expect('bugs' in snap).toBe(false);
});

test('snapshot with an empty fields list returns the whole verdict', async () => {
  const snap = await makeSession().snapshot([]);
  expect(snap).toEqual({ status: 'running', steps: [], bugs: [], visual: [] });
});

// --- close / manager integration --------------------------------------------

test('close releases the adapter', async () => {
  const adapter = new FakeAdapter();
  const session = new Session({ id: 's1', story: 'x', adapter, findingsStore: makeStore() });
  await session.close();
  expect(adapter.closeCalls).toBe(1);
});

test('a Session works as a ManagedSession in the SessionManager', async () => {
  const manager = new SessionManager<Session<FakeAdapter>>();
  const adapter = new FakeAdapter();
  const session = new Session({ id: 's1', story: 'x', adapter, findingsStore: makeStore() });

  manager.start('/project/app', session);
  expect(manager.get('/project/app')).toBe(session);

  await manager.end('/project/app');
  expect(adapter.closeCalls).toBe(1); // manager.end → session.close → adapter.close
  expect(manager.has('/project/app')).toBe(false);
});
