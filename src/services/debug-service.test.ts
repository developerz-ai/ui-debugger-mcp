import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import {
  AdapterError,
  SessionBusyError,
  SessionNotFoundError,
  SessionSettledError,
  TargetNotFoundError,
} from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { SessionManager } from '../session/manager.js';
import { type LoopRunner, Session, type SessionAdapter } from '../session/session.js';
import type { StatePort } from '../session/state-file.js';
import { _resetCounter, sessionPaths, workspacePaths } from '../session/workspace.js';
import { DEFAULT_SESSION_TIMEOUT_MS, DebugService } from './debug-service.js';
import type { BuiltSession, SessionBuilder } from './session-builder.js';

const CWD = '/project/app';
const NOW = 1_700_000_000_000;

const CONFIG: ResolvedConfig = {
  models: { driver: 'deepseek/x', vision: 'glm/y', summary: 'deepseek/z' },
  workspace: './tmp/ui-debugger-mcp',
  targets: {
    web: { adapter: 'browser', url: 'http://localhost:3000', headless: true },
    screen: { adapter: 'desktop', launch: 'myapp' },
    phone: { adapter: 'android', avd: 'pixel', adbSerial: 'emulator-5554' },
  },
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

interface BuildLog {
  params: Array<{
    id: string;
    target: string;
    goal: string;
    criteria?: string;
    url?: string;
    timeoutMs?: number;
  }>;
  adapters: FakeAdapter[];
  openCalls: number;
  /** The budget each `open()` was handed — what is left of the cap after the build. */
  openBudgets: Array<number | undefined>;
}

let tmpDir: string;
let manager: SessionManager<Session>;

beforeEach(async () => {
  _resetCounter();
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-svc-test-'));
  manager = new SessionManager<Session>();
});

afterEach(async () => {
  if (manager.has(CWD)) await manager.end(CWD);
  await rm(tmpDir, { recursive: true, force: true });
});

/** A fake session builder backed by a real `Session` (FakeAdapter + temp store). */
function fakeBuilder(opts: { openFails?: boolean; closeFails?: boolean; run?: LoopRunner } = {}): {
  build: SessionBuilder;
  log: BuildLog;
} {
  const log: BuildLog = { params: [], adapters: [], openCalls: 0, openBudgets: [] };
  const build: SessionBuilder = async (params) => {
    log.params.push({ ...params });
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
        log.openCalls += 1;
        log.openBudgets.push(timeoutMs);
        if (opts.openFails) throw new AdapterError('open failed');
      },
      run: opts.run ?? idleRun,
    };
    return built;
  };
  return { build, log };
}

function makeService(build: SessionBuilder): DebugService {
  return new DebugService({ manager, config: CONFIG, cwd: CWD, build, now: () => NOW });
}

// --- start ------------------------------------------------------------------

test('start assembles, locks the cwd, opens, and runs in the background', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);

  const { session_id } = await svc.start({ target: 'web', goal: 'log in', criteria: 'cart has 1' });

  expect(session_id).toBe(`${NOW}-0001`);
  expect(log.params[0]).toEqual({
    id: session_id,
    target: 'web',
    goal: 'log in',
    criteria: 'cart has 1',
    url: undefined,
    timeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
  });
  expect(log.openCalls).toBe(1);
  expect(manager.has(CWD)).toBe(true);
  expect(manager.get(CWD).id).toBe(session_id);
  expect(manager.get(CWD).status).toBe('running');
});

test('start refuses a second run for the same cwd (busy), without rebuilding', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);

  await svc.start({ target: 'web', goal: 'first' });
  await expect(svc.start({ target: 'web', goal: 'second' })).rejects.toThrow(SessionBusyError);
  expect(log.params).toHaveLength(1);
});

test('two concurrent starts: the second fails busy without launching a second build', async () => {
  const { build } = fakeBuilder();
  let builds = 0;
  const slowBuild: SessionBuilder = async (params) => {
    builds += 1;
    await tick(20); // hold the build (≈ Chromium launching) so the calls overlap
    return build(params);
  };
  const svc = makeService(slowBuild);

  const [first, second] = await Promise.allSettled([
    svc.start({ target: 'web', goal: 'first' }),
    svc.start({ target: 'web', goal: 'second' }),
  ]);

  expect(first.status).toBe('fulfilled');
  expect(second.status).toBe('rejected');
  expect((second as PromiseRejectedResult).reason).toBeInstanceOf(SessionBusyError);
  expect(builds).toBe(1); // the loser never reached the builder — no second browser
  expect(manager.has(CWD)).toBe(true); // the winner's run is live
});

test('start tears the session down and frees the lock when open fails', async () => {
  const { build, log } = fakeBuilder({ openFails: true });
  const svc = makeService(build);

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  expect(manager.has(CWD)).toBe(false);
  expect(log.adapters[0]?.closeCalls).toBe(1);
});

// --- timeout ----------------------------------------------------------------

/** Resolve after `ms` — let an armed wall-clock timer fire. */
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a run auto-ends when its wall-clock timeout fires (frees the lock + closes the adapter)', async () => {
  const { build, log } = fakeBuilder();
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    defaultTimeoutMs: 20,
  });

  await svc.start({ target: 'web', goal: 'x' });
  expect(manager.has(CWD)).toBe(true);

  await tick(60);
  expect(manager.has(CWD)).toBe(false);
  expect(log.adapters[0]?.closeCalls).toBe(1);
});

test('a per-run timeout overrides the default', async () => {
  const { build } = fakeBuilder();
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    defaultTimeoutMs: 10_000,
  });

  await svc.start({ target: 'web', goal: 'x', timeoutMs: 20 });
  await tick(60);
  expect(manager.has(CWD)).toBe(false);
});

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
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build: slowBuild,
    now: clock.now,
    defaultTimeoutMs: 200,
  });

  await svc.start({ target: 'web', goal: 'x' });
  expect(log.params[0]?.timeoutMs).toBe(200); // whole cap at build entry
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
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build: slowBuild,
    now: clock.now,
    defaultTimeoutMs: 200,
  });

  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  await tick(20);
  expect(manager.has(CWD)).toBe(false);
  // Spent, not lost: the findings of the run that never got going stay readable.
  expect((await svc.getFindings({ session_id })).status).toBe('failed');
});

test('a failing state.json write tears the run down instead of leaving it uncapped', async () => {
  const { build, log } = fakeBuilder();
  let clears = 0;
  const state: StatePort = {
    async record() {
      throw new AdapterError('disk full');
    },
    async clear() {
      clears += 1;
    },
  };
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    state,
    now: () => NOW,
    defaultTimeoutMs: 20,
  });

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  expect(manager.has(CWD)).toBe(false); // no live run nobody holds an id for
  expect(log.adapters[0]?.closeCalls).toBe(1);
  expect(clears).toBe(1); // no half-written `running` breadcrumb for the CLI

  await tick(60); // the armed timer was cancelled with the teardown
  expect(log.adapters[0]?.closeCalls).toBe(1);
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

test('a timed-out run stays readable: get_findings serves its terminal snapshot', async () => {
  const { build } = fakeBuilder({ run: partialRun });
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    defaultTimeoutMs: 20,
  });
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
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    defaultTimeoutMs: 20,
  });
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
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    defaultTimeoutMs: 20,
  });
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

test('ending a run cancels its timeout (no auto-end fires afterward)', async () => {
  const { build, log } = fakeBuilder();
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    defaultTimeoutMs: 20,
  });

  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  await svc.end({ session_id });
  expect(log.adapters[0]?.closeCalls).toBe(1); // closed exactly once, by end()

  await tick(60); // the (now-cancelled) timer would have fired here
  expect(log.adapters[0]?.closeCalls).toBe(1); // still once — timeout did not re-close
});

// --- send -------------------------------------------------------------------

test('send queues a mid-run message on the active session', async () => {
  const svc = makeService(fakeBuilder().build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  const ack = svc.send({ session_id, message: 'also check mobile' });

  expect(ack).toEqual({ ok: true, session_id });
  expect(manager.get(CWD).inbox).toEqual(['also check mobile']);
});

test('a failed start releases the in-flight guard so a retry is not busy', async () => {
  const svc = makeService(fakeBuilder({ openFails: true }).build);
  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  // A stuck guard would surface SessionBusyError here instead of the open failure.
  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
});

test('send after the run settles fails loud instead of dropping the message', async () => {
  // A loop that concludes immediately: the session settles (no findings → failed).
  const instantRun: LoopRunner = async () => {};
  const svc = makeService(fakeBuilder({ run: instantRun }).build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await manager.get(CWD).snapshot(['status'], 1_000); // long-poll until it settles
  expect(manager.get(CWD).status).toBe('failed');

  expect(() => svc.send({ session_id, message: 'too late' })).toThrow(SessionSettledError);
  expect(manager.get(CWD).inbox).toEqual([]); // never silently queued
});

test('send rejects a stale/unknown session id', async () => {
  const svc = makeService(fakeBuilder().build);
  expect(() => svc.send({ session_id: 'ghost', message: 'x' })).toThrow(SessionNotFoundError);

  await svc.start({ target: 'web', goal: 'x' });
  expect(() => svc.send({ session_id: 'ghost', message: 'x' })).toThrow(SessionNotFoundError);
});

// --- getFindings ------------------------------------------------------------

test('getFindings returns the live snapshot, and projects a field subset', async () => {
  const svc = makeService(fakeBuilder().build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  const full = await svc.getFindings({ session_id });
  expect(full.status).toBe('running');
  expect(full.steps).toEqual([]);

  const partial = await svc.getFindings({ session_id, fields: ['status'] });
  expect(partial).toEqual({ status: 'running' });
});

test('getFindings rejects a stale/unknown session id', async () => {
  const svc = makeService(fakeBuilder().build);
  await expect(svc.getFindings({ session_id: 'ghost' })).rejects.toThrow(SessionNotFoundError);
});

// --- describe ---------------------------------------------------------------

test('describe lists every configured target with mode + operational flags', () => {
  const svc = makeService(fakeBuilder().build);
  const result = svc.describe({});

  expect(result.models).toEqual(CONFIG.models);
  expect(result.workspace).toBe(CONFIG.workspace);
  expect(result.targets.find((t) => t.name === 'web')).toEqual({
    name: 'web',
    adapter: 'browser',
    mode: 'managed',
    operational: true,
    url: 'http://localhost:3000',
    headless: true,
  });
  expect(result.targets.find((t) => t.name === 'screen')).toEqual({
    name: 'screen',
    adapter: 'desktop',
    mode: 'managed',
    operational: true,
  });
  expect(result.targets.find((t) => t.name === 'phone')).toEqual({
    name: 'phone',
    adapter: 'android',
    mode: 'attach',
    operational: true, // android adapter is shipped — never advertised as inoperative
  });
});

test('describe narrows to one named target, and rejects an unknown one', () => {
  const svc = makeService(fakeBuilder().build);
  expect(svc.describe({ target: 'web' }).targets).toHaveLength(1);
  expect(() => svc.describe({ target: 'nope' })).toThrow(TargetNotFoundError);
});

// --- end --------------------------------------------------------------------

test('end aborts the run, closes the adapter, and frees the lock', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  const ack = await svc.end({ session_id });

  expect(ack).toEqual({ ok: true, session_id });
  expect(manager.has(CWD)).toBe(false);
  expect(log.adapters[0]?.closeCalls).toBe(1);
  await expect(svc.end({ session_id })).rejects.toThrow(SessionNotFoundError);
});

/** A `StatePort` spy counting `clear()` calls. */
function spyState(): { state: StatePort; clears: () => number } {
  let clears = 0;
  const state: StatePort = {
    async record() {},
    async clear() {
      clears += 1;
    },
  };
  return { state, clears: () => clears };
}

test('end clears state.json even when the session close throws (error still propagates)', async () => {
  const { build } = fakeBuilder({ closeFails: true });
  const { state, clears } = spyState();
  const svc = new DebugService({ manager, config: CONFIG, cwd: CWD, build, state, now: () => NOW });
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await expect(svc.end({ session_id })).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1); // no stale `running` breadcrumb for the CLI to SIGTERM
  expect(manager.has(CWD)).toBe(false);
});

test('endActive clears state.json even when the session close throws', async () => {
  const { build } = fakeBuilder({ closeFails: true });
  const { state, clears } = spyState();
  const svc = new DebugService({ manager, config: CONFIG, cwd: CWD, build, state, now: () => NOW });
  await svc.start({ target: 'web', goal: 'x' });

  await expect(svc.endActive()).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1);
});
