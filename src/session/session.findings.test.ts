/**
 * Session findings projection: `snapshot` (fields projection, live-status
 * overlay, long-poll `wait`) and post-verdict `summarize`.
 *
 * Split out of `session.test.ts` (797+ LOC, over the 500-LOC cap) — construction/
 * inbox/close/start-loop lifecycle stays there; post-verdict replay lives in
 * `session.replay.test.ts`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Findings } from '../findings/schema.js';
import { FindingsStore } from './findings-store.js';
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

// --- snapshot long-poll (wait) ----------------------------------------------

test('snapshot(wait) long-polls until the run settles its verdict', async () => {
  const session = makeSession();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = session.start(async (ctx) => {
    await gate;
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      summary: 'done',
    });
  });

  // Settle the loop mid-poll; a generous timeout proves the call waited for it.
  setTimeout(release, 10);
  const snap = await session.snapshot(undefined, 1000);
  expect(snap.status).toBe('passed');
  expect(snap.summary).toBe('done');
  await run;
});

test('snapshot(wait) returns the in-flight snapshot when no verdict lands in time', async () => {
  const session = makeSession();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markWritten: () => void = () => undefined;
  const written = new Promise<void>((resolve) => {
    markWritten = resolve;
  });
  const run = session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'running',
      steps: [{ step: 'typed email', ok: true }],
      bugs: [],
      visual: [],
    });
    markWritten();
    await gate; // never settles before the poll times out
  });

  await written;
  const snap = await session.snapshot(undefined, 20);
  expect(snap.status).toBe('running'); // timed out, not settled
  expect(snap.steps).toEqual([{ step: 'typed email', ok: true }]);

  release();
  await run;
});

test('snapshot(wait) returns at once when the run already settled', async () => {
  const session = makeSession();
  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'failed',
      steps: [],
      bugs: [{ kind: 'flow', detail: 'dead button' }],
      visual: [],
    });
  });
  // Already settled — a large timeout must not block.
  const snap = await session.snapshot(undefined, 5000);
  expect(snap.status).toBe('failed');
});

test('snapshot(wait) returns at once when the run was never started', async () => {
  // No loop running, so the status can never change — do not hang on the timeout.
  const snap = await makeSession().snapshot(undefined, 5000);
  expect(snap).toEqual({ status: 'running', steps: [], bugs: [], visual: [] });
});

test('snapshot(fields, wait) projects fields after long-polling for the verdict', async () => {
  const session = makeSession();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = session.start(async (ctx) => {
    await gate;
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      summary: 'all green',
    });
  });

  setTimeout(release, 10);
  const snap = await session.snapshot(['status', 'summary'], 1000);
  expect(snap).toEqual({ status: 'passed', summary: 'all green' });
  expect('bugs' in snap).toBe(false);
  await run;
});

// --- post-verdict summarize --------------------------------------------------

test('summarize is called and its result written when the driver left summary empty', async () => {
  const store = makeStore();
  let summarizeCalled = false;
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    summarize: async (findings) => {
      summarizeCalled = true;
      expect(findings.status).toBe('passed'); // settled verdict passed in
      return 'one visual glitch on the login page';
    },
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      // no summary written by the driver
    });
  });

  expect(session.status).toBe('passed');
  expect(summarizeCalled).toBe(true);
  const findings = await store.readFindings();
  expect(findings.summary).toBe('one visual glitch on the login page');
  expect(findings.status).toBe('passed'); // status preserved in write-back
});

test('summarize is skipped when the driver already wrote a non-empty summary', async () => {
  const store = makeStore();
  let summarizeCalled = false;
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    summarize: async () => {
      summarizeCalled = true;
      return 'should not be called';
    },
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      summary: 'driver wrote this summary itself',
    });
  });

  expect(session.status).toBe('passed');
  expect(summarizeCalled).toBe(false);
  expect((await store.readFindings()).summary).toBe('driver wrote this summary itself');
});

test('summarize is not called when no summarizer is wired', async () => {
  const store = makeStore();
  // makeSession() wires no summarize option
  const session = makeSession();

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  expect(session.status).toBe('passed');
  // No summary written — the driver left it absent and we had no summarizer.
  expect((await store.tryReadFindings())?.summary).toBeUndefined();
});

test('a summarize failure does not block teardown (fail-soft)', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    summarize: async () => {
      throw new Error('summary model exploded');
    },
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  // Verdict stands; teardown was not blocked.
  expect(session.status).toBe('passed');
});

test('close is not blocked by a hung summary model (teardown wins the abort race)', async () => {
  const store = makeStore();
  let enterSummary: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enterSummary = resolve;
  });
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    summarize: () => {
      enterSummary();
      return new Promise<string>(() => undefined); // never settles — a hung model
    },
  });

  session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  await entered; // the run is now parked awaiting the hung summary
  await session.close(); // must return — the abort short-circuits the summary wait

  expect(session.status).toBe('passed'); // the verdict settled before the summary stalled
  expect((await store.readFindings()).summary).toBeUndefined(); // hung summary never written
});

test('summarize digests the terminal status, not a stale running record', async () => {
  const store = makeStore();
  let digestedStatus: Findings['status'] | undefined;
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    summarize: async (findings) => {
      digestedStatus = findings.status;
      return 'run failed before login';
    },
  });

  // Driver leaves the record on `running` (no terminal verdict) — `#verdict()` settles `failed`.
  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'running', steps: [], bugs: [], visual: [] });
  });

  expect(session.status).toBe('failed');
  expect(digestedStatus).toBe('failed'); // summarized the terminal verdict, not the stale `running`
  const findings = await store.readFindings();
  expect(findings.status).toBe('failed');
  expect(findings.summary).toBe('run failed before login');
});
