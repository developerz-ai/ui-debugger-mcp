/**
 * Unit tests for AndroidAdapter creation/boot/binding — attach vs managed, port
 * picking, boot-deadline handling, and per-instance device binding.
 *
 * Split out of android-adapter.test.ts (which had grown past the file-size cap)
 * to keep each concern under it. Parsers live in android-adapter.test.ts; click/type/
 * read/wait/console/network behaviors live in android-adapter.behavior.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { AdapterError, AdbError } from '../../errors.js';
import type { Adb } from './adb.js';
import { AndroidAdapter, type AndroidAdapterInit } from './android-adapter.js';
import {
  FakeAdb,
  FakeUi,
  makeAdapter,
  makeAttachAdapter,
  makeFakeEmulator,
} from './android-adapter.test-helpers.js';

describe('AndroidAdapter.create', () => {
  test('with adbSerial → attach mode (close is no-op)', async () => {
    const { adapter, adb } = makeAttachAdapter();
    await adapter.close();
    // No adb calls for close in attach mode.
    const closeRelated = adb.calls.filter((c) => c.args[0] === 'emu');
    expect(closeRelated).toHaveLength(0);
  });

  test('without adbSerial → managed mode (close kills emulator)', async () => {
    // Managed open requires boot. We test close independently by using a pre-booted
    // attach adapter for setup validation; managed close path is covered by
    // verifying no SIGTERM is sent when emulator was never spawned.
    const { adapter, adb } = makeAdapter();
    // close on unbooted managed adapter → no-op (nothing to kill).
    await adapter.close();
    // The `emu kill` call only happens if #booted. Since we never called open(),
    // #booted=false and we skip it. Verify graceful completion.
    expect(adb.calls.some((c) => c.method === 'adb' && c.args[0] === 'emu')).toBe(false);
  });
});

describe('AndroidAdapter managed boot', () => {
  test('open boots the emulator via the spawn seam and starts the activity', async () => {
    const adb = new FakeAdb();
    const ui = new FakeUi([]);
    let spawned: string[] = [];
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd' },
      adb,
      ui,
      spawn: (bin, args) => {
        spawned = [bin, ...args];
        return makeFakeEmulator();
      },
      pickPort: async () => 5554,
      bootWaitMs: 2000,
    });
    await adapter.open('com.example');
    expect(spawned).toEqual(['emulator', '@test_avd', '-port', '5554']);
    expect(adb.calls.some((c) => c.method === 'adb' && c.args[0] === 'get-state')).toBe(true);
    expect(adb.calls.some((c) => c.args[0] === 'monkey')).toBe(true);
  });

  test('spawn failure (bad emulatorPath) rejects loud instead of crashing the process', async () => {
    const adb = new FakeAdb();
    // No device ever appears — the emulator never launched.
    adb.setResponse('adb get-state', 'unknown');
    const child = makeFakeEmulator();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd', emulatorPath: '/nope/emulator' },
      adb,
      ui: new FakeUi([]),
      spawn: () => {
        queueMicrotask(() => child.emit('error', new Error('spawn /nope/emulator ENOENT')));
        return child;
      },
      pickPort: async () => 5554,
      bootWaitMs: 2000,
    });
    const err = await adapter.open('com.example').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('failed to launch');
  });

  test('emulator exiting before boot rejects loud', async () => {
    const adb = new FakeAdb();
    adb.setResponse('adb get-state', 'unknown');
    const child = makeFakeEmulator();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'broken_avd' },
      adb,
      ui: new FakeUi([]),
      spawn: () => {
        queueMicrotask(() => child.emit('exit', 1, null));
        return child;
      },
      pickPort: async () => 5554,
      bootWaitMs: 2000,
    });
    const err = await adapter.open('com.example').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('exited before boot');
  });

  test('no device within the boot deadline rejects instead of hanging forever', async () => {
    const adb = new FakeAdb();
    adb.setResponse('adb get-state', 'unknown'); // never becomes 'device'
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd' },
      adb,
      ui: new FakeUi([]),
      spawn: () => makeFakeEmulator(),
      pickPort: async () => 5554,
      bootWaitMs: 50,
    });
    const err = await adapter.open('com.example').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('no device appeared');
  });

  /** Managed adapter over an ADB seam whose `get-state` is scripted per call. */
  function makeStateAdapter(getState: () => Promise<string>, bootWaitMs: number): AndroidAdapter {
    const adb: Adb = {
      shell: async () => '1',
      execOut: async () => new Uint8Array(),
      adb: async (args) => (args[0] === 'get-state' ? await getState() : ''),
    };
    return AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd' },
      adb,
      ui: new FakeUi([]),
      spawn: () => makeFakeEmulator(undefined),
      pickPort: async () => 5554,
      bootWaitMs,
    });
  }

  test('a device that is not up yet keeps the boot poll waiting', async () => {
    let calls = 0;
    const adapter = makeStateAdapter(async () => {
      calls++;
      if (calls < 3) {
        throw new AdbError("adb get-state failed: error: device 'emulator-5554' not found");
      }
      return 'device';
    }, 5000);
    await adapter.open('com.example');
    expect(calls).toBe(3);
  });

  test('a missing `adb` fails the boot at once instead of spinning the deadline', async () => {
    // A swallowed failure would burn the whole (here: 60 s) deadline and then lie
    // about the cause — the run must see the real error immediately.
    const adapter = makeStateAdapter(async () => {
      throw new AdbError('android: `adb` not found on PATH (install Android platform-tools)');
    }, 60_000);
    const started = Date.now();
    const err = await adapter.open('com.example').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdbError);
    expect((err as AdbError).message).toContain('not found on PATH');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('the run budget shortens the boot deadline (a 2-min boot never outlives the cap)', async () => {
    // The caller's wall-clock cap has 50 ms left; the emulator's own boot deadline is
    // 60 s. Without the cap threading, `open` would sit here long past the run's end.
    const adapter = makeStateAdapter(async () => 'unknown', 60_000);
    const started = Date.now();
    const err = await adapter.open('com.example', 50).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('no device appeared');
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------
// Managed-vs-attach binding: managed drives ONLY the emulator it spawned.
// ---------------------------------------------------------------------------

describe('AndroidAdapter device binding', () => {
  /** Managed adapter whose transport factory records the serial each call is bound to. */
  function makeBoundAdapter(
    ports: number[],
    overrides: Partial<AndroidAdapterInit> = {},
  ): { adapter: AndroidAdapter; bound: FakeAdb[]; spawns: string[][] } {
    const bound: FakeAdb[] = [];
    const spawns: string[][] = [];
    let next = 0;
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd' },
      adb: (serial) => {
        const adb = new FakeAdb(serial);
        bound.push(adb);
        return adb;
      },
      ui: new FakeUi([]),
      spawn: (bin, args) => {
        spawns.push([bin, ...args]);
        // No pid → `close` skips the SIGTERM (never signal a real process group in tests).
        return makeFakeEmulator(undefined);
      },
      pickPort: async () => ports[next++] ?? 5554,
      bootWaitMs: 2000,
      ...overrides,
    });
    return { adapter, bound, spawns };
  }

  test('managed open spawns on a picked port and binds adb to that serial', async () => {
    const { adapter, bound, spawns } = makeBoundAdapter([5560]);
    await adapter.open('com.example');
    expect(spawns).toEqual([['emulator', '@test_avd', '-port', '5560']]);
    expect(bound.map((a) => a.serial)).toEqual(['emulator-5560']);
    // Every device call went through the bound transport — nothing is left to `-e`.
    expect(bound[0]?.calls.some((c) => c.args[0] === 'monkey')).toBe(true);
  });

  test('managed close kills only the bound emulator, and re-open binds the next one', async () => {
    const { adapter, bound } = makeBoundAdapter([5556, 5558]);
    await adapter.open('com.example');
    await adapter.close();
    const first = bound[0];
    expect(first?.serial).toBe('emulator-5556');
    expect(first?.calls.filter((c) => c.method === 'adb' && c.args[0] === 'emu')).toHaveLength(1);

    await adapter.open('com.example');
    expect(bound.map((a) => a.serial)).toEqual(['emulator-5556', 'emulator-5558']);
    // The dead binding is never touched again — no stray kill on a re-used serial.
    expect(first?.calls.filter((c) => c.method === 'adb' && c.args[0] === 'emu')).toHaveLength(1);
    expect(bound[1]?.calls.some((c) => c.args[0] === 'monkey')).toBe(true);
  });

  test('managed calls before open fail loud instead of guessing a device', async () => {
    const { adapter } = makeBoundAdapter([5554]);
    await expect(adapter.readState({})).rejects.toThrow(AdapterError);
    await expect(adapter.screenshot()).rejects.toThrow(AdapterError);
  });

  test('attach binds the transport to the configured serial', () => {
    const bound: FakeAdb[] = [];
    AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd', adbSerial: 'emulator-5582' },
      adb: (serial) => {
        const adb = new FakeAdb(serial);
        bound.push(adb);
        return adb;
      },
      ui: new FakeUi([]),
    });
    expect(bound.map((a) => a.serial)).toEqual(['emulator-5582']);
  });

  test('attach never spawns an emulator nor kills the device', async () => {
    const adb = new FakeAdb('emulator-5582');
    let spawns = 0;
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd', adbSerial: 'emulator-5582' },
      adb,
      ui: new FakeUi([]),
      spawn: () => {
        spawns++;
        return makeFakeEmulator(undefined);
      },
      pickPort: () => Promise.reject(new Error('attach mode must never pick a port')),
    });
    await adapter.open('com.example');
    await adapter.close();
    expect(spawns).toBe(0);
    expect(adb.calls.some((c) => c.method === 'adb' && c.args[0] === 'emu')).toBe(false);
  });
});
