/**
 * Unit tests for AndroidAdapter's per-call behavior — readState/find/click/type/
 * pressKey/scroll/screenshot/waitFor/console/network, plus error wrapping.
 *
 * Split out of android-adapter.test.ts (which had grown past the file-size cap).
 * Creation/boot/binding live in android-adapter.lifecycle.test.ts; pure parsers
 * live in android-adapter.test.ts.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { CaptureSink, Node } from '../contract.js';
import { AndroidAdapter } from './android-adapter.js';
import { FakeAdb, FakeUi, makeAdapter, makeNode } from './android-adapter.test-helpers.js';
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

describe('AndroidAdapter act `clear: true` flow', () => {
  // Drives the real AndroidAdapter through the sequence the act `clear: true` belt
  // action emits: focus (tap), select-all chord, delete, then type the new text.
  // Asserts the **exact** adb argv shape (FakeAdb.calls) — including the
  // `input keycombination KEYCODE_CTRL_LEFT KEYCODE_A` chord and the
  // `input keyevent KEYCODE_FORWARD_DEL` delete. If the adapter ever swaps
  // the keyevent sequence the assertions fail verbatim; fixing that is a
  // follow-up, not something this test should silently paper over.
  test('type("", "") → pressKey("Control+a") → pressKey("Delete") → type("hello") emits the expected argv order', async () => {
    const node = makeNode({ bounds: { x: 0, y: 0, width: 200, height: 60 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });

    await adapter.type('Save', '');
    await adapter.pressKey('Control+a');
    await adapter.pressKey('Delete');
    await adapter.type('Save', 'hello');

    // Slice down to the `input` argv the adapter hands the device shell, then
    // strip the `input` prefix so the assertion reads as the belt sees it.
    const ops = adb.calls
      .filter((c) => c.method === 'shell' && c.args[0] === 'input')
      .map((c) => c.args.slice(1));
    expect(ops).toEqual([
      // adapter.type('Save', '') → focus tap, no text call.
      ['tap', '100', '30'],
      // adapter.pressKey('Control+a') → select-all chord (Android 11+ keycombination).
      ['keycombination', 'KEYCODE_CTRL_LEFT', 'KEYCODE_A'],
      // adapter.pressKey('Delete') → forward-delete keyevent.
      ['keyevent', 'KEYCODE_FORWARD_DEL'],
      // adapter.type('Save', 'hello') → re-focus tap, then type the new text.
      ['tap', '100', '30'],
      ['text', 'hello'],
    ]);
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

  test('zero-size within region → throws, never swipes at the screen origin', async () => {
    // uiautomator reports a not-yet-laid-out list as [0,0][0,0]: the swipe would be a
    // 2px drag at the top-left with a negative Y (a notification-shade pull), reported
    // to the blind driver as a successful scroll.
    const node = makeNode({ name: 'Items', bounds: { x: 0, y: 0, width: 0, height: 0 } });
    const { adapter, adb } = makeAdapter({ nodes: [node] });
    await expect(adapter.scroll({ direction: 'down', within: 'Items' })).rejects.toThrow(
      /has zero size \(0x0\)/,
    );
    expect(adb.calls.filter((c) => c.args[1] === 'swipe')).toHaveLength(0);
  });

  test('a zero-size within Node ref is rejected too (not just resolved selectors)', async () => {
    const region: Node = {
      role: 'list',
      name: 'Items',
      bounds: { x: 10, y: 10, width: 300, height: 0 },
      enabled: true,
    };
    const { adapter, adb } = makeAdapter();
    await expect(adapter.scroll({ direction: 'down', within: region })).rejects.toThrow(
      AdapterError,
    );
    expect(adb.calls.filter((c) => c.args[1] === 'swipe')).toHaveLength(0);
  });
});

describe('AndroidAdapter.readState within', () => {
  test('zero-size region throws instead of reporting an empty region', async () => {
    // Silently returning [] tells the blind driver the region holds nothing, when in
    // truth the region itself was never on screen.
    const node = makeNode({ name: 'Items', bounds: { x: 0, y: 0, width: 0, height: 0 } });
    const { adapter } = makeAdapter({ nodes: [node] });
    await expect(adapter.readState({ within: 'Items' })).rejects.toThrow(AdapterError);
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

describe('AndroidAdapter.waitFor budget', () => {
  test('the hierarchy dump inside a wait carries the wait deadline', async () => {
    // The dump is three adb round-trips, each with its own 30s transport cap — the
    // wait's deadline has to reach the dump, or a poll outlives the wait.
    const { adapter, ui } = makeAdapter({ nodes: [makeNode({ name: 'Login' })] });
    await adapter.waitFor({ query: 'Login', timeout: 1000 });
    expect(ui.deadlines).toHaveLength(1);
    const deadline = ui.deadlines[0];
    expect(deadline).toBeDefined();
    // The dump is bounded by the wait, not by the transport's own 30s cap.
    expect(deadline as number).toBeLessThan(Date.now() + 30_000);
    expect(deadline as number).toBeGreaterThan(Date.now());
  });

  test('a node that appears only after the deadline rejects instead of resolving', async () => {
    // The dump answers 150 ms late — past the 50 ms wait. The wait promised "the node
    // is there NOW"; by the time it answered, the budget was gone.
    const { adapter, ui } = makeAdapter({ nodes: [makeNode({ name: 'Login' })] });
    ui.setSlow(150);
    await expect(adapter.waitFor({ query: 'Login', timeout: 50 })).rejects.toThrow(AdapterError);
  });

  test('a wait that expires mid-dump rejects rather than resolving late', async () => {
    const { adapter, ui } = makeAdapter({ nodes: [] });
    ui.setSlow(120);
    await expect(adapter.waitFor({ query: 'GhostButton', timeout: 40 })).rejects.toThrow(
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

  // --- capture sink -------------------------------------------------------------

  /** An adapter over the fake seams with the run's capture sink wired in. */
  function withSink(onLog: CaptureSink): AndroidAdapter {
    const adb = new FakeAdb();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
      adb,
      ui: new FakeUi(),
      onLog,
    });
    adb.setResponse('logcat -v epoch -t 500', RAW_LOGCAT);
    return adapter;
  }

  test('streams one formatted console line per logcat row (drain order)', async () => {
    const lines: Array<[string, string]> = [];
    const adapter = withSink((channel, line) => {
      lines.push([channel, line]);
    });
    await adapter.console({});
    expect(lines).toHaveLength(2);
    expect(lines.every(([channel]) => channel === 'console')).toBe(true);
    // Oldest first, one browser-style line per row: ISO stamp, level, text, @ tag.
    expect(lines[0]?.[1]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z INFO hello @ MyTag$/,
    );
    expect(lines[1]?.[1]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z ERROR boom @ Crash$/,
    );
  });

  test('a second drain of the same rows does not stream them twice', async () => {
    const lines: string[] = [];
    const adapter = withSink((_channel, line) => {
      lines.push(line);
    });
    await adapter.console({});
    await adapter.console({});
    expect(lines).toHaveLength(2);
  });

  test('two drains of a tail larger than the overlap window stream each row once', async () => {
    // The reviewed defect: the remembered window (2000 rows) was smaller than the
    // drained tail (3000). The second read re-streamed the forgotten oldest rows
    // and, re-inserting them as the window's newest entries, evicted the remembered
    // newer rows before they were checked — the whole tail hit the sink twice.
    // The overlap cursor remembers the previous drain's span with two keys, so the
    // identical re-drain streams nothing (nothing to outgrow, nothing to evict).
    const lines: string[] = [];
    const adb = new FakeAdb();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
      adb,
      ui: new FakeUi(),
      onLog: (_channel, line) => {
        lines.push(line);
      },
    });
    const row = (i: number): string => `${1546300800 + i}.000  1000  1001 I Tag: row ${i}`;
    adb.setResponse(
      'logcat -v epoch -t 3000',
      `${Array.from({ length: 3000 }, (_, i) => row(i)).join('\n')}\n`,
    );

    await adapter.console({ limit: 3000 });
    expect(lines).toHaveLength(3000);

    // The same 3000 rows, re-drained: every one sits inside the previous span.
    await adapter.console({ limit: 3000 });
    expect(lines).toHaveLength(3000);
    expect(new Set(lines).size).toBe(3000);
  });

  test('a re-drain whose tail grew streams only the fresh rows', async () => {
    const lines: string[] = [];
    const adb = new FakeAdb();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
      adb,
      ui: new FakeUi(),
      onLog: (_channel, line) => {
        lines.push(line);
      },
    });
    const row = (n: string): string => `1546300800.000  1000  1001 I Tag: ${n}`;
    adb.setResponse('logcat -v epoch -t 500', `${row('one')}\n${row('two')}\n${row('three')}\n`);
    await adapter.console({});
    expect(lines).toHaveLength(3);

    // The tail grew: one/two rotated out, the drain now covers three..five —
    // only four and five arrived since.
    adb.setResponse('logcat -v epoch -t 500', `${row('three')}\n${row('four')}\n${row('five')}\n`);
    await adapter.console({});
    expect(lines).toHaveLength(5);
    expect(lines[3]).toContain('four');
    expect(lines[4]).toContain('five');
  });

  test('a wider drain back-fills rows the earlier tail never covered', async () => {
    const lines: string[] = [];
    const adb = new FakeAdb();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
      adb,
      ui: new FakeUi(),
      onLog: (_channel, line) => {
        lines.push(line);
      },
    });
    const row = (n: string): string => `1546300800.000  1000  1001 I Tag: ${n}`;
    // First read: the default 500-line tail covers only the newest three rows.
    adb.setResponse('logcat -v epoch -t 500', `${row('three')}\n${row('four')}\n${row('five')}\n`);
    await adapter.console({});
    expect(lines).toHaveLength(3);

    // A wider read drains rows the earlier cutoff sat below: never drained, so
    // they stream now — once — while the overlap with the first read stays silent.
    const wider = ['one', 'two', 'three', 'four', 'five'].map(row).join('\n');
    adb.setResponse('logcat -v epoch -t 3000', `${wider}\n`);
    await adapter.console({ limit: 3000 });
    expect(lines).toHaveLength(5);
    // Stream order across drains: the first read's rows, then the back-filled ones.
    expect(lines.slice(0, 3).join()).toContain('three');
    expect(lines[3]).toContain('one');
    expect(lines[4]).toContain('two');
  });

  test('rows identical after normalization stream as distinct occurrences', async () => {
    // The reviewed defect: the dedup key used the NORMALIZED entry — timestamp
    // rounded to whole milliseconds, `F` folded into `error`, PID/TID dropped —
    // so three distinct logcat rows collapsed into one durable line. The key is
    // now the raw record: full emitted precision plus PID, TID and raw priority.
    const lines: string[] = [];
    const adb = new FakeAdb();
    const adapter = AndroidAdapter.create({
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
      adb,
      ui: new FakeUi(),
      onLog: (_channel, line) => {
        lines.push(line);
      },
    });
    // Same tag/text and all three rounding to the same millisecond (…123): they
    // differ only in sub-ms fraction, TID and PID.
    adb.setResponse(
      'logcat -v epoch -t 500',
      '1546300800.1231  1000  1001 I Tag: dup\n' +
        '1546300800.1234  1000  1002 I Tag: dup\n' +
        '1546300800.1231  2000  1001 I Tag: dup\n',
    );
    const entries = await adapter.console({});
    // The returned view still normalizes — all three stamp to the same ms —
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.timestamp === 1546300800123)).toBe(true);
    // …but the durable trail keeps every occurrence.
    expect(lines).toHaveLength(3);
  });

  test('a throwing sink does not fail the read', async () => {
    const quiet = spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const adapter = withSink(() => {
        throw new Error('sink down');
      });
      const entries = await adapter.console({});
      expect(entries).toHaveLength(2);
      expect(entries[0]?.level).toBe('error');
    } finally {
      quiet.mockRestore();
    }
  });

  test('filters and limit narrow the returned view, not the streamed trail', async () => {
    const lines: string[] = [];
    const adapter = withSink((_channel, line) => {
      lines.push(line);
    });
    const entries = await adapter.console({ limit: 1, filters: { level_eq: 'error' } });
    // Newest first: the error row is the newer one, and the only filter match.
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('error');
    // Both rows still reached the durable trail.
    expect(lines).toHaveLength(2);
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
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
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
      config: { adapter: 'android', headless: true, avd: 'test_avd' },
      adb,
      ui,
    });
    const err = await adapter.readState().catch((e: unknown) => e);
    expect(err instanceof AdapterError).toBe(true);
    expect((err as AdapterError).message).toBe('original');
  });
});
