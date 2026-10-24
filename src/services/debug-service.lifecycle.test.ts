/**
 * Run lifecycle: the wall-clock cap, what survives an auto-end, the `state.json`
 * breadcrumb, and the cross-process one-run gate.
 *
 * The conversational surface (start/send/getFindings/describe/end) is covered in
 * `debug-service.test.ts`.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import {
  AdapterError,
  ConfigError,
  SessionBusyError,
  SessionNotFoundError,
  SessionSettledError,
} from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { SessionManager } from '../session/manager.js';
import { ownerLockPath } from '../session/owner-lock.js';
import { captureIdentity } from '../session/process-identity.js';
import { type LoopRunner, Session, type SessionAdapter } from '../session/session.js';
import {
  FileStatePort,
  type ForeignRun,
  readState,
  type StatePort,
  writeState,
} from '../session/state-file.js';
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

/**
 * A `StatePort` spy: counts + records `clear(sessionId)`, optionally fails
 * `record()` / reports a foreign run.
 */
function spyState(opts: { recordFails?: boolean; foreign?: () => ForeignRun | null } = {}): {
  state: StatePort;
  clears: () => number;
  clearedIds: () => string[];
  foreignReads: () => number;
} {
  let clears = 0;
  let foreignReads = 0;
  const clearedIds: string[] = [];
  const state: StatePort = {
    async record() {
      if (opts.recordFails) throw new AdapterError('disk full');
    },
    async clear(sessionId) {
      clears += 1;
      clearedIds.push(sessionId);
    },
    async foreignFindings() {
      return null;
    },
    async foreignRun() {
      foreignReads += 1;
      return opts.foreign?.() ?? null;
    },
  };
  return {
    state,
    clears: () => clears,
    clearedIds: () => clearedIds,
    foreignReads: () => foreignReads,
  };
}

test('a failing state.json write fails the start loud, before anything is launched', async () => {
  const { build, log } = fakeBuilder();
  const { state } = spyState({ recordFails: true });
  const svc = makeService(build, { state, defaultTimeoutMs: 20 });

  // A run the CLI cannot see is a run nobody can stop: refuse it rather than
  // leave a browser holding the profile lock with no breadcrumb to reach it by.
  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  expect(log.builds).toBe(0); // the breadcrumb precedes the launch — nothing came up
  expect(manager.has(CWD)).toBe(false);

  await tick(60); // no run, so no timer to fire
  expect(manager.has(CWD)).toBe(false);
});

test('the breadcrumb is written BEFORE the launch (a starting run is visible + stoppable)', async () => {
  // Chrome takes seconds to come up; recording only afterwards leaves that whole
  // window invisible out-of-band — `status` says "no debug run recorded" and
  // `stop` never signals, while a real browser already holds the profile lock.
  const { build } = fakeBuilder();
  const events: string[] = [];
  const state: StatePort = {
    async record(run) {
      events.push(`record:${run.sessionId}`);
    },
    async clear() {
      events.push('clear');
    },
    async foreignRun() {
      return null;
    },
    async foreignFindings() {
      return null;
    },
  };
  const tracedBuild: SessionBuilder = async (params) => {
    events.push('build');
    return build(params);
  };
  const svc = makeService(tracedBuild, { state });

  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  expect(events).toEqual([`record:${session_id}`, 'build']);
});

test('a launch that fails clears the breadcrumb it wrote (no phantom running run)', async () => {
  const { build } = fakeBuilder();
  const { state, clears, clearedIds } = spyState();
  let launchedId = '';
  const failingOpen: SessionBuilder = async (params) => {
    launchedId = params.id;
    const built = await build(params);
    return {
      ...built,
      open: async () => {
        throw new AdapterError('chrome failed to launch');
      },
    };
  };
  const svc = makeService(failingOpen, { state });

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1); // the early `running` breadcrumb is not left behind
  expect(clearedIds()).toEqual([launchedId]); // scoped to THIS attempt's run
  expect(manager.has(CWD)).toBe(false);
});

// --- shutdown during an in-flight start -------------------------------------

test('a signal mid-launch aborts the start and closes what already came up', async () => {
  // `endActive()` used to return instantly here (the session is not in the manager
  // until after the build), so `process.exit` fired mid-launch and left Chrome
  // holding the profile lock — every later run then failed "profile is locked".
  const { build, log } = fakeBuilder();
  let launching: () => void = () => undefined;
  const inFlight = new Promise<void>((resolve) => {
    launching = resolve;
  });
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slowBuild: SessionBuilder = async (params) => {
    launching(); // Chromium is coming up...
    await held;
    return build(params); // ...and now it exists, holding the profile lock
  };
  const svc = makeService(slowBuild);

  const starting = svc.start({ target: 'web', goal: 'x' });
  await inFlight; // the signal lands mid-launch, before any manager slot exists
  let ended = false;
  const ending = svc.endActive().then(() => {
    ended = true;
  });

  await tick(20);
  expect(ended).toBe(false); // endActive WAITS for the launch it just cancelled

  release();
  await expect(starting).rejects.toThrow(SessionSettledError);
  await ending;

  expect(ended).toBe(true);
  expect(log.adapters[0]?.closeCalls).toBe(1); // the half-launched target was closed
  expect(manager.has(CWD)).toBe(false);
});

test('a cancelled start leaves no breadcrumb and does not wedge the next start', async () => {
  const { build } = fakeBuilder();
  const { state, clears } = spyState();
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let slow = true;
  const maybeSlowBuild: SessionBuilder = async (params) => {
    if (slow) await held;
    return build(params);
  };
  const svc = makeService(maybeSlowBuild, { state });

  const starting = svc.start({ target: 'web', goal: 'x' });
  const ending = svc.endActive();
  release();
  await expect(starting).rejects.toThrow(SessionSettledError);
  await ending;
  expect(clears()).toBeGreaterThanOrEqual(1); // nothing left pointing the CLI at a dead run

  slow = false; // the in-flight guard released with the cancelled start
  const { session_id } = await svc.start({ target: 'web', goal: 'y' });
  expect(manager.get(CWD).id).toBe(session_id);
});

test('end clears state.json even when the session close throws (error still propagates)', async () => {
  const { build } = fakeBuilder({ closeFails: true });
  const { state, clears, clearedIds } = spyState();
  const svc = makeService(build, { state });
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await expect(svc.end({ session_id })).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1); // no stale `running` breadcrumb for the CLI to SIGTERM
  expect(clearedIds()).toEqual([session_id]); // the ENDING run's id, never another's
  expect(manager.has(CWD)).toBe(false);
});

test('endActive clears state.json even when the session close throws', async () => {
  const { build } = fakeBuilder({ closeFails: true });
  const { state, clears, clearedIds } = spyState();
  const svc = makeService(build, { state });
  await svc.start({ target: 'web', goal: 'x' });
  const endingId = manager.get(CWD).id;

  await expect(svc.endActive()).rejects.toThrow(AdapterError);
  expect(clears()).toBe(1);
  expect(clearedIds()).toEqual([endingId]); // the auto-ended run's own breadcrumb
});

// --- delayed teardown: slot-free ≠ project-free ------------------------------

test('a start during a delayed teardown is refused, then allowed once the close finishes', async () => {
  const { build, log } = fakeBuilder();
  let releaseClose: () => void = () => undefined;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  // Ignores the abort signal entirely: only the gate settles this run's close —
  // the slow profile/adapter release whose race this gate closes.
  const stuckRun: LoopRunner = () => closeGate;
  let first = true;
  const builder: SessionBuilder = async (params) => {
    const built = await build(params);
    if (first) {
      first = false;
      return { ...built, run: stuckRun };
    }
    return built; // later builds are ordinary, so the retry can actually succeed
  };
  const { state, clearedIds } = spyState();
  const svc = makeService(builder, { state });
  const firstRun = await svc.start({ target: 'web', goal: 'x' });

  // The ending teardown, unawaited: the slot is already free, the close in flight.
  const ending = svc.end({ session_id: firstRun.session_id });
  expect(manager.has(CWD)).toBe(false);
  expect(manager.closingId(CWD)).toBe(firstRun.session_id);

  // …so a start lands on a project still being released — refused before any build,
  // naming the session whose teardown it must wait out.
  const refused = await svc.start({ target: 'web', goal: 'y' }).catch((e: unknown) => e);
  expect(refused).toBeInstanceOf(SessionBusyError);
  expect((refused as SessionBusyError).message).toContain(firstRun.session_id);
  expect((refused as SessionBusyError).message).toContain(CWD);
  expect(log.builds).toBe(1);

  releaseClose();
  await ending;
  expect(manager.closingId(CWD)).toBeUndefined(); // the gate lifted with the close
  expect(clearedIds()).toEqual([firstRun.session_id]); // the ending run's own breadcrumb

  const second = await svc.start({ target: 'web', goal: 'y' }); // now it goes through
  expect(manager.get(CWD).id).toBe(second.session_id);
});

// --- cross-process one-run gate ---------------------------------------------

test('start refuses when another live server holds a run for this cwd', async () => {
  const { build, log } = fakeBuilder();
  const { state } = spyState({
    foreign: () => ({ pid: 4242, sessionId: 'other-run', sessionDir: '/tmp/foreign' }),
  });
  const svc = makeService(build, { state });

  const err = await svc.start({ target: 'web', goal: 'x' }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(SessionBusyError);
  // Names the pid + run so the caller can go stop the right server.
  expect((err as SessionBusyError).message).toContain('pid 4242');
  expect((err as SessionBusyError).message).toContain('other-run');
  expect(log.builds).toBe(0); // refused before any browser/emulator was launched
  expect(manager.has(CWD)).toBe(false);
});

test('replace never takes over a run another live server owns', async () => {
  // That browser is not ours to close: killing it would leave the other server
  // driving a dead page. `ui-debugger-mcp stop` is the (out-of-band) door there,
  // and the refusal already names it.
  const { build, log } = fakeBuilder();
  const { state } = spyState({
    foreign: () => ({ pid: 4242, sessionId: 'other-run', sessionDir: '/tmp/foreign' }),
  });
  const svc = makeService(build, { state });

  const err = (await svc
    .start({ target: 'web', goal: 'x', replace: true })
    .catch((e: unknown) => e)) as Error;

  expect(err).toBeInstanceOf(SessionBusyError);
  expect(err.message).toContain('pid 4242');
  expect(err.message).toContain('ui-debugger-mcp stop');
  expect(log.builds).toBe(0);
});

test('a takeover leaves the NEW run in the breadcrumb (its own clear cannot outrun it)', async () => {
  // The replaced run's `end` clears `state.json`; if that landed after the new
  // run recorded itself, the CLI would see "no run" while a live browser held the
  // profile — so the takeover must happen before the new breadcrumb is written.
  const { build } = fakeBuilder();
  const events: string[] = [];
  const state: StatePort = {
    async record(run) {
      events.push(`record:${run.sessionId}`);
    },
    async clear(sessionId) {
      events.push(`clear:${sessionId}`);
    },
    async foreignRun() {
      return null;
    },
    async foreignFindings() {
      return null;
    },
  };
  const svc = makeService(build, { state });

  const first = await svc.start({ target: 'web', goal: 'x' });
  const second = await svc.start({ target: 'web', goal: 'y', replace: true });

  expect(events).toEqual([
    `record:${first.session_id}`,
    `clear:${first.session_id}`,
    `record:${second.session_id}`,
  ]);
});

test('describe still names a run that auto-ended, so its findings stay reachable by id', async () => {
  // The exact wedge this closes: the run timed out, the caller's context was
  // compacted, and the session id — the only handle on those findings — went with
  // it. `describe` hands it back instead of the CLI having to.
  const { build } = fakeBuilder({ run: partialRun });
  const svc = makeService(build, { defaultTimeoutMs: 20 });
  const { session_id } = await svc.start({ target: 'web', goal: 'check the audit table' });
  await tick(60);

  expect(manager.has(CWD)).toBe(false); // auto-ended: the lock is already free
  expect(svc.describe({}).session).toEqual({
    id: session_id,
    status: 'failed',
    goal: 'check the audit table',
  });
  expect((await svc.getFindings({ session_id })).bugs).toHaveLength(1);

  // …and the explicit forget clears it, exactly as it clears the snapshot.
  await svc.end({ session_id });
  expect(svc.describe({})).not.toHaveProperty('session');
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
  let live: ForeignRun | null = { pid: 4242, sessionId: 'other-run', sessionDir: '/tmp/foreign' };
  const { state } = spyState({ foreign: () => live });
  const svc = makeService(build, { state });

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(SessionBusyError);
  live = null; // the other server ended its run / died

  // A stuck in-flight guard would surface a second SessionBusyError here instead.
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  expect(manager.get(CWD).id).toBe(session_id);
});

// --- stale config -----------------------------------------------------------

test('start refuses to run on config that changed after boot, naming the fix', async () => {
  const stale = new DebugService({
    manager: new SessionManager<Session>(),
    config: CONFIG,
    cwd: CWD,
    // A stale-config start must die BEFORE anything is built or launched.
    build: async () => {
      throw new Error('build must never be reached');
    },
    configChanged: () => true,
  });
  const failure = stale.start({ target: 'web', goal: 'g' });
  await expect(failure).rejects.toThrow(ConfigError);
  // The message has to name the action, or the caller just edits and retries.
  await expect(failure).rejects.toThrow(/[Rr]estart/);
});

// --- foreign run visibility -------------------------------------------------

test('get_findings serves a foreign run instead of denying it exists', async () => {
  const foreignFindings = {
    status: 'failed',
    steps: [],
    bugs: [],
    visual: [],
    summary: 'the other server hit a wall',
  };
  const service = new DebugService({
    manager: new SessionManager<Session>(),
    config: CONFIG,
    cwd: CWD,
    build: async () => {
      throw new Error('unused');
    },
    state: {
      async record() {},
      async clear() {},
      async foreignRun() {
        return { pid: 999, sessionId: 'other-1', sessionDir: '/tmp/other' };
      },
      async foreignFindings(sessionId: string) {
        return sessionId === 'other-1' ? foreignFindings : null;
      },
    },
  });

  const found = await service.getFindings({ session_id: 'other-1' });
  expect(found.summary).toBe('the other server hit a wall');
  expect(found.status).toBe('failed');

  // `fields` still projects, so the two paths read alike.
  const projected = await service.getFindings({ session_id: 'other-1', fields: ['status'] });
  expect(projected).toEqual({ status: 'failed' });

  // An unrelated id is still a hard miss — this is a targeted fallback, not a catch-all.
  await expect(service.getFindings({ session_id: 'nope' })).rejects.toThrow(SessionNotFoundError);
});

// --- cross-process admission: the workspace ownership claim ------------------

/** Live child processes spawned by these tests — killed after each case. */
let liveChildren: ReturnType<typeof Bun.spawn>[] = [];

/**
 * A second LIVE pid, distinct from this process's.
 *
 * The ownership claim is decided by pid + process identity, so a test needs a
 * real second process: a dead pid would be reclaimed as stale, and a fabricated
 * one would not be provably alive. The child only sleeps — its pid is all the
 * test needs.
 */
function spawnLivePid(): number {
  const child = Bun.spawn({
    cmd: ['bun', '-e', 'await Bun.sleep(30_000)'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  liveChildren.push(child);
  return child.pid;
}

afterEach(async () => {
  for (const child of liveChildren) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  liveChildren = [];
});

test('a second server on the same workspace is refused — the owner keeps its run', async () => {
  // Two REAL FileStatePorts over ONE shared workspace, with distinct live pids:
  // the shape of two MCP servers debugging the same project at once. The second
  // start must be refused, and — the defect this closes — the first owner's
  // breadcrumb must still name it, so `status`/`stop` keep reaching the live
  // run instead of a dead one.
  const workspace = workspacePaths(CWD, tmpDir);
  const ownerPid = process.pid;
  const otherPid = spawnLivePid();
  const ownerState = new FileStatePort(workspace, { pid: ownerPid });
  const otherState = new FileStatePort(workspace, { pid: otherPid });

  const ownerManager = new SessionManager<Session>();
  const otherManager = new SessionManager<Session>();
  const ownerBuild = fakeBuilder();
  const otherBuild = fakeBuilder();
  const owner = new DebugService({
    manager: ownerManager,
    config: CONFIG,
    cwd: CWD,
    build: ownerBuild.build,
    state: ownerState,
    now: () => NOW,
  });
  const other = new DebugService({
    manager: otherManager,
    config: CONFIG,
    cwd: CWD,
    build: otherBuild.build,
    state: otherState,
    now: () => NOW,
  });

  const started = await owner.start({ target: 'web', goal: 'first' });
  expect(ownerManager.has(CWD)).toBe(true);

  const failure = await other.start({ target: 'web', goal: 'second' }).catch((e: unknown) => e);

  expect(failure).toBeInstanceOf(SessionBusyError);
  const message = (failure as SessionBusyError).message;
  expect(message).toContain(`pid ${ownerPid}`);
  expect(message).toContain(started.session_id);
  expect(message).toContain('ui-debugger-mcp stop');

  // The loser's browser never came up.
  expect(otherBuild.log.builds).toBe(0);
  expect(otherManager.has(CWD)).toBe(false);

  // …and the owner's live run is still the one on disk.
  expect(await readState(workspace.stateJson)).toMatchObject({
    pid: ownerPid,
    sessionId: started.session_id,
    status: 'running',
  });

  await owner.end({ session_id: started.session_id });
});

test('the ownership claim refuses a start even when the breadcrumb pre-check sees nothing', async () => {
  // The window the breadcrumb read cannot close: the loser's pre-check reads
  // the workspace BEFORE the winner's breadcrumb lands, so it sees "no foreign
  // run" and lets the start through. Only the exclusive claim can decide — and
  // it must refuse, before the loser publishes anything.
  //
  // The winner's breadcrumb here names a DEAD pid (its write has not landed
  // yet), while the claim it already took names a LIVE foreign process.
  const workspace = workspacePaths(CWD, tmpDir);
  const claimPid = spawnLivePid();
  const loserPid = spawnLivePid();
  const otherState = new FileStatePort(workspace, { pid: loserPid });
  const otherManager = new SessionManager<Session>();
  const otherBuild = fakeBuilder();
  const other = new DebugService({
    manager: otherManager,
    config: CONFIG,
    cwd: CWD,
    build: otherBuild.build,
    state: otherState,
    now: () => NOW,
  });

  // The winner holds the claim; its breadcrumb names a dead pid, so the loser's
  // pre-check reports "no foreign run" — exactly the race the claim closes.
  await mkdir(workspace.root, { recursive: true });
  await writeFile(
    ownerLockPath(workspace),
    `${JSON.stringify(
      {
        pid: claimPid,
        identity: captureIdentity(claimPid),
        sessionId: 'winner-run',
        acquiredAt: '2026-06-29T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await writeState(workspace.stateJson, {
    pid: 999_999_999, // dead — the pre-check sees nobody
    identity: { startTicks: 1 },
    sessionId: 'winner-run',
    target: 'web',
    goal: 'first',
    status: 'running',
    startedAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    sessionDir: join(workspace.sessions, 'winner-run'),
  });

  // The pre-check is blind here…
  expect(await otherState.foreignRun()).toBeNull();

  // …so the CLAIM is what refuses, before anything is launched.
  const failure = await other.start({ target: 'web', goal: 'second' }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(SessionBusyError);
  expect((failure as SessionBusyError).message).toContain(`pid ${claimPid}`);
  expect(otherBuild.log.builds).toBe(0);
  expect(otherManager.has(CWD)).toBe(false);

  // The winner's breadcrumb is untouched — the refusal published nothing.
  expect(await readState(workspace.stateJson)).toMatchObject({
    sessionId: 'winner-run',
    status: 'running',
  });
});
