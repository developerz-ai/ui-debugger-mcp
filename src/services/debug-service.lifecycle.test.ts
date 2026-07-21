/**
 * Run lifecycle: the wall-clock cap, what survives an auto-end, the `state.json`
 * breadcrumb, and the cross-process one-run gate.
 *
 * The conversational surface (start/send/getFindings/describe/end) is covered in
 * `debug-service.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { AdapterError, SessionBusyError, SessionNotFoundError } from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { SessionManager } from '../session/manager.js';
import { type LoopRunner, Session, type SessionAdapter } from '../session/session.js';
import type { ForeignRun, StatePort } from '../session/state-file.js';
import { _resetCounter, sessionPaths, workspacePaths } from '../session/workspace.js';
import { DebugService } from './debug-service.js';
import type { BuiltSession, SessionBuilder } from './session-builder.js';

const CWD = '/project/app';
const NOW = 1_700_000_000_000;

const CONFIG: ResolvedConfig = {
  models: { driver: 'deepseek/x', vision: 'glm/y', summary: 'deepseek/z' },
  workspace: './tmp/ui-debugger-mcp',
  targets: { web: { adapter: 'browser', url: 'http://localhost:3000', headless: true } },
  provider: { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1' },
};

/** Adapter stub that records how many times it was closed (optionally failing). */
class FakeAdapter implements SessionAdapter {
  closeCalls = 0;
  constructor(readonly closeFails = false) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFails) throw new AdapterError('close failed');
  }
}

/** A run that idles until aborted, then resolves — so `close()` settles cleanly. */
const idleRun: LoopRunner = ({ signal }) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * A run that flushes partial findings, then idles until aborted — what a run
 * that gets cut off by the wall-clock cap looks like on disk.
 */
const partialRun: LoopRunner = async (context) => {
  await context.progress.writeFindings({
    status: 'running',
    steps: [{ step: 'open /login', ok: true }],
    bugs: [{ kind: 'console', detail: 'TypeError: undefined is not a function' }],
    visual: [],
  });
  return idleRun(context);
};

interface BuildLog {
  builds: number;
  adapters: FakeAdapter[];
  /** What each build was handed as the cap left at build entry. */
  buildBudgets: Array<number | undefined>;
  /** The budget each `open()` was handed — what is left of the cap after the build. */
  openBudgets: Array<number | undefined>;
}

let tmpDir: string;
let manager: SessionManager<Session>;

beforeEach(async () => {
  _resetCounter();
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-life-test-'));
  manager = new SessionManager<Session>();
});

afterEach(async () => {
  if (manager.has(CWD)) await manager.end(CWD);
  await rm(tmpDir, { recursive: true, force: true });
});

/** A fake session builder backed by a real `Session` (FakeAdapter + temp store). */
function fakeBuilder(opts: { closeFails?: boolean; run?: LoopRunner } = {}): {
  build: SessionBuilder;
  log: BuildLog;
} {
  const log: BuildLog = { builds: 0, adapters: [], buildBudgets: [], openBudgets: [] };
  const build: SessionBuilder = async (params) => {
    log.builds += 1;
    log.buildBudgets.push(params.timeoutMs);
    const adapter = new FakeAdapter(opts.closeFails ?? false);
    log.adapters.push(adapter);
    const store = new FindingsStore(sessionPaths(workspacePaths(CWD, tmpDir), params.id));
    const session = new Session<SessionAdapter>({
      id: params.id,
      story: params.goal,
      criteria: params.criteria,
      adapter,
      findingsStore: store,
    });
    const built: BuiltSession = {
      session,
      open: async (timeoutMs) => {
        log.openBudgets.push(timeoutMs);
      },
      run: opts.run ?? idleRun,
    };
    return built;
  };
  return { build, log };
}

/** Resolve after `ms` — let an armed wall-clock timer fire. */
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A clock the test advances by hand — stands in for time burnt launching Chrome. */
function fakeClock(start = NOW): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function makeService(
  build: SessionBuilder,
  opts: { defaultTimeoutMs?: number; state?: StatePort; now?: () => number } = {},
): DebugService {
  return new DebugService({ manager, config: CONFIG, cwd: CWD, build, now: () => NOW, ...opts });
}

// --- wall-clock cap ---------------------------------------------------------

test('a run auto-ends when its wall-clock timeout fires (frees the lock + closes the adapter)', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build, { defaultTimeoutMs: 20 });

  await svc.start({ target: 'web', goal: 'x' });
  expect(manager.has(CWD)).toBe(true);

  await tick(60);
  expect(manager.has(CWD)).toBe(false);
  expect(log.adapters[0]?.closeCalls).toBe(1);
});

test('a per-run timeout overrides the default', async () => {
  const { build } = fakeBuilder();
  const svc = makeService(build, { defaultTimeoutMs: 10_000 });

  await svc.start({ target: 'web', goal: 'x', timeoutMs: 20 });
  await tick(60);
  expect(manager.has(CWD)).toBe(false);
});

test('the cap is wall-clock from start: build + open spend the same budget', async () => {
  const { build, log } = fakeBuilder();
  const clock = fakeClock();
  // 120ms "launching Chrome", then 30ms "navigating" — 150ms of a 200ms cap.
  const slowBuild: SessionBuilder = async (params) => {
    clock.advance(120);
    const built = await build(params);
    return {
      ...built,
      open: async (ms) => {
        clock.advance(30);
        await built.open(ms);
      },
    };
  };
  const svc = makeService(slowBuild, { now: clock.now, defaultTimeoutMs: 200 });

  await svc.start({ target: 'web', goal: 'x' });
  expect(log.buildBudgets[0]).toBe(200); // whole cap at build entry
  expect(log.openBudgets[0]).toBe(80); // what the launch left for the navigation

  // Only ~50ms of cap remain, so the run is already down here; a cap restarted at
  // `open` would still be running (it would not fire until 200ms).
  await tick(120);
  expect(manager.has(CWD)).toBe(false);
  expect(log.adapters[0]?.closeCalls).toBe(1);
});

test('a launch that outlives the whole cap ends the run at once (never a fresh cap)', async () => {
  const { build } = fakeBuilder();
  const clock = fakeClock();
  const slowBuild: SessionBuilder = async (params) => {
    clock.advance(5_000);
    return build(params);
  };
  const svc = makeService(slowBuild, { now: clock.now, defaultTimeoutMs: 200 });

  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  await tick(20);
  expect(manager.has(CWD)).toBe(false);
  // Spent, not lost: the findings of the run that never got going stay readable.
  expect((await svc.getFindings({ session_id })).status).toBe('failed');
});

test('ending a run cancels its timeout (no auto-end fires afterward)', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build, { defaultTimeoutMs: 20 });

  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  await svc.end({ session_id });
  expect(log.adapters[0]?.closeCalls).toBe(1); // closed exactly once, by end()

  await tick(60); // the (now-cancelled) timer would have fired here
  expect(log.adapters[0]?.closeCalls).toBe(1); // still once — timeout did not re-close
});

// --- findings survive an auto-end -------------------------------------------

test('a timed-out run stays readable: get_findings serves its terminal snapshot', async () => {
  const { build } = fakeBuilder({ run: partialRun });
  const svc = makeService(build, { defaultTimeoutMs: 20 });
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await tick(60);
  expect(manager.has(CWD)).toBe(false); // the run is torn down, the lock freed

  const findings = await svc.getFindings({ session_id });
  expect(findings.status).toBe('failed'); // cut off before a verdict
  expect(findings.steps).toEqual([{ step: 'open /login', ok: true }]);
  expect(findings.bugs).toHaveLength(1);
  expect(await svc.getFindings({ session_id, fields: ['status'] })).toEqual({ status: 'failed' });
  // Read-only: the retained snapshot never takes new work into a dead run.
  expect(() => svc.send({ session_id, message: 'keep going' })).toThrow(SessionNotFoundError);
});

test('a retained snapshot never blocks the next run, and the new run supersedes it', async () => {
  const { build } = fakeBuilder();
  const svc = makeService(build, { defaultTimeoutMs: 20 });
  const first = await svc.start({ target: 'web', goal: 'x' });
  await tick(60);

  const second = await svc.start({ target: 'web', goal: 'y' }); // gate is free
  expect(second.session_id).not.toBe(first.session_id);
  expect(manager.has(CWD)).toBe(true);
  // The live run owns the id space now — the superseded snapshot is gone.
  await expect(svc.getFindings({ session_id: first.session_id })).rejects.toThrow(
    SessionNotFoundError,
  );
  expect((await svc.getFindings({ session_id: second.session_id })).status).toBe('running');
});

test('end_session forgets a timed-out run (acks once, then the id is unknown)', async () => {
  const { build, log } = fakeBuilder({ run: partialRun });
  const svc = makeService(build, { defaultTimeoutMs: 20 });
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  await tick(60);

  expect(await svc.end({ session_id })).toEqual({ ok: true, session_id });
  expect(log.adapters[0]?.closeCalls).toBe(1); // already closed by the auto-end; not re-closed
  await expect(svc.getFindings({ session_id })).rejects.toThrow(SessionNotFoundError);
  await expect(svc.end({ session_id })).rejects.toThrow(SessionNotFoundError);
});

test('an explicitly ended run is forgotten immediately (end_session is the forget)', async () => {
  const svc = makeService(fakeBuilder({ run: partialRun }).build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await svc.end({ session_id });
  await expect(svc.getFindings({ session_id })).rejects.toThrow(SessionNotFoundError);
});

// --- state.json breadcrumb --------------------------------------------------

/** A `StatePort` spy: counts `clear()`, optionally fails `record()` / reports a foreign run. */
function spyState(opts: { recordFails?: boolean; foreign?: () => ForeignRun | null } = {}): {
  state: StatePort;
  clears: () => number;
  foreignReads: () => number;
} {
  let clears = 0;
  let foreignReads = 0;
  const state: StatePort = {
    async record() {
      if (opts.recordFails) throw new AdapterError('disk full');
    },
    async clear() {
      clears += 1;
    },
    async foreignRun() {
      foreignReads += 1;
      return opts.foreign?.() ?? null;
    },
  };
  return { state, clears: () => clears, foreignReads: () => foreignReads };
}

test('a failing state.json write tears the run down instead of leaving it uncapped', async () => {
  const { build, log } = fakeBuilder();
  const { state, clears } = spyState({ recordFails: true });
  const svc = makeService(build, { state, defaultTimeoutMs: 20 });

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  expect(manager.has(CWD)).toBe(false); // no live run nobody holds an id for
  expect(log.adapters[0]?.closeCalls).toBe(1);
  expect(clears()).toBe(1); // no half-written `running` breadcrumb for the CLI

  await tick(60); // the armed timer was cancelled with the teardown
  expect(log.adapters[0]?.closeCalls).toBe(1);
});

test('end clears state.json even when the session close throws (error still propagates)', async () => {
  const { build } = fakeBuilder({ closeFails: true });
  const { state, clears } = spyState();
  const svc = makeService(build, { state });
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await expect(svc.end({ session_id })).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1); // no stale `running` breadcrumb for the CLI to SIGTERM
  expect(manager.has(CWD)).toBe(false);
});

test('endActive clears state.json even when the session close throws', async () => {
  const { build } = fakeBuilder({ closeFails: true });
  const { state, clears } = spyState();
  const svc = makeService(build, { state });
  await svc.start({ target: 'web', goal: 'x' });

  await expect(svc.endActive()).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1);
});

// --- cross-process one-run gate ---------------------------------------------

test('start refuses when another live server holds a run for this cwd', async () => {
  const { build, log } = fakeBuilder();
  const { state } = spyState({ foreign: () => ({ pid: 4242, sessionId: 'other-run' }) });
  const svc = makeService(build, { state });

  const err = await svc.start({ target: 'web', goal: 'x' }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(SessionBusyError);
  // Names the pid + run so the caller can go stop the right server.
  expect((err as SessionBusyError).message).toContain('pid 4242');
  expect((err as SessionBusyError).message).toContain('other-run');
  expect(log.builds).toBe(0); // refused before any browser/emulator was launched
  expect(manager.has(CWD)).toBe(false);
});

test('a stale breadcrumb from a dead server never blocks a start', async () => {
  const { build, log } = fakeBuilder();
  // What `FileStatePort.foreignRun` reports for a `running` file whose pid is dead
  // (or recycled), and for our own breadcrumb: nobody to collide with.
  const { state, foreignReads } = spyState({ foreign: () => null });
  const svc = makeService(build, { state });

  await svc.start({ target: 'web', goal: 'x' });

  expect(foreignReads()).toBe(1); // the gate was consulted, and let it through
  expect(log.builds).toBe(1);
  expect(manager.has(CWD)).toBe(true);
});

test('the cross-process gate does not wedge the project once the other server exits', async () => {
  const { build } = fakeBuilder();
  let live: ForeignRun | null = { pid: 4242, sessionId: 'other-run' };
  const { state } = spyState({ foreign: () => live });
  const svc = makeService(build, { state });

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(SessionBusyError);
  live = null; // the other server ended its run / died

  // A stuck in-flight guard would surface a second SessionBusyError here instead.
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  expect(manager.get(CWD).id).toBe(session_id);
});
