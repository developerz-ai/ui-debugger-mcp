import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionAdapter } from '../session/session.js';
import { Session } from '../session/session.js';
import { FindingsStore } from '../session/findings-store.js';
import { sessionPaths, workspacePaths } from '../session/workspace.js';

const CWD = '/project/app';

class CountingAdapter implements SessionAdapter {
  closeCalls = 0;
  constructor(readonly closeFails = false) {}
  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.closeFails) throw new Error('close failed');
  }
}

/** A run that REJECTS — the loop crashed mid-run (the defect class pinned here). */
const crashingRun = async () => {
  throw new Error('agent loop exploded');
};

/** A run that idles until aborted. */
const idleRun = async ({ signal }: { signal: AbortSignal }): Promise<void> => {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener('abort', () => resolve(), { once: true }),
  );
};

/** A run that resolves immediately (never aborts, just settles). */
const settledRun = async (_: { signal: AbortSignal }): Promise<void> => {
  return;
};

let tmpDir = '';

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-teardown-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

type LoopRunner = (context: { signal: AbortSignal }) => Promise<void>;

function freshSession(
  run: LoopRunner = settledRun,
  adapter: SessionAdapter = new CountingAdapter(),
): { session: Session<SessionAdapter>; adapter: CountingAdapter } {
  const store = new FindingsStore(
    sessionPaths(workspacePaths(CWD, tmpDir), '2026-01-01_00-00-00-0001'),
  );
  const session = new Session<SessionAdapter>({
    id: '2026-01-01_00-00-00-0001',
    story: 'log in',
    adapter,
    findingsStore: store,
  });
  return { session, adapter: adapter as CountingAdapter };
}

test('close() still closes the adapter when the loop crashes', async () => {
  const { session, adapter } = freshSession();
  session.start(crashingRun as unknown as LoopRunner);
  // close() aborts then awaits the run; the loop's crash is folded into a failed
  // verdict inside #execute, so close() resolves — but adapter.close() MUST run.
  await expect(session.close()).resolves.toBeUndefined();
  expect(adapter.closeCalls).toBe(1);
});

test('close() closes the adapter exactly once when the loop idles', async () => {
  const { session, adapter } = freshSession();
  session.start(idleRun as unknown as LoopRunner);
  await session.close();
  expect(adapter.closeCalls).toBe(1);
});

test('close() with NO run started still closes the adapter', async () => {
  const { session, adapter } = freshSession();
  await session.close();
  expect(adapter.closeCalls).toBe(1);
});

test('close() rethrows the close error after freeing what it can', async () => {
  const { session, adapter } = freshSession(
    settledRun as unknown as LoopRunner,
    new CountingAdapter(true),
  );
  session.start(settledRun as unknown as LoopRunner);
  await expect(session.close()).rejects.toThrow('close failed');
  expect(adapter.closeCalls).toBe(1);
});
