/**
 * The conversational surface: start / send / get_findings / describe / end.
 *
 * The wall-clock cap, auto-end retention, the `state.json` breadcrumb and the
 * cross-process gate live in `debug-service.lifecycle.test.ts`.
 */

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
function fakeBuilder(opts: { openFails?: boolean; run?: LoopRunner } = {}): {
  build: SessionBuilder;
  log: BuildLog;
} {
  const log: BuildLog = { params: [], adapters: [], openCalls: 0 };
  const build: SessionBuilder = async (params) => {
    log.params.push({ ...params });
    const adapter = new FakeAdapter();
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
      open: async () => {
        log.openCalls += 1;
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

/** Resolve after `ms` — let an armed wall-clock timer fire. */
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
