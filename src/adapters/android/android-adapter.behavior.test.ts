/**
 * Unit tests for AndroidAdapter's per-call behavior — readState/find/click/type/
 * pressKey/scroll/screenshot/waitFor/console/network, plus error wrapping.
 *
 * Split out of android-adapter.test.ts (which had grown past the file-size cap).
 * Creation/boot/binding live in android-adapter.lifecycle.test.ts; pure parsers
 * live in android-adapter.test.ts.
 */

import { describe, expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { Node } from '../contract.js';
import { AndroidAdapter } from './android-adapter.js';
import { FakeAdb, makeAdapter, makeNode } from './android-adapter.test-helpers.js';
import type { AndroidNode, UiAutomatorSource } from './uiautomator.js';

describe('AndroidAdapter.readState', () => {
  test('returns shaped nodes from ui.dump', async () => {
    const nodes = [makeNode({ name: 'Submit' }), makeNode({ name: 'Cancel' })];
    const { adapter } = makeAdapter({ nodes });
    const result = await adapter.readState({});
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe('Submit');
  });

  test('applies query filter', async () => {
    const nodes = [makeNode({ name: 'Submit' }), makeNode({ name: 'Cancel' })];
    const { adapter } = makeAdapter({ nodes });
    const result = await adapter.readState({ query: 'Submit' });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Submit');
  });

  test('applies limit', async () => {
    const nodes = [makeNode({ name: 'A' }), makeNode({ name: 'B' }), makeNode({ name: 'C' })];
    const { adapter } = makeAdapter({ nodes });
    const result = await adapter.readState({ limit: 2 });
    expect(result).toHaveLength(2);
  });
});

describe('AndroidAdapter.find', () => {
  test('returns first matching node', async () => {
    const nodes = [makeNode({ name: 'OK' }), makeNode({ name: 'Cancel' })];
    const { adapter } = makeAdapter({ nodes });
    const found = await adapter.find({ query: 'OK' });
    expect(found?.name).toBe('OK');
  });

  test('returns null when nothing matches', async () => {
    const { adapter } = makeAdapter({ nodes: [makeNode({ name: 'Save' })] });
    expect(await adapter.find({ query: 'NotHere' })).toBeNull();
  });
});

describe('AndroidAdapter.click', () => {
  test('resolves selector → taps center', async () => {
    const node = makeNode({ bounds: { x: 100, y: 200, width: 200, height: 100 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await adapter.click('Save');
    const tap = adb.calls.find((c) => c.args[0] === 'input' && c.args[1] === 'tap');
    expect(tap?.args[2]).toBe('200');
    expect(tap?.args[3]).toBe('250');
  });

  test('accepts a Node ref directly', async () => {
    const node: Node = {
      role: 'button',
      name: 'OK',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
      enabled: true,
    };
    const { adapter, adb } = makeAdapter();
    await adapter.click(node);
    const tap = adb.calls.find((c) => c.args[0] === 'input' && c.args[1] === 'tap');
    expect(tap?.args[2]).toBe('50');
    expect(tap?.args[3]).toBe('25');
  });

  test('throws AdapterError when selector not found', async () => {
    const { adapter } = makeAdapter({ nodes: [] });
    await expect(adapter.click('NotHere')).rejects.toThrow(AdapterError);
  });

  test('zero-bounds node → throws, never taps (0,0)', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 0, height: 0 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await expect(adapter.click('Save')).rejects.toThrow(AdapterError);
    expect(adb.calls.filter((c) => c.args[1] === 'tap')).toHaveLength(0);
  });
});

describe('AndroidAdapter.type', () => {
  test('focuses (tap) then types', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 200, height: 60 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await adapter.type('Save', 'hello');
    const ops = adb.calls.filter((c) => c.args[0] === 'input');
    // tap first, then text
    expect(ops[0]?.args[1]).toBe('tap');
    expect(ops[1]?.args[1]).toBe('text');
    expect(ops[1]?.args[2]).toBe('hello');
  });

  test('empty text → only taps, no text call', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 100, height: 50 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await adapter.type('Save', '');
    const textCalls = adb.calls.filter((c) => c.args[1] === 'text');
    expect(textCalls).toHaveLength(0);
  });

  test('literal %s in text is chunked across input text calls (no space mangling)', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 100, height: 50 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await adapter.type('Save', '50%sale');
    const textCalls = adb.calls.filter((c) => c.args[1] === 'text');
    expect(textCalls.map((c) => c.args[2])).toEqual(['50%', 'sale']);
  });

  test('newline → ENTER keyevent between lines, never in the shell argv', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 100, height: 50 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await adapter.type('Save', 'hi\nrm -rf /sdcard');
    const ops = adb.calls.filter((c) => c.args[0] === 'input').map((c) => c.args.slice(1));
    expect(ops).toEqual([
      ['tap', '50', '25'],
      ['text', 'hi'],
      ['keyevent', 'KEYCODE_ENTER'],
      ['text', 'rm%s-rf%s/sdcard'],
    ]);
    expect(adb.calls.every((c) => c.args.every((a) => !a.includes('\n')))).toBe(true);
  });

  test('other control chars → AdapterError, nothing typed', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 100, height: 50 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await expect(adapter.type('Save', 'hi\tthere')).rejects.toThrow(AdapterError);
    expect(adb.calls.filter((c) => c.args[1] === 'text')).toHaveLength(0);
  });

  test('zero-bounds node → throws before focusing or typing', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 0, height: 0 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await expect(adapter.type('Save', 'hello')).rejects.toThrow(AdapterError);
    expect(adb.calls.filter((c) => c.args[0] === 'input')).toHaveLength(0);
  });
});

describe('AndroidAdapter.pressKey', () => {
  test('sends keyevent', async () => {
    const { adapter, adb } = makeAdapter();
    await adapter.pressKey('enter');
    const kv = adb.calls.find((c) => c.args[1] === 'keyevent');
    expect(kv?.args[2]).toBe('KEYCODE_ENTER');
  });

  test('empty key → throws AdapterError', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.pressKey('')).rejects.toThrow(AdapterError);
  });
});

describe('AndroidAdapter.scroll', () => {
  test('down scroll → swipe shell call', async () => {
    const { adapter, adb } = makeAdapter();
    await adapter.scroll({ direction: 'down' });
    const swipe = adb.calls.find(
      (c) => c.method === 'shell' && c.args[0] === 'input' && c.args[1] === 'swipe',
    );
    expect(swipe).toBeDefined();
  });

  test('within-scoped scroll resolves region', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 400, height: 800 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await adapter.scroll({ direction: 'up', within: 'Save' });
    const swipe = adb.calls.find((c) => c.method === 'shell' && c.args[1] === 'swipe');
    expect(swipe).toBeDefined();
  });
});

describe('AndroidAdapter.screenshot', () => {
  test('calls execOut screencap', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]);
    const { adapter, adb } = makeAdapter();
    adb.setResponse('screencap -p', pngBytes);
    const result = await adapter.screenshot();
    expect(result).toBeInstanceOf(Uint8Array);
    const call = adb.calls.find((c) => c.method === 'execOut');
    expect(call?.args).toContain('screencap');
  });
});

describe('AndroidAdapter.waitFor', () => {
  test('throws AdapterError for networkIdle (unsupported)', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.waitFor({ networkIdle: true })).rejects.toThrow(AdapterError);
  });

  test('throws AdapterError when no query given', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.waitFor({})).rejects.toThrow(AdapterError);
  });

  test('resolves immediately when node present', async () => {
    const nodes = [makeNode({ name: 'Login' })];
    const { adapter } = makeAdapter({ nodes });
    await expect(adapter.waitFor({ query: 'Login', timeout: 1000 })).resolves.toBeUndefined();
  });

  test('times out when node never appears', async () => {
    const { adapter } = makeAdapter({ nodes: [] });
    await expect(adapter.waitFor({ query: 'GhostButton', timeout: 100 })).rejects.toThrow(
      AdapterError,
    );
  });
});

describe('AndroidAdapter.console', () => {
  const RAW_LOGCAT =
    '1546300800.000  1000  1001 I MyTag: hello\n1546300801.000  1000  1001 E Crash: boom\n';

  test('calls logcat and returns parsed entries (newest first)', async () => {
    const { adapter, adb } = makeAdapter();
    adb.setResponse('logcat -v epoch -t 500', RAW_LOGCAT);
    const entries = await adapter.console({});
    expect(entries.length).toBeGreaterThan(0);
    // Newest first → error (ts=1546300801000) before info (ts=1546300800000).
    expect(entries[0]?.level).toBe('error');
  });

  test('applies limit', async () => {
    const { adapter, adb } = makeAdapter();
    adb.setResponse('logcat -v epoch -t 500', RAW_LOGCAT);
    const entries = await adapter.console({ limit: 2 });
    expect(entries.length).toBeLessThanOrEqual(2);
  });

  test('applies level_eq filter', async () => {
    const { adapter, adb } = makeAdapter();
    adb.setResponse('logcat -v epoch -t 500', RAW_LOGCAT);
    const entries = await adapter.console({ filters: { level_eq: 'error' } });
    expect(entries.every((e) => e.level === 'error')).toBe(true);
  });

  test('limit never shrinks the raw logcat window (filters see the full tail)', async () => {
    const { adapter, adb } = makeAdapter();
    // The only error is the OLDER line — a limit-sized (1-line) window would miss it.
    const oldErrorRaw =
      '1546300800.000  1000  1001 E Crash: boom\n1546300801.000  1000  1001 I MyTag: hello\n';
    adb.setResponse('logcat -v epoch -t 500', oldErrorRaw);
    const entries = await adapter.console({ limit: 1, filters: { level_eq: 'error' } });
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
  });

  test('limit above the default tail widens the window', async () => {
    const { adapter, adb } = makeAdapter();
    adb.setResponse('logcat -v epoch -t 900', RAW_LOGCAT);
    const entries = await adapter.console({ limit: 900 });
    expect(entries.length).toBeGreaterThan(0);
    const call = adb.calls.find((c) => c.args[0] === 'logcat');
    expect(call?.args).toContain('900');
  });
});

describe('AndroidAdapter.network', () => {
  test('always throws AdapterError (no ADB network channel)', async () => {
    const { adapter } = makeAdapter();
    await expect(adapter.network()).rejects.toThrow(AdapterError);
  });
});

describe('AndroidAdapter error wrapping', () => {
  test('non-UiDebuggerError from ui.dump is wrapped as AdapterError', async () => {
    const adb = new FakeAdb();
    const ui: UiAutomatorSource = {
      async dump(): Promise<AndroidNode[]> {
        throw new TypeError('unexpected null');
      },
    };
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd' },
      adb,
      ui,
    });
    await expect(adapter.readState()).rejects.toThrow(AdapterError);
  });

  test('UiDebuggerError passes through un-rewrapped', async () => {
    const adb = new FakeAdb();
    const ui: UiAutomatorSource = {
      async dump(): Promise<AndroidNode[]> {
        throw new AdapterError('original');
      },
    };
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', avd: 'test_avd' },
      adb,
      ui,
    });
    const err = await adapter.readState().catch((e: unknown) => e);
    expect(err instanceof AdapterError).toBe(true);
    expect((err as AdapterError).message).toBe('original');
  });
});
