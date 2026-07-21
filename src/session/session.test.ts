/**
 * Session core: construction, inbox, close/manager integration, and the
 * background loop lifecycle (start, crash handling, abort).
 *
 * Split out of a single 797+ LOC `session.test.ts` (the 500-LOC cap) — snapshot
 * projection/long-poll + post-verdict summarize live in `session.findings.test.ts`;
 * post-verdict replay lives in `session.replay.test.ts`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentError } from '../errors.js';
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

// --- start / background loop -------------------------------------------------

test('start runs the loop in the background and settles passed from the written verdict', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [{ step: 'open', ok: true }],
      bugs: [],
      visual: [],
      summary: 'all good',
    });
  });

  expect(session.status).toBe('passed');
  expect((await session.snapshot()).summary).toBe('all good');
});

test('start settles failed when the loop writes a failed verdict', async () => {
  const session = makeSession();
  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'failed',
      steps: [],
      bugs: [{ kind: 'flow', detail: 'dead button' }],
      visual: [],
    });
  });
  expect(session.status).toBe('failed');
});

test('start settles failed when the loop ends without a terminal verdict (step cap)', async () => {
  const session = makeSession();
  await session.start(async () => undefined); // hit the step cap; never reported
  expect(session.status).toBe('failed');
});

test('the loop drains pushed messages through the inbox seam, clearing them', async () => {
  const session = makeSession();
  session.pushMessage('check mobile');
  session.pushMessage('skip login');

  let drained: readonly string[] = [];
  await session.start(async (ctx) => {
    drained = ctx.inbox.drain();
  });

  expect(drained).toEqual(['check mobile', 'skip login']);
  expect(session.inbox).toEqual([]); // the loop consumed the queue
});

test('the loop streams progress that snapshot reads while the run is in flight', async () => {
  const session = makeSession();
  let markWritten: () => void = () => undefined;
  const written = new Promise<void>((resolve) => {
    markWritten = resolve;
  });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const run = session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'running',
      steps: [{ step: 'typed email', ok: true }],
      bugs: [{ kind: 'console', detail: 'TypeError: cart is undefined' }],
      visual: [{ issue: 'total is cut off', where: 'cart footer', severity: 'high' }],
    });
    markWritten();
    await gate;
  });

  await written;
  const midRun = await session.snapshot();
  expect(midRun.status).toBe('running'); // still in flight
  expect(midRun.steps).toEqual([{ step: 'typed email', ok: true }]);
  // The streamed findings surface too — not just the step trail: a run that never
  // reaches `report` still hands the smart agent everything found so far.
  expect(midRun.bugs).toEqual([{ kind: 'console', detail: 'TypeError: cart is undefined' }]);
  expect(midRun.visual).toEqual([
    { issue: 'total is cut off', where: 'cart footer', severity: 'high' },
  ]);

  release();
  await run;
  expect(session.status).toBe('failed'); // ended without a terminal verdict
});

test('close aborts the in-flight loop, waits for it, then releases the adapter', async () => {
  const order: string[] = [];
  const adapter: SessionAdapter = {
    close: async () => {
      order.push('adapter');
    },
  };
  const store = makeStore();
  const session = new Session({ id: 's1', story: 'x', adapter, findingsStore: store });

  session.start(async (ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    order.push('loop');
    throw new AgentError('aborted by close');
  });

  await session.close();

  expect(order).toEqual(['loop', 'adapter']); // the loop settled before the adapter closed
  expect(session.status).toBe('failed'); // an aborted run never reached a verdict
  expect(await store.tryReadFindings()).toBeNull(); // abort is the verdict — nothing surfaced
});

test('close forces failed even if the loop resolves with a verdict after abort', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  // Loop observes the abort signal and resolves cleanly (no reject) after writing
  // a passing verdict — the race the guard closes.
  session.start(async (ctx) => {
    await new Promise<void>((resolve) => {
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      summary: 'all good',
    });
  });

  await session.close();

  expect(session.status).toBe('failed'); // aborted run settles failed, not the written verdict
});

test('an agent crash settles failed and surfaces the error (with its trail) into findings', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'running',
      steps: [{ step: 'opened', ok: true }],
      bugs: [],
      visual: [],
    });
    throw new AgentError('driver model timed out');
  });

  expect(session.status).toBe('failed');
  const findings = await store.readFindings();
  expect(findings.status).toBe('failed');
  expect(findings.steps).toEqual([{ step: 'opened', ok: true }]); // trail preserved
  expect(findings.summary).toContain('driver model timed out');
});

test('an agent crash after progress preserves prior evidence and appends to the prior summary', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'running',
      steps: [{ step: 'opened', ok: true }],
      bugs: [],
      visual: [],
      summary: 'checked out fine so far',
      evidence: 'sessions/s1/replay.mp4',
    });
    throw new AgentError('driver model timed out');
  });

  const findings = await store.readFindings();
  expect(findings.status).toBe('failed');
  expect(findings.evidence).toBe('sessions/s1/replay.mp4'); // not dropped
  expect(findings.summary).toBe(
    'checked out fine so far\nDebug run failed: driver model timed out',
  );
});

test('a non-AgentError crash is wrapped and surfaced into findings', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  await session.start(async () => {
    throw new Error('boom');
  });

  expect(session.status).toBe('failed');
  expect((await store.readFindings()).summary).toContain('boom');
});

test('start may be called only once', async () => {
  const session = makeSession();
  const run = session.start(async () => undefined);
  expect(() => session.start(async () => undefined)).toThrow(AgentError);
  await run;
});
