/**
 * Session post-verdict replay: stitches `findings.evidence`, records a
 * `skipped` step when there are no frames (or ffmpeg is absent), never
 * overturns the verdict, and never blocks teardown.
 *
 * Split out of `session.test.ts` (797+ LOC, over the 500-LOC cap) —
 * construction/inbox/close/start-loop lifecycle and snapshot/summarize live
 * in `session.test.ts` / `session.findings.test.ts`.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindingsStore } from './findings-store.js';
import { type ReplayOutcome, Session, type SessionAdapter } from './session.js';
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

// --- post-verdict replay -----------------------------------------------------

test('replay runs after the verdict and its path is recorded in findings.evidence', async () => {
  const store = makeStore();
  let replayCalled = false;
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    replay: async () => {
      replayCalled = true;
      return { kind: 'rendered', path: '/ws/sessions/s1/replay.mp4' };
    },
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  expect(session.status).toBe('passed');
  expect(replayCalled).toBe(true);
  expect((await store.readFindings()).evidence).toBe('/ws/sessions/s1/replay.mp4');
});

test('replay skipped with no note (no frames) leaves findings.evidence and steps untouched', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    replay: async () => ({ kind: 'skipped' }),
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  expect(session.status).toBe('passed');
  const findings = await store.readFindings();
  expect(findings.evidence).toBeUndefined();
  expect(findings.steps).toEqual([]); // a silent skip adds no note
});

test('replay skipped with a note (e.g. ffmpeg absent) records a skipped (not failed) step, no evidence', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    replay: async () => ({ kind: 'skipped', note: "ffmpeg not found ('ffmpeg')" }),
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({
      status: 'passed',
      steps: [{ step: 'open', ok: true }],
      bugs: [],
      visual: [],
    });
  });

  expect(session.status).toBe('passed'); // the verdict stands — a missing video never overturns it
  const findings = await store.readFindings();
  expect(findings.evidence).toBeUndefined(); // nothing was stitched
  expect(findings.steps).toEqual([
    { step: 'open', ok: true }, // the driver's trail is preserved
    // A missing ffmpeg is a SKIP, not a failure — ok stays true so the run
    // doesn't read as broken; skipped + note explain the absent replay.mp4.
    { step: 'replay video', ok: true, skipped: true, note: "ffmpeg not found ('ffmpeg')" },
  ]);
});

test('a replay failure does not block teardown and never overturns the verdict (fail-soft)', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    replay: async () => {
      throw new Error('ffmpeg not found');
    },
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  expect(session.status).toBe('passed');
  expect((await store.readFindings()).evidence).toBeUndefined();
});

test('replay write-back preserves a summary written just before it', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    summarize: async () => 'one glitch on the login page',
    replay: async () => ({ kind: 'rendered', path: '/ws/replay.mp4' }),
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  const findings = await store.readFindings();
  expect(findings.summary).toBe('one glitch on the login page');
  expect(findings.evidence).toBe('/ws/replay.mp4');
});

test('replay records evidence under the terminal status, not a stale running record', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    replay: async () => ({ kind: 'rendered', path: '/ws/replay.mp4' }),
  });

  // Driver leaves the record on `running` — `#verdict()` settles `failed`.
  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'running', steps: [], bugs: [], visual: [] });
  });

  const findings = await store.readFindings();
  expect(findings.status).toBe('failed'); // settled terminal, not the stale `running`
  expect(findings.evidence).toBe('/ws/replay.mp4');
});

test('close is not blocked by a hung replay (teardown wins the abort race)', async () => {
  const store = makeStore();
  let enterReplay: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enterReplay = resolve;
  });
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
    replay: () => {
      enterReplay();
      return new Promise<ReplayOutcome>(() => undefined); // never settles — a hung ffmpeg
    },
  });

  session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  await entered; // the run is now parked awaiting the hung stitch
  await session.close(); // must return — the abort short-circuits the replay wait

  expect(session.status).toBe('passed');
  expect((await store.readFindings()).evidence).toBeUndefined(); // hung replay never written
});

test('no evidence is recorded when no replay step is wired', async () => {
  const store = makeStore();
  const session = new Session({
    id: 's1',
    story: 'x',
    adapter: new FakeAdapter(),
    findingsStore: store,
  });

  await session.start(async (ctx) => {
    await ctx.progress.writeFindings({ status: 'passed', steps: [], bugs: [], visual: [] });
  });

  expect(session.status).toBe('passed');
  expect((await store.readFindings()).evidence).toBeUndefined();
});
