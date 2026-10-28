/**
 * The conversational surface: start / send / get_findings / end.
 *
 * The describe projection, the wall-clock cap, the `state.json` breadcrumb and
 * the cross-process gate live in their own suites:
 * `debug-service.describe.test.ts`, `debug-service.timeout.test.ts`,
 * `debug-service.breadcrumb.test.ts`, `debug-service.cross-process.test.ts`
 * and `debug-service.ownership.test.ts`.
 *
 * The doubles they share live in `debug-service.test-helpers.ts`.
 */

import { expect, test } from 'bun:test';
import {
  AdapterError,
  SessionBusyError,
  SessionNotFoundError,
  SessionSettledError,
} from '../errors.js';
import type { LoopRunner } from '../session/session.js';
import { DEFAULT_SESSION_TIMEOUT_MS } from './debug-service.js';
import {
  CWD,
  fakeBuilder,
  makeService,
  manager,
  NOW,
  tick,
  useTempWorkspace,
} from './debug-service.test-helpers.js';
import type { SessionBuilder } from './session-builder.js';

useTempWorkspace();

// --- start ------------------------------------------------------------------

test('start assembles, locks the cwd, opens, and runs in the background', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);

  const { session_id } = await svc.start({ target: 'web', goal: 'log in', criteria: 'cart has 1' });

  // The id IS the run's local timestamp — `2026-07-27_14-30-05-0001`.
  expect(session_id).toMatch(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-0001$/);
  const at = new Date(NOW);
  expect(session_id).toStartWith(
    `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-`,
  );
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

test('start passes the per-run url through to the builder', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);

  await svc.start({ target: 'web', goal: 'log in', url: 'https://staging.example.com' });

  expect(log.params[0]?.url).toBe('https://staging.example.com');
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

test('the busy refusal names the active run and every way out of it', async () => {
  // A caller that lost its session id used to have no in-band recovery at all —
  // the only door left was `ui-debugger-mcp stop` in a shell it may not have.
  const svc = makeService(fakeBuilder().build);
  const { session_id } = await svc.start({ target: 'web', goal: 'first' });

  const err = (await svc
    .start({ target: 'web', goal: 'second' })
    .catch((e: unknown) => e)) as Error;

  expect(err).toBeInstanceOf(SessionBusyError);
  expect(err.message).toContain(session_id);
  expect(err.message).toContain(`get_findings({session_id:'${session_id}'})`);
  expect(err.message).toContain(`end_session({session_id:'${session_id}'})`);
  expect(err.message).toContain('replace:true');
  expect(err.message).toContain('describe()');
});

// --- start({replace}) — the explicit takeover -------------------------------

test('replace:true ends the active run through the end_session path, then starts', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);
  const first = await svc.start({ target: 'web', goal: 'first' });

  const second = await svc.start({ target: 'web', goal: 'second', replace: true });

  expect(second.session_id).not.toBe(first.session_id);
  // The replaced run was released, not abandoned: its adapter is closed (managed
  // Chrome stopped, profile lock freed) exactly as `end_session` would have.
  expect(log.adapters[0]?.closeCalls).toBe(1);
  expect(log.adapters[1]?.closeCalls).toBe(0);
  expect(manager.get(CWD).id).toBe(second.session_id);
  // The old id is gone the moment the new run owns the project.
  await expect(svc.getFindings({ session_id: first.session_id })).rejects.toThrow(
    SessionNotFoundError,
  );
  expect((await svc.getFindings({ session_id: second.session_id })).status).toBe('running');
});

test('replace:true with nothing active is just a start', async () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);

  const { session_id } = await svc.start({ target: 'web', goal: 'x', replace: true });

  expect(manager.get(CWD).id).toBe(session_id);
  expect(log.params).toHaveLength(1);
});

test('replace:true does not slip past the in-flight guard (a launching run is not replaceable)', async () => {
  // A start still opening owns no manager slot to hand over, and racing its
  // teardown is how a half-launched Chrome ends up orphaned on the profile lock.
  const { build } = fakeBuilder();
  const slowBuild: SessionBuilder = async (params) => {
    await tick(20);
    return build(params);
  };
  const svc = makeService(slowBuild);

  const [first, second] = await Promise.allSettled([
    svc.start({ target: 'web', goal: 'first' }),
    svc.start({ target: 'web', goal: 'second', replace: true }),
  ]);

  expect(first.status).toBe('fulfilled');
  expect(second.status).toBe('rejected');
  expect((second as PromiseRejectedResult).reason).toBeInstanceOf(SessionBusyError);
  expect(((second as PromiseRejectedResult).reason as Error).message).toContain('already starting');
});

test('start tears the session down and frees the lock when open fails', async () => {
  const { build, log } = fakeBuilder({ openFails: true });
  const svc = makeService(build);

  await expect(svc.start({ target: 'web', goal: 'x' })).rejects.toThrow(AdapterError);
  expect(manager.has(CWD)).toBe(false);
  expect(log.adapters[0]?.closeCalls).toBe(1);
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

test('getFindings passes `wait` through to the session, long-polling for the settled verdict', async () => {
  // A run that settles a beat later: without `wait` reaching `session.snapshot`,
  // this read would return the live `running` snapshot instead of waiting for it.
  const delayedRun: LoopRunner = () => tick(30);
  const svc = makeService(fakeBuilder({ run: delayedRun }).build);
  const { session_id } = await svc.start({ target: 'web', goal: 'x' });

  const findings = await svc.getFindings({ session_id, wait: 1_000 });

  expect(findings.status).toBe('failed'); // settled by the time the long-poll returns
});

// --- the auth persona --------------------------------------------------------

test('start forwards the auth persona to the builder', () => {
  const { build, log } = fakeBuilder();
  const svc = makeService(build);
  return svc.start({ target: 'web', goal: 'open audit', as: 'admin' }).then(() => {
    expect(log.params[0]?.as).toBe('admin');
  });
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
