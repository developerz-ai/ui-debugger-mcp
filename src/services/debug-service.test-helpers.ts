/**
 * Shared fakes for the DebugService suites — `debug-service.test.ts` (the
 * conversational surface), `debug-service.describe.test.ts` (the catalog
 * projection), `debug-service.timeout.test.ts` (the wall-clock cap),
 * `debug-service.breadcrumb.test.ts` (the `state.json` breadcrumb),
 * `debug-service.cross-process.test.ts` (the one-run gate across processes)
 * and `debug-service.ownership.test.ts` (the workspace claim).
 *
 * One owner for the doubles they share: an adapter stub that counts its
 * closes, a session builder backed by a REAL `Session` + a temp findings store
 * (so the retained-snapshot and breadcrumb paths are exercised, not mocked
 * away), and a `StatePort` spy. A fix to a fake that landed in one suite and
 * missed the others would leave half the suite testing a lie.
 */

import { afterEach, beforeEach } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedConfig } from '../config/load.js';
import { AdapterError } from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { SessionManager } from '../session/manager.js';
import { type LoopRunner, Session, type SessionAdapter } from '../session/session.js';
import type { ForeignRun, StatePort } from '../session/state-file.js';
import { _resetCounter, sessionPaths, workspacePaths } from '../session/workspace.js';
import { DebugService, type DebugServiceDeps } from './debug-service.js';
import type { BuildSessionParams, BuiltSession, SessionBuilder } from './session-builder.js';

export const CWD = '/project/app';
export const NOW = 1_700_000_000_000;

/** The project config the suites drive: a web, a desktop and an android target. */
export const CONFIG: ResolvedConfig = {
  models: { driver: 'deepseek/x', vision: 'glm/y', summary: 'deepseek/z' },
  workspace: './tmp/ui-debugger-mcp',
  targets: {
    web: { adapter: 'browser', url: 'http://localhost:3000', headless: true },
    screen: { adapter: 'desktop', launch: 'myapp' },
    phone: { adapter: 'android', headless: true, avd: 'pixel', adbSerial: 'emulator-5554' },
  },
  provider: { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1' },
};

/**
 * The per-test session registry — replaced before every test by
 * {@link useTempWorkspace}, so a run never leaks into the next one.
 */
export let manager: SessionManager<Session> = new SessionManager<Session>();

/**
 * The per-test temp workspace — the root every fake session writes its
 * findings under, and the workspace the ownership-claim cases share.
 */
export let tmpDir = '';

/**
 * Register the per-test workspace setup: a fresh temp dir and a fresh session
 * registry for every test, torn down afterwards. One call per suite file.
 */
export function useTempWorkspace(prefix = 'ui-dbg-svc-test-'): void {
  beforeEach(async () => {
    _resetCounter();
    tmpDir = await mkdtemp(join(tmpdir(), prefix));
    manager = new SessionManager<Session>();
  });
  afterEach(async () => {
    if (manager.has(CWD)) await manager.end(CWD);
    await rm(tmpDir, { recursive: true, force: true });
  });
}

/** Adapter stub that records how many times it was closed (optionally failing). */
export class FakeAdapter implements SessionAdapter {
  closeCalls = 0;
  constructor(readonly closeFails = false) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFails) throw new AdapterError('close failed');
  }
}

/** A run that idles until aborted, then resolves — so `close()` settles cleanly. */
export const idleRun: LoopRunner = ({ signal }) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/**
 * A run that flushes partial findings, then idles until aborted — what a run
 * that gets cut off by the wall-clock cap looks like on disk.
 */
export const partialRun: LoopRunner = async (context) => {
  await context.progress.writeFindings({
    status: 'running',
    steps: [{ step: 'open /login', ok: true }],
    bugs: [{ kind: 'console', detail: 'TypeError: undefined is not a function' }],
    visual: [],
  });
  return idleRun(context);
};

/** Resolve after `ms` — let an armed wall-clock timer fire. */
export const tick = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));

/** What the fake builder saw — the union of every suite's bookkeeping. */
export interface BuildLog {
  /** What each build was handed. */
  params: BuildSessionParams[];
  /** The adapter each build handed out. */
  adapters: FakeAdapter[];
  /** How many times the target was opened. */
  openCalls: number;
  /** How many builds ran. */
  builds: number;
  /** What each build was handed as the cap left at build entry. */
  buildBudgets: Array<number | undefined>;
  /** The budget each `open()` was handed — what is left of the cap after the build. */
  openBudgets: Array<number | undefined>;
}

/** A fake session builder backed by a real `Session` (FakeAdapter + temp store). */
export function fakeBuilder(
  opts: { openFails?: boolean; closeFails?: boolean; run?: LoopRunner } = {},
): {
  build: SessionBuilder;
  log: BuildLog;
} {
  const log: BuildLog = {
    params: [],
    adapters: [],
    openCalls: 0,
    builds: 0,
    buildBudgets: [],
    openBudgets: [],
  };
  const build: SessionBuilder = async (params) => {
    log.builds += 1;
    log.params.push({ ...params });
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

/** A `DebugService` over the shared registry + config, with the clock and host pinned. */
export function makeService(
  build: SessionBuilder,
  opts: {
    defaultTimeoutMs?: number;
    state?: StatePort;
    now?: () => number;
    platform?: NodeJS.Platform;
  } = {},
): DebugService {
  const deps: DebugServiceDeps = {
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    // The platform is PINNED: `operational` is derived from the host platform, so
    // the expectations must not depend on the OS the test happens to run on.
    platform: opts.platform ?? 'linux',
    now: opts.now ?? (() => NOW),
  };
  if (opts.defaultTimeoutMs !== undefined) deps.defaultTimeoutMs = opts.defaultTimeoutMs;
  if (opts.state !== undefined) deps.state = opts.state;
  return new DebugService(deps);
}

/**
 * A `StatePort` spy: counts + records `clear(sessionId)`, optionally fails
 * `record()` / reports a foreign run.
 */
export function spyState(opts: { recordFails?: boolean; foreign?: () => ForeignRun | null } = {}): {
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
