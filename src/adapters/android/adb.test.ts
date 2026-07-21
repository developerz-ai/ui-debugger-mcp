/**
 * Unit tests for the ADB transport (`adb.ts`) — the one module that actually spawns.
 *
 * No emulator and no `adb` binary needed: {@link AdbCli} takes a `bin` seam, so the
 * tests point it at `sh`/`sleep` and assert on real subprocess behaviour — argv shape
 * (flags before the subcommand), binary-safe `exec-out`, and the loud {@link AdbError}
 * for every failure mode (missing binary, non-zero exit, timeout expiry).
 */

import { expect, test } from 'bun:test';
import { AdbError } from '../../errors.js';
import { AdbCli, pendingStateOrThrow } from './adb.js';

// ---------------------------------------------------------------------------
// AdbCli — argv shape
// ---------------------------------------------------------------------------

test('shell puts the device flags before the subcommand', async () => {
  // `sh -c '<script>' a b c` → $0=a, $@=b c, so the echo prints the argv tail verbatim.
  const cli = new AdbCli(['-c', 'echo "$0 $*"'], { bin: 'sh' });
  expect((await cli.shell(['input', 'tap', '1', '2'])).trim()).toBe('shell input tap 1 2');
});

test('adb passes top-level args through unchanged', async () => {
  const cli = new AdbCli(['-c', 'echo "$0 $*"'], { bin: 'sh' });
  expect((await cli.adb(['emu', 'kill'])).trim()).toBe('emu kill');
});

test('execOut returns raw bytes (binary-safe, not UTF-8 mangled)', async () => {
  const cli = new AdbCli(['-c', 'printf "\\001\\002\\377"'], { bin: 'sh' });
  const out = await cli.execOut(['screencap', '-p']);
  expect(out).toBeInstanceOf(Uint8Array);
  expect(Array.from(out)).toEqual([1, 2, 255]);
});

// ---------------------------------------------------------------------------
// AdbCli — loud failures
// ---------------------------------------------------------------------------

test('missing binary → AdbError with an install hint', async () => {
  const cli = new AdbCli([], { bin: '/nonexistent/adb-probe' });
  const err = await cli.shell(['getprop']).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AdbError);
  expect((err as AdbError).message).toContain('not found on PATH');
});

test('non-zero exit → AdbError naming the subcommand', async () => {
  const cli = new AdbCli(['-c', 'exit 3'], { bin: 'sh' });
  const err = await cli.shell(['uiautomator', 'dump']).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AdbError);
  expect((err as AdbError).message).toContain('adb shell failed');
});

test('a wedged call is killed at the timeout instead of hanging', async () => {
  const cli = new AdbCli([], { bin: 'sleep', timeoutMs: 100 });
  const started = Date.now();
  const err = await cli.adb(['30']).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AdbError);
  expect((err as AdbError).message).toContain('timed out after 100ms');
  expect(Date.now() - started).toBeLessThan(5000);
});

test('execOut honours the timeout too', async () => {
  const cli = new AdbCli(['-c', 'sleep 30'], { bin: 'sh', timeoutMs: 100 });
  const err = await cli.execOut(['screencap', '-p']).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(AdbError);
  expect((err as AdbError).message).toContain('timed out after 100ms');
});

// ---------------------------------------------------------------------------
// pendingStateOrThrow — only "not up yet" keeps a boot poll waiting
// ---------------------------------------------------------------------------

for (const message of [
  "adb get-state failed: error: device 'emulator-5560' not found",
  'adb get-state failed: error: no devices/emulators found',
  'adb get-state failed: error: device offline',
  'adb get-state failed: error: device still authorizing',
]) {
  test(`keeps waiting on: ${message}`, () => {
    expect(pendingStateOrThrow(new AdbError(message))).toBe('');
  });
}

test('rethrows a missing `adb` instead of matching its "not found" wording', () => {
  const err = new AdbError('android: `adb` not found on PATH (install Android platform-tools)');
  expect(() => pendingStateOrThrow(err)).toThrow(err);
});

test('rethrows a timeout — a wedged adb is not "keep waiting"', () => {
  const err = new AdbError(
    'adb get-state timed out after 30000ms (SIGKILLed — adb or the emulator is wedged)',
  );
  expect(() => pendingStateOrThrow(err)).toThrow(err);
});

test('rethrows an ambiguous target', () => {
  const err = new AdbError('adb get-state failed: error: more than one device/emulator');
  expect(() => pendingStateOrThrow(err)).toThrow(err);
});

test('rethrows anything that is not an AdbError', () => {
  const err = new TypeError('bug in the transport seam');
  expect(() => pendingStateOrThrow(err)).toThrow(err);
});
