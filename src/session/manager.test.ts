import { expect, test } from 'bun:test';
import { SessionBusyError, SessionNotFoundError } from '../errors.js';
import { type ManagedSession, SessionManager } from './manager.js';

/** Minimal fake session that records how many times it was closed. */
class FakeSession implements ManagedSession {
  closeCalls = 0;
  constructor(
    readonly id: string,
    private readonly closeError?: Error,
    private readonly closeGate?: Promise<void>,
  ) {}

  async close(): Promise<void> {
    this.closeCalls += 1;
    // A close held open until `release()` fires — the delayed teardown.
    if (this.closeGate) await this.closeGate;
    if (this.closeError) throw this.closeError;
  }
}

/** A promise plus the handle that resolves it — the gate a test holds shut. */
function deferredClose(): { gate: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

const CWD = '/projects/app-a';
const OTHER = '/projects/app-b';

// --- start / get ------------------------------------------------------------

test('start registers a session and get returns it', () => {
  const manager = new SessionManager();
  const session = new FakeSession('s1');
  expect(manager.start(CWD, session)).toBe(session);
  expect(manager.get(CWD)).toBe(session);
});

test('start throws SessionBusyError when a session is already active for the cwd', () => {
  const manager = new SessionManager();
  manager.start(CWD, new FakeSession('s1'));
  expect(() => manager.start(CWD, new FakeSession('s2'))).toThrow(SessionBusyError);
});

test('busy error names the active session and cwd', () => {
  const manager = new SessionManager();
  manager.start(CWD, new FakeSession('s1'));
  expect(() => manager.start(CWD, new FakeSession('s2'))).toThrow(/'s1'/);
  expect(() => manager.start(CWD, new FakeSession('s2'))).toThrow(CWD);
});

test('sessions are isolated per cwd', () => {
  const manager = new SessionManager();
  const a = manager.start(CWD, new FakeSession('a'));
  const b = manager.start(OTHER, new FakeSession('b'));
  expect(manager.get(CWD)).toBe(a);
  expect(manager.get(OTHER)).toBe(b);
});

test('get throws SessionNotFoundError when no session is active', () => {
  const manager = new SessionManager();
  expect(() => manager.get(CWD)).toThrow(SessionNotFoundError);
});

// --- has --------------------------------------------------------------------

test('has reflects whether a session is active', () => {
  const manager = new SessionManager();
  expect(manager.has(CWD)).toBe(false);
  manager.start(CWD, new FakeSession('s1'));
  expect(manager.has(CWD)).toBe(true);
});

// --- end --------------------------------------------------------------------

test('end closes the session and frees the lock', async () => {
  const manager = new SessionManager();
  const session = new FakeSession('s1');
  manager.start(CWD, session);

  await manager.end(CWD);

  expect(session.closeCalls).toBe(1);
  expect(manager.has(CWD)).toBe(false);
  // The slot is free, so a new run can start.
  expect(() => manager.start(CWD, new FakeSession('s2'))).not.toThrow();
});

test('end throws SessionNotFoundError when nothing is active', async () => {
  const manager = new SessionManager();
  await expect(manager.end(CWD)).rejects.toBeInstanceOf(SessionNotFoundError);
});

test('end frees the lock even when close() throws, and surfaces the error', async () => {
  const manager = new SessionManager();
  const session = new FakeSession('s1', new Error('chrome would not close'));
  manager.start(CWD, session);

  await expect(manager.end(CWD)).rejects.toThrow('chrome would not close');
  // Lock released despite the failed teardown — the project is not wedged.
  expect(manager.has(CWD)).toBe(false);
  expect(() => manager.start(CWD, new FakeSession('s2'))).not.toThrow();
});

// --- closing gate (delayed teardown) -----------------------------------------

test('start is refused while the previous session is still closing', async () => {
  const manager = new SessionManager();
  const { gate, release } = deferredClose();
  manager.start(CWD, new FakeSession('s1', undefined, gate));

  const ending = manager.end(CWD); // unawaited: the teardown is in flight
  // Slot-free ≠ project-free: the slot is gone, but the close has not settled.
  expect(manager.has(CWD)).toBe(false);
  expect(manager.closingId(CWD)).toBe('s1');

  expect(() => manager.start(CWD, new FakeSession('s2'))).toThrow(SessionBusyError);
  expect(() => manager.start(CWD, new FakeSession('s2'))).toThrow(/'s1'/);
  expect(() => manager.start(CWD, new FakeSession('s2'))).toThrow(CWD);

  release();
  await ending;
  expect(manager.closingId(CWD)).toBeUndefined(); // the gate reopens on settle
  expect(() => manager.start(CWD, new FakeSession('s2'))).not.toThrow();
});

test('a failed close also reopens the gate', async () => {
  const manager = new SessionManager();
  manager.start(CWD, new FakeSession('s1', new Error('chrome would not close')));

  await expect(manager.end(CWD)).rejects.toThrow('chrome would not close');
  // The error reached the caller AND the gate lifted: a failed teardown never
  // wedges the project shut.
  expect(manager.closingId(CWD)).toBeUndefined();
  expect(() => manager.start(CWD, new FakeSession('s2'))).not.toThrow();
});
