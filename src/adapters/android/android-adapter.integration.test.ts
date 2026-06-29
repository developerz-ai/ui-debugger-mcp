/**
 * Integration tests for the Android adapter — require a real attached device
 * or running emulator. Skipped unless `ANDROID_INTEGRATION_TESTS=1` is set
 * **and** `adb devices` shows at least one device.
 *
 * Run against a real emulator:
 *   ANDROID_INTEGRATION_TESTS=1 bun test src/adapters/android/android-adapter.integration.test.ts
 *
 * Run against a specific serial:
 *   ANDROID_SERIAL=emulator-5554 ANDROID_INTEGRATION_TESTS=1 bun test ...
 *
 * The tests use a minimal fixture APK / default launcher — they do NOT require
 * a custom app. Screenshot + readState tests exercise real ADB round-trips.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AdapterError } from '../../errors.js';
import { AndroidAdapter } from './android-adapter.js';

const pExecFile = promisify(execFile);

const SKIP = process.env.ANDROID_INTEGRATION_TESTS !== '1';
const SERIAL = process.env.ANDROID_SERIAL ?? null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns the first online device serial, or null. */
async function firstOnlineDevice(): Promise<string | null> {
  try {
    const { stdout } = await pExecFile('adb', ['devices']);
    const lines = stdout.split('\n').slice(1); // skip header
    for (const line of lines) {
      const [serial, state] = line.trim().split(/\s+/);
      if (serial && state === 'device') return serial;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Suite — skipped unless opted in and a device is present
// ---------------------------------------------------------------------------

describe('AndroidAdapter integration', () => {
  let adapter: AndroidAdapter;
  let serial: string;

  beforeAll(async () => {
    if (SKIP) return;
    serial = SERIAL ?? (await firstOnlineDevice()) ?? '';
    if (!serial) return;
    adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'integration_avd', adbSerial: serial },
    });
  });

  afterAll(async () => {
    if (SKIP || !serial) return;
    await adapter.close().catch(() => undefined);
  });

  // Helper: skip individual tests when no device is available.
  const skipIf = () => SKIP || !serial;

  test('screenshot returns non-empty Uint8Array', async () => {
    if (skipIf()) return;
    const bytes = await adapter.screenshot();
    expect(bytes).toBeInstanceOf(Uint8Array);
    // PNG magic bytes: 89 50 4E 47
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50);
    expect(bytes[2]).toBe(0x4e);
    expect(bytes[3]).toBe(0x47);
  });

  test('readState returns a non-empty tree', async () => {
    if (skipIf()) return;
    const nodes = await adapter.readState({});
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) {
      expect(typeof n.role).toBe('string');
      expect(typeof n.name).toBe('string');
      expect(typeof n.bounds.x).toBe('number');
    }
  });

  test('readState with limit=1 returns at most one node', async () => {
    if (skipIf()) return;
    const nodes = await adapter.readState({ limit: 1 });
    expect(nodes.length).toBeLessThanOrEqual(1);
  });

  test('console drains logcat without throwing', async () => {
    if (skipIf()) return;
    const entries = await adapter.console({ limit: 10 });
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeLessThanOrEqual(10);
  });

  test('network always throws AdapterError (no ADB channel)', async () => {
    if (skipIf()) return;
    await expect(adapter.network()).rejects.toThrow(AdapterError);
  });

  test('waitFor networkIdle throws AdapterError', async () => {
    if (skipIf()) return;
    await expect(adapter.waitFor({ networkIdle: true })).rejects.toThrow(AdapterError);
  });

  test('find returns null for a query that matches nothing', async () => {
    if (skipIf()) return;
    const node = await adapter.find({ query: '___nothing_matches_this_xyzzy___' });
    expect(node).toBeNull();
  });

  test('close in attach mode is a no-op (does not throw)', async () => {
    if (skipIf()) return;
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
