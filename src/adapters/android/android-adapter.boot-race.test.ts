/**
 * Managed boot races — a flapping `adb` mid-boot, an emulator that dies after its
 * device appeared, and a stale child's late events. Split from the lifecycle file
 * (already past the size cap).
 */

import { describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn } from 'node:child_process';
import { AdapterError, AdbError } from '../../errors.js';
import type { Adb } from './adb.js';
import { AndroidAdapter } from './android-adapter.js';
import { FakeUi, makeFakeEmulator, stubResolveBin } from './android-adapter.test-helpers.js';

function managed(adb: Adb, spawnChild: () => ChildProcess, bootWaitMs = 5000): AndroidAdapter {
  return AndroidAdapter.create({
    config: { adapter: 'android', headless: true, avd: 'test_avd' },
    adb,
    ui: new FakeUi([]),
    spawn: spawnChild,
    resolveBin: stubResolveBin(),
    pickPort: async () => 5554,
    bootWaitMs,
  });
}

describe('managed boot: getprop poll', () => {
  test('a device that flaps offline mid-boot keeps the poll waiting', async () => {
    let props = 0;
    const adb: Adb = {
      shell: async () => {
        props++;
        if (props < 3) throw new AdbError('adb shell failed: error: device offline');
        return '1';
      },
      execOut: async () => new Uint8Array(),
      adb: async (args) => (args[0] === 'get-state' ? 'device' : ''),
    };
    await managed(adb, () => makeFakeEmulator(undefined)).open('');
    expect(props).toBe(3);
  });

  test('an emulator that dies after its device appeared fails with the exit reason', async () => {
    const child = makeFakeEmulator(undefined);
    const adb: Adb = {
      shell: async () => {
        child.emit('exit', 1, null);
        throw new AdbError("adb shell failed: error: device 'emulator-5554' not found");
      },
      execOut: async () => new Uint8Array(),
      adb: async (args) => (args[0] === 'get-state' ? 'device' : ''),
    };
    const err = await managed(adb, () => child, 60_000)
      .open('')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('exited before boot');
  });
});

describe('managed boot: stale child events', () => {
  test('a closed child exiting late does not fail the next emulator boot', async () => {
    const children: ChildProcess[] = [];
    let polls = 0;
    let reopening = false;
    const adb: Adb = {
      shell: async () => '1',
      execOut: async () => new Uint8Array(),
      adb: async (args) => {
        if (args[0] !== 'get-state') return '';
        if (!reopening) return 'device';
        // The second boot is still waiting for its device when the FIRST child's
        // exit event finally arrives.
        if (++polls === 1) children[0]?.emit('exit', 0, null);
        return polls < 3 ? 'unknown' : 'device';
      },
    };
    const adapter = managed(adb, () => {
      const child = makeFakeEmulator(undefined);
      children.push(child);
      return child;
    });
    await adapter.open('');
    await adapter.close();
    reopening = true;
    await adapter.open('');
    expect(children).toHaveLength(2);
  });
});

describe('managed boot: failure releases the emulator', () => {
  test('a boot that times out terminates the spawned emulator process', async () => {
    const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
    const pid = child.pid as number;
    const adb: Adb = {
      shell: async () => '0',
      execOut: async () => new Uint8Array(),
      adb: async (args) => (args[0] === 'get-state' ? 'device' : ''),
    };
    try {
      const err = await managed(adb, () => child, 300)
        .open('')
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdapterError);
      // Reaped, not orphaned: the group is gone once `open` has rejected.
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  });
});
