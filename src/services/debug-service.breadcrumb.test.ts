/**
 * The `state.json` breadcrumb — and the teardown around it.
 *
 * The breadcrumb is how a run is reached OUT OF BAND: `ui-debugger-mcp status`
 * and `stop` are separate processes that cannot see this server's memory, so
 * the running server drops a small file naming the run, its pid and where its
 * findings live. It goes down BEFORE the launch (a cold Chrome takes seconds —
 * until the file exists, a real browser already holds the profile lock while
 * the CLI reports "no debug run recorded"), and it is cleared when the run
 * ends, even when the teardown throws.
 *
 * The cross-process gate and the workspace claim live in
 * `debug-service.cross-process.test.ts` and `debug-service.ownership.test.ts`.
 */

import { expect, test } from 'bun:test';
import { AdapterError, SessionBusyError, SessionSettledError } from '../errors.js';
import type { LoopRunner } from '../session/session.js';
import type { StatePort } from '../session/state-file.js';
import {
  CWD,
  fakeBuilder,
  makeService,
  manager,
  spyState,
  tick,
  useTempWorkspace,
} from './debug-service.test-helpers.js';
import type { SessionBuilder } from './session-builder.js';

useTempWorkspace();

// --- the breadcrumb ----------------------------------------------------------

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

// --- shutdown during an in-flight start --------------------------------------

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
