/**
 * Local run-lifecycle cleanup limits. A close must release the target even when
 * the run it wraps rejects, must be safe to call twice, and a failed launch must
 * leave neither an adapter nor a manager slot behind. All fakes are synthetic:
 * no browser, device, credential or live target is involved.
 */

import { expect, test } from 'bun:test';
import { AdapterError } from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { type LoopRunner, Session, type SessionAdapter } from '../session/session.js';
import type { StatePort } from '../session/state-file.js';
import { sessionPaths, workspacePaths } from '../session/workspace.js';
import {
  CWD,
  fakeBuilder,
  makeService,
  manager,
  useTempWorkspace,
} from './debug-service.test-helpers.js';

useTempWorkspace();

/** Adapter double: every close is counted. */
class CloseCountingAdapter implements SessionAdapter {
  closeCalls = 0;
  constructor(private readonly fail = false) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.fail) throw new AdapterError('adapter close failed');
  }
}

function buildSession(id: string, adapter: SessionAdapter): Session<SessionAdapter> {
  const store = new FindingsStore(sessionPaths(workspacePaths(CWD, '.'), id));
  return new Session<SessionAdapter>({
    id,
    story: 'synthetic',
    adapter,
    findingsStore: store,
  });
}

// --- Session.close() --------------------------------------------------------

test('close closes the adapter even when the awaited run is still in flight', async () => {
  // `#execute` folds a loop failure into the `failed` verdict rather than
  // rejecting, so a rejection from `close()` is the adapter's: it must still be
  // attempted once, after abort and after the run settles.
  const adapter = new CloseCountingAdapter(true);
  const session = buildSession('close-fails', adapter);
  let aborted = false;
  let settle!: () => void;
  session.start(({ signal }) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      settle();
    });
    return new Promise<void>((resolve) => {
      settle = resolve;
    });
  });

  const first = session.close();
  await expect(first).rejects.toThrow('adapter close failed');
  expect(aborted).toBe(true);
  expect(adapter.closeCalls).toBe(1);
  await expect(session.close()).rejects.toThrow('adapter close failed');
  expect(adapter.closeCalls).toBe(1);
});

test('concurrent and subsequent close calls share one teardown', async () => {
  const adapter = new CloseCountingAdapter();
  let settleRun!: () => void;
  const blocking: LoopRunner = ({ signal }) =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        settleRun = resolve;
      });
    });
  const session = buildSession('close-twice', adapter);
  session.start(blocking);

  const first = session.close();
  const second = session.close();
  settleRun();
  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  await session.close();
  expect(adapter.closeCalls).toBe(1);
});

test('cancellation during an in-flight run closes the adapter and keeps failed verdict', async () => {
  const adapter = new CloseCountingAdapter();
  let settleRun!: () => void;
  const blocking: LoopRunner = ({ signal }) =>
    new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => {
        settleRun = resolve;
      });
    });
  const session = buildSession('cancel-inflight', adapter);
  session.start(blocking);

  const closing = session.close();
  settleRun();
  await closing;
  expect(adapter.closeCalls).toBe(1);
  expect(session.status).toBe('failed');
});

// --- DebugService teardown --------------------------------------------------

test('a failing run still frees the manager slot and the session breadcrumb', async () => {
  const failing: LoopRunner = async () => {
    throw new AdapterError('driver exploded');
  };
  const { build, log } = fakeBuilder({ run: failing });
  const svc = makeService(build);
  const { session_id } = await svc.start({ target: 'web', goal: 'synthetic' });

  await svc.getFindings({ session_id, wait: 1_000 });
  await expect(svc.end({ session_id })).resolves.toEqual({ ok: true, session_id });

  expect(log.adapters[0]?.closeCalls).toBe(1);
  expect(manager.has(CWD)).toBe(false);
});

test('a rejected log write during end still frees the slot and closes the adapter', async () => {
  const state: StatePort = {
    record: async () => undefined,
    foreignFindings: async () => null,
    foreignRun: async () => null,
    clear: async () => {
      throw new AdapterError('disk full');
    },
  };
  const { build, log } = fakeBuilder();
  const svc = makeService(build, { state });
  const { session_id } = await svc.start({ target: 'web', goal: 'synthetic' });

  const error = await svc.end({ session_id }).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AdapterError);
  expect(log.adapters[0]?.closeCalls).toBe(1);
  expect(manager.has(CWD)).toBe(false);
});

test('a failed open releases the adapter and leaves no manager slot', async () => {
  const { build, log } = fakeBuilder({ openFails: true });
  const svc = makeService(build);

  await expect(svc.start({ target: 'web', goal: 'synthetic' })).rejects.toThrow(AdapterError);
  expect(log.adapters[0]?.closeCalls).toBe(1);
  expect(manager.has(CWD)).toBe(false);
});
