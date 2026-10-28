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

import { expect, test } from 'bun:test';
import { SessionNotFoundError } from '../errors.js';
import {
  CWD,
  fakeBuilder,
  makeService,
  manager,
  NOW,
  partialRun,
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
