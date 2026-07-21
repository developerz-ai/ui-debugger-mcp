/**
 * Unit tests for the ADB transport (`adb.ts`) — the one module that actually spawns.
 *
 * Two seams, two kinds of test. Argv shape is a pure property, so it is asserted through
 * the {@link AdbExec} seam — recording the argv the transport *would* have spawned, never
 * at the mercy of a child's stdout on a loaded CI box. Everything that only a real
 * subprocess can prove — binary-safe `exec-out`, and the loud {@link AdbError} for a
 * missing binary, a non-zero exit and a timeout expiry — still spawns, via the `bin` seam
 * pointed at `sh`/`sleep` (no emulator and no `adb` binary needed).
 */

import { expect, test } from 'bun:test';
import { AdbError } from '../../errors.js';
import { AdbCli, type AdbExec, pendingStateOrThrow } from './adb.js';

/** A recording {@link AdbExec}: captures every argv, answers with the given stdout bytes. */
function recorder(stdout: Uint8Array = new Uint8Array()) {
  const calls: { bin: string; args: string[]; timeoutMs: number }[] = [];
  const exec: AdbExec = async (bin, args, timeoutMs) => {
    calls.push({ bin, args, timeoutMs });
    return stdout;
  };
  return { calls, exec };
}

// ---------------------------------------------------------------------------
// AdbCli — argv shape
// ---------------------------------------------------------------------------

test('shell puts the device flags before the subcommand', async () => {
  const { calls, exec } = recorder();
  await new AdbCli(['-s', 'emulator-5554'], { exec }).shell(['input', 'tap', '1', '2']);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.bin).toBe('adb');
  expect(calls[0]?.args).toEqual(['-s', 'emulator-5554', 'shell', 'input', 'tap', '1', '2']);
});

test('execOut puts the device flags before exec-out', async () => {
  const { calls, exec } = recorder();
  await new AdbCli(['-s', 'emulator-5554'], { exec }).execOut(['screencap', '-p']);
  expect(calls[0]?.args).toEqual(['-s', 'emulator-5554', 'exec-out', 'screencap', '-p']);
});

test('adb passes top-level args through unchanged', async () => {
  const { calls, exec } = recorder();
  await new AdbCli(['-s', 'emulator-5554'], { exec }).adb(['emu', 'kill']);
  expect(calls[0]?.args).toEqual(['-s', 'emulator-5554', 'emu', 'kill']);
});

test('every call carries the configured binary and timeout', async () => {
  const { calls, exec } = recorder();
  await new AdbCli([], { exec, bin: '/opt/adb', timeoutMs: 1234 }).shell(['getprop']);
  expect(calls[0]).toMatchObject({ bin: '/opt/adb', timeoutMs: 1234 });
});

test('text channels decode the bytes as UTF-8', async () => {
  const { exec } = recorder(new TextEncoder().encode('café ☕\n'));
  expect(await new AdbCli([], { exec }).shell(['getprop'])).toBe('café ☕\n');
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
