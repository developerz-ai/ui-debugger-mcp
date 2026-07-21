import { expect, test } from 'bun:test';
import {
  captureIdentity,
  isPidAlive,
  ownerAlive,
  parseStartTicks,
  verifyIdentity,
} from './process-identity.js';

// `/proc` is Linux-only; skip the live-process cases elsewhere (CI is Linux).
const linuxOnly = process.platform === 'linux' ? test : test.skip;

test('parseStartTicks reads field 22 even when comm holds spaces and parens', () => {
  // comm = "(sd-pam) x" — embedded space + parens; the anchor must be the LAST ')'.
  const stat = '42 ((sd-pam) x) S 1 42 42 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 26393456 99 0';
  expect(parseStartTicks(stat)).toBe(26_393_456);
});

test('parseStartTicks returns null when there is no closing paren', () => {
  expect(parseStartTicks('garbage without a paren')).toBeNull();
});

test('parseStartTicks returns null when field 22 is missing', () => {
  expect(parseStartTicks('42 (proc) S 1 42')).toBeNull();
});

test('verifyIdentity is unverifiable when no start time was recorded', () => {
  // A null fingerprint (e.g. recorded on a non-Linux host) → callers fall back to liveness.
  expect(verifyIdentity(process.pid, { startTicks: null })).toBe('unverifiable');
});

linuxOnly('captureIdentity + verifyIdentity matches this live process', () => {
  const id = captureIdentity(); // fingerprint of this very process
  expect(id.startTicks).not.toBeNull();
  expect(verifyIdentity(process.pid, id)).toBe('match');
});

linuxOnly('verifyIdentity flags a recycled PID as stale', () => {
  const id = captureIdentity();
  // Same live PID, but a fingerprint that no longer matches → the PID was reused.
  expect(verifyIdentity(process.pid, { startTicks: (id.startTicks ?? 0) + 1 })).toBe('stale');
});

linuxOnly('verifyIdentity reports a vanished PID as gone', () => {
  // 999_999_999 is effectively never a live process.
  expect(verifyIdentity(999_999_999, { startTicks: 123 })).toBe('gone');
});

test('isPidAlive sees this process and not a vanished one', () => {
  expect(isPidAlive(process.pid)).toBe(true);
  expect(isPidAlive(999_999_999)).toBe(false);
});

test('ownerAlive falls back to a liveness probe when the fingerprint is unverifiable', () => {
  expect(ownerAlive(process.pid, { startTicks: null })).toEqual({
    check: 'unverifiable',
    alive: true,
  });
  expect(ownerAlive(999_999_999, { startTicks: null })).toEqual({
    check: 'unverifiable',
    alive: false,
  });
});

linuxOnly('ownerAlive: our own live process matches', () => {
  expect(ownerAlive(process.pid, captureIdentity())).toEqual({ check: 'match', alive: true });
});

linuxOnly('ownerAlive: a recycled or vanished PID is dead, however live the PID looks', () => {
  const ticks = captureIdentity().startTicks ?? 0;
  // Live PID, wrong fingerprint — an unrelated process inherited it.
  expect(ownerAlive(process.pid, { startTicks: ticks + 1 })).toEqual({
    check: 'stale',
    alive: false,
  });
  expect(ownerAlive(999_999_999, { startTicks: ticks })).toEqual({ check: 'gone', alive: false });
});
