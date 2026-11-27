/**
 * The wall-clock cap — and what survives an auto-end.
 *
 * A run has a deadline: it is wall-clock from the `start_debug` call, so the
 * assembly and the launch spend the caller's budget instead of sitting outside
 * it. When it fires the run auto-ends: the lock is freed, the adapter closed,
 * and the findings stay readable under the id the caller still holds.
 *
 * The `state.json` breadcrumb and the cross-process gate live in
 * `debug-service.breadcrumb.test.ts` and `debug-service.cross-process.test.ts`.
 */

import { expect, spyOn, test } from 'bun:test';
import { SessionNotFoundError, SessionSettledError } from '../errors.js';
import {
  CWD,
  fakeBuilder,
  makeService,
  manager,
  NOW,
  partialRun,
  spyState,
  tick,
  useTempWorkspace,
} from './debug-service.test-helpers.js';
import type { SessionBuilder } from './session-builder.js';

useTempWorkspace();

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

async function waitForAutoEnd(): Promise<void> {
  // The active slot disappears before async findings persistence and adapter
  // teardown finish. Wait for both without using teardown time to judge the cap.
  const deadline = Date.now() + 2_000;
  while ((manager.has(CWD) || manager.closingId(CWD) !== undefined) && Date.now() < deadline) {
    await tick(10);
  }
  expect(manager.has(CWD)).toBe(false);
  expect(manager.closingId(CWD)).toBeUndefined();
}

// --- wall-clock cap ---------------------------------------------------------

test('a run auto-ends when its wall-clock timeout fires (frees the lock + closes the adapter)', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build, { defaultTimeoutMs: 20 });

  await svc.start({ target: 'web', goal: 'x' });
  expect(manager.has(CWD)).toBe(true);

  await waitForAutoEnd();
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

  const timer = spyOn(globalThis, 'setTimeout');
  try {
    await svc.start({ target: 'web', goal: 'x' });
    expect(manager.has(CWD)).toBe(true);
    // A fresh cap or one that ignores time spent in open must fail even
    // when teardown finishes quickly.
    expect(timer.mock.calls.map(([, delay]) => delay)).toEqual([50]);
  } finally {
    timer.mockRestore();
  }
  expect(log.buildBudgets[0]).toBe(200); // whole cap at build entry
  expect(log.openBudgets[0]).toBe(80); // what the launch left for the navigation

  await waitForAutoEnd();
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
  // It says SETTLED (and where the results are), not "no such session": the id is valid.
  expect(() => svc.send({ session_id, message: 'keep going' })).toThrow(SessionSettledError);
  expect(() => svc.send({ session_id, message: 'keep going' })).toThrow(/get_findings/);
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

test('end_session forgets a timed-out run (acks once, then acks the repeat as already ended)', async () => {
  const { build, log } = fakeBuilder({ run: partialRun });
  const svc = makeService(build, { defaultTimeoutMs: 20 });
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });
  await waitForAutoEnd();
  expect(log.adapters[0]?.closeCalls).toBe(1);

  expect(await svc.end({ session_id })).toEqual({ ok: true, session_id });
  expect(log.adapters[0]?.closeCalls).toBe(1); // already closed by the auto-end; not re-closed
  await expect(svc.getFindings({ session_id })).rejects.toThrow(SessionNotFoundError);
  // Idempotent: the repeat succeeds and says the run was already ended, with its status.
  expect(await svc.end({ session_id })).toEqual({
    ok: true,
    session_id,
    already_ended: { status: 'failed' },
  });
  expect(log.adapters[0]?.closeCalls).toBe(1);
});

test('an explicitly ended run is forgotten immediately (end_session is the forget)', async () => {
  const svc = makeService(fakeBuilder({ run: partialRun }).build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  await svc.end({ session_id });
  await expect(svc.getFindings({ session_id })).rejects.toThrow(SessionNotFoundError);
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

test("a run's timeout ends that run only — it never aborts a replace start in flight", async () => {
  // The takeover's first await (the foreign-run read) is held open across the
  // old run's timeout. The timer used to run the SHUTDOWN path, which aborts any
  // start in flight: the takeover failed with "this server is shutting down".
  const gate = Promise.withResolvers<void>();
  let reads = 0;
  const spy = spyState();
  const state = {
    ...spy.state,
    foreignRun: async () => {
      if (reads++ === 1) await gate.promise;
      return null;
    },
  };
  const { build, log } = fakeBuilder();
  const service = makeService(build, { state });
  const first = await service.start({ target: 'web', goal: 'old', timeoutMs: 15 });

  const takeover = service.start({ target: 'web', goal: 'new', replace: true });
  await tick(50); // the old run's cap fires while the takeover is parked
  expect(log.adapters[0]?.closeCalls).toBe(1);
  gate.resolve();

  const second = await takeover;
  expect(second.session_id).not.toBe(first.session_id);
  expect(manager.get(CWD).id).toBe(second.session_id);
  await service.end(second);
});

// --- shutdown while a teardown is already in flight ---------------------------
// The manager frees the slot BEFORE the close, so "no active run" is also what a
// run being torn down looks like. `endActive` is the shutdown barrier: answering
// at once there lets the process exit before the browser is closed, the verdict
// persisted and the breadcrumb cleared.

/** Make the run's adapter take `ms` to close; reports when it has. */
function slowClose(adapter: { close: () => Promise<void> } | undefined, ms: number) {
  const state = { closed: false };
  if (!adapter) return state;
  adapter.close = async () => {
    await tick(ms);
    state.closed = true;
  };
  return state;
}

test('endActive waits for a timeout teardown that is already in flight', async () => {
  const { build, log } = fakeBuilder();
  const spy = spyState();
  const service = makeService(build, { state: spy.state });
  await service.start({ target: 'web', goal: 'g', timeoutMs: 10 });
  const closing = slowClose(log.adapters[0], 120);
  await tick(40); // the cap fired: the slot is free, the close is still running
  expect(manager.has(CWD)).toBe(false);
  expect(closing.closed).toBe(false);

  await service.endActive(); // SIGTERM lands now

  expect(closing.closed).toBe(true);
  expect(spy.clears()).toBe(1);
});

test('endActive waits for an end_session teardown that is already in flight', async () => {
  const { build, log } = fakeBuilder();
  const spy = spyState();
  const service = makeService(build, { state: spy.state });
  const run = await service.start({ target: 'web', goal: 'g' });
  const closing = slowClose(log.adapters[0], 120);
  const ending = service.end(run);
  await tick(20);
  expect(closing.closed).toBe(false);

  await service.endActive();

  expect(closing.closed).toBe(true);
  expect(spy.clears()).toBe(1);
  await ending;
});
