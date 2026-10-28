/**
 * The retained snapshot — the bookkeeping that keeps an auto-ended run's
 * findings reachable after the run itself is gone.
 *
 * A run that ends WITHOUT being asked (wall-clock timeout, SIGTERM, the MCP
 * client dying) must not take its findings with it: the settled session is
 * retained so `get_findings` still serves its terminal snapshot under the id
 * the caller still holds.
 *
 * Three rules the bookkeeping keeps:
 *   - it holds ONE run, read-only: a retained snapshot never takes new work and
 *     never blocks the next start;
 *   - `end_session` is the explicit forget — it acks ONCE, and the id is
 *     unknown afterwards;
 *   - any other id is a hard miss: a stale id must never drive the wrong run.
 *
 * The service-level lifecycle (auto-end → retained → describe → end_session) is
 * covered in `debug-service.lifecycle.test.ts`.
 */

import { expect, test } from 'bun:test';
import { SessionNotFoundError } from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { Session, type SessionAdapter } from '../session/session.js';
import { sessionPaths, workspacePaths } from '../session/workspace.js';
import { RetainedSnapshot } from './retained-snapshot.js';

const CWD = '/project/app';

/** Adapter stub — the retained snapshot never touches a target. */
class FakeAdapter implements SessionAdapter {
  async close(): Promise<void> {}
}

/** A real session, standing in for a run that auto-ended (settled, closed). */
function makeSession(id: string, goal = 'check the audit table'): Session {
  const paths = sessionPaths(workspacePaths(CWD, '/tmp/ui-debugger-mcp-test'), id);
  return new Session<SessionAdapter>({
    id,
    story: goal,
    adapter: new FakeAdapter(),
    findingsStore: new FindingsStore(paths),
  });
}

/** The error a call threw — the assertions then check its TYPE and its text. */
function captureError(call: () => unknown): Error {
  try {
    call();
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected the call to throw, but it returned');
}

test('a fresh snapshot holds no run', () => {
  const snapshot = new RetainedSnapshot();

  expect(snapshot.peek()).toBeUndefined();
});

test('retain keeps the ended run readable by its id', () => {
  const snapshot = new RetainedSnapshot();
  const session = makeSession('run-1');

  snapshot.retain(session);

  expect(snapshot.peek()).toBe(session);
  expect(snapshot.requireRetained('run-1', CWD)).toBe(session);
});

test('requireRetained resolves only the retained run — any other id is a hard miss', () => {
  const snapshot = new RetainedSnapshot();
  snapshot.retain(makeSession('run-1'));

  const error = captureError(() => snapshot.requireRetained('other-run', CWD));

  expect(error).toBeInstanceOf(SessionNotFoundError);
  // The caller's id is named, so the caller can see WHICH id was wrong.
  expect(error.message).toContain('other-run');
});

test('requireRetained with nothing retained fails loud', () => {
  const snapshot = new RetainedSnapshot();

  expect(() => snapshot.requireRetained('run-1', CWD)).toThrow(SessionNotFoundError);
});

test('forget is the explicit end_session: it acks once and drops the run', () => {
  const snapshot = new RetainedSnapshot();
  const session = makeSession('run-1');
  snapshot.retain(session);

  expect(snapshot.forget('other-run')).toBe(false); // not the retained id: no ack
  expect(snapshot.peek()).toBe(session); // …and nothing was dropped

  expect(snapshot.forget('run-1')).toBe(true); // the explicit forget
  expect(snapshot.peek()).toBeUndefined();

  expect(snapshot.forget('run-1')).toBe(false); // acks ONCE
});

test('forget on an empty snapshot acks nothing', () => {
  const snapshot = new RetainedSnapshot();

  expect(snapshot.forget('run-1')).toBe(false);
});

test('clear drops the snapshot — the next run supersedes it', () => {
  const snapshot = new RetainedSnapshot();
  snapshot.retain(makeSession('run-1'));

  snapshot.clear();

  expect(snapshot.peek()).toBeUndefined();
  expect(() => snapshot.requireRetained('run-1', CWD)).toThrow(SessionNotFoundError);
});

test('a cleared snapshot takes the next run cleanly', () => {
  const snapshot = new RetainedSnapshot();
  snapshot.retain(makeSession('run-1'));
  snapshot.clear();

  const next = makeSession('run-2');
  snapshot.retain(next);

  expect(snapshot.peek()).toBe(next);
  expect(snapshot.requireRetained('run-2', CWD)).toBe(next);
});
