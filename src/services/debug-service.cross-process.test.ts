/**
 * The cross-process one-run gate — and the foreign runs it makes visible.
 *
 * One run per project holds across processes too: this server's registry only
 * knows its own memory, so a start also consults the `state.json` breadcrumb
 * and refuses when another LIVE server already owns a run here. A dead
 * owner's stale breadcrumb never blocks, and `replace: true` never takes over
 * a run this server does not own — that browser is not ours to close.
 *
 * The workspace's exclusive claim — the authority behind the advisory
 * breadcrumb read — is covered in `debug-service.ownership.test.ts`.
 */

import { expect, test } from 'bun:test';
import { ConfigError, SessionBusyError, SessionNotFoundError } from '../errors.js';
import { SessionManager } from '../session/manager.js';
import type { Session } from '../session/session.js';
import type { ForeignRun, StatePort } from '../session/state-file.js';
import { DebugService } from './debug-service.js';
import {
  CONFIG,
  CWD,
  fakeBuilder,
  makeService,
  manager,
  spyState,
  useTempWorkspace,
} from './debug-service.test-helpers.js';

useTempWorkspace();

// --- the one-run gate across processes ---------------------------------------

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

// --- stale config ------------------------------------------------------------

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

// --- foreign run visibility --------------------------------------------------

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
