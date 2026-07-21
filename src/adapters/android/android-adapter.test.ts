/**
 * Unit tests for the Android adapter — all exercised over the faked ADB seam;
 * no real device or emulator needed.
 *
 * Coverage:
 *   - Pure parsers (uiautomator.ts): parseHierarchy, parseBounds, parseAttrs,
 *     unescapeXml, mapAndroidRole, toAndroidNode, parseAndroidQuery,
 *     matchesAndroidNode, applyAndroidFilters, shapeNodes, centerWithin, toNode
 *   - Pure parsers (android-adapter.ts): parseLogcat, applyLogFilters
 *   - Command builders (commands.ts): centerOf, tapPointOf, startArgs, tapArgs, textArgs,
 *     swipeArgs, escapeInputText, scrollSwipe, keycodeFor, keyArgs, parseScreenSize
 *   - AndroidAdapter (android-adapter.ts): create (attach / managed),
 *     find/readState/click/type/pressKey/scroll/screenshot/waitFor/console/network/close
 */

import { describe, expect, test } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AdapterError, AdbError } from '../../errors.js';
import type { Bounds, Node } from '../contract.js';
import type { Adb } from './adb.js';
import {
  AndroidAdapter,
  type AndroidAdapterInit,
  applyLogFilters,
  parseLogcat,
} from './android-adapter.js';
import {
  centerOf,
  escapeInputText,
  keyArgs,
  keycodeFor,
  parseScreenSize,
  scrollSwipe,
  splitTextForInput,
  splitTextLines,
  startArgs,
  swipeArgs,
  tapArgs,
  tapPointOf,
  textArgs,
} from './commands.js';
import type { UiAutomatorSource } from './uiautomator.js';
import {
  type AndroidNode,
  applyAndroidFilters,
  centerWithin,
  mapAndroidRole,
  matchesAndroidNode,
  parseAndroidQuery,
  parseAttrs,
  parseBounds,
  parseHierarchy,
  shapeNodes,
  toAndroidNode,
  toNode,
  unescapeXml,
} from './uiautomator.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MINIMAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<hierarchy rotation="0">
  <node class="android.widget.FrameLayout" text="" content-desc="" resource-id=""
    checkable="false" checked="false" clickable="false" enabled="true"
    focusable="false" scrollable="false" bounds="[0,0][1080,2400]" />
  <node class="android.widget.Button" text="OK" content-desc="" resource-id="com.app:id/ok"
    checkable="false" checked="false" clickable="true" enabled="true"
    focusable="true" scrollable="false" bounds="[270,1000][810,1100]" />
  <node class="android.widget.TextView" text="" content-desc="Cancel" resource-id=""
    checkable="false" checked="false" clickable="false" enabled="true"
    focusable="false" scrollable="false" bounds="[0,1200][540,1300]" />
</hierarchy>`;

/** Build a minimal valid AndroidNode. */
function makeNode(overrides: Partial<AndroidNode> = {}): AndroidNode {
  return {
    role: 'button',
    name: 'Save',
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    enabled: true,
    clickable: true,
    scrollable: false,
    focusable: true,
    resourceId: 'com.app:id/save',
    ...overrides,
  };
}

/** Fake ADB seam — records calls (and the serial it was bound to) for assertions. */
class FakeAdb implements Adb {
  readonly serial: string;
  calls: Array<{ method: string; args: string[] }> = [];
  responses: Map<string, string | Uint8Array> = new Map();

  constructor(serial = 'emulator-fake') {
    this.serial = serial;
  }

  setResponse(key: string, value: string | Uint8Array): void {
    this.responses.set(key, value);
  }

  private get(key: string): string {
    const v = this.responses.get(key);
    return typeof v === 'string' ? v : '';
  }

  async shell(command: string[]): Promise<string> {
    this.calls.push({ method: 'shell', args: command });
    const key = command.join(' ');
    if (this.responses.has(key)) return this.get(key);
    // Default sensible responses so basic flows succeed without explicit setup.
    if (command[0] === 'getprop') return '1';
    if (command[0] === 'wm') return 'Physical size: 1080x2400';
    // The real success line (AOSP typo included) — dumps assert it, so the default must carry it.
    if (command[0] === 'uiautomator') return 'UI hierchary dumped to: /sdcard/window_dump.xml';
    if (command[0] === 'cat') return MINIMAL_XML;
    if (command[0] === 'logcat') return '';
    return '';
  }

  async execOut(command: string[]): Promise<Uint8Array> {
    this.calls.push({ method: 'execOut', args: command });
    const key = command.join(' ');
    const v = this.responses.get(key);
    if (v instanceof Uint8Array) return v;
    return new Uint8Array([1, 2, 3]);
  }

  async adb(args: string[]): Promise<string> {
    this.calls.push({ method: 'adb', args });
    const key = `adb ${args.join(' ')}`;
    if (this.responses.has(key)) return this.get(key);
    // Default: a device is connected, so managed boots proceed.
    if (args[0] === 'get-state') return 'device';
    return '';
  }
}

/**
 * Minimal fake emulator child for the spawn seam — an EventEmitter with a pid.
 * Pass `undefined` when the test calls `close`, so the real `process.kill` is skipped.
 */
function makeFakeEmulator(pid: number | undefined = 4242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as { pid?: number }).pid = pid;
  return child;
}

/** Fake UiAutomatorSource seam. */
class FakeUi implements UiAutomatorSource {
  private nodes: AndroidNode[];
  calls = 0;

  constructor(nodes: AndroidNode[] = []) {
    this.nodes = nodes;
  }

  setNodes(nodes: AndroidNode[]): void {
    this.nodes = nodes;
  }

  async dump(): Promise<AndroidNode[]> {
    this.calls++;
    return this.nodes;
  }
}

/** Build a test AndroidAdapter with fake seams. */
function makeAdapter(opts: Partial<AndroidAdapterInit> & { nodes?: AndroidNode[] } = {}): {
  adapter: AndroidAdapter;
  adb: FakeAdb;
  ui: FakeUi;
} {
  const adb = new FakeAdb();
  const ui = new FakeUi(opts.nodes ?? []);
  const adapter = AndroidAdapter.create({
    config: opts.config ?? { adapter: 'android', avd: 'test_avd' },
    adb,
    ui,
  });
  return { adapter, adb, ui };
}

function makeAttachAdapter(
  serial = 'emulator-5554',
  nodes: AndroidNode[] = [],
): { adapter: AndroidAdapter; adb: FakeAdb; ui: FakeUi } {
  const adb = new FakeAdb();
  const ui = new FakeUi(nodes);
  const adapter = AndroidAdapter.create({
    config: { adapter: 'android', avd: 'test_avd', adbSerial: serial },
    adb,
    ui,
  });
  return { adapter, adb, ui };
}

// ===========================================================================
// uiautomator.ts — pure parsers
// ===========================================================================

describe('unescapeXml', () => {
  test('decodes all five entities', () => {
    expect(unescapeXml('&lt;a&gt;&amp;&quot;&apos;')).toBe('<a>&"\'');
  });
  test('passes through plain text', () => {
    expect(unescapeXml('hello world')).toBe('hello world');
  });
  test('decodes &amp; last (no double-decode)', () => {
    expect(unescapeXml('&amp;lt;')).toBe('&lt;');
  });
});

describe('parseAttrs', () => {
  test('parses multiple key-value pairs', () => {
    const attrs = parseAttrs('text="Hello" enabled="true" bounds="[0,0][100,50]"');
    expect(attrs.text).toBe('Hello');
    expect(attrs.enabled).toBe('true');
    expect(attrs.bounds).toBe('[0,0][100,50]');
  });
  test('unescapes entity values', () => {
    const attrs = parseAttrs('content-desc="&amp;amp;"');
    expect(attrs['content-desc']).toBe('&amp;');
  });
  test('returns empty object for empty string', () => {
    expect(parseAttrs('')).toEqual({});
  });
});

describe('parseBounds', () => {
  test('parses normal bounds', () => {
    expect(parseBounds('[0,0][1080,2400]')).toEqual({ x: 0, y: 0, width: 1080, height: 2400 });
  });
  test('handles negative coords', () => {
    expect(parseBounds('[-10,-20][100,80]')).toEqual({ x: -10, y: -20, width: 110, height: 100 });
  });
  test('throws AdapterError on malformed bounds', () => {
    expect(() => parseBounds('bad')).toThrow(AdapterError);
  });
  test('computes width/height as delta', () => {
    const b = parseBounds('[100,200][400,600]');
    expect(b).toEqual({ x: 100, y: 200, width: 300, height: 400 });
  });
});

describe('mapAndroidRole', () => {
  test('maps button class', () => {
    expect(mapAndroidRole('android.widget.Button')).toBe('button');
  });
  test('maps EditText', () => {
    expect(mapAndroidRole('android.widget.EditText')).toBe('textbox');
  });
  test('maps TextView', () => {
    expect(mapAndroidRole('android.widget.TextView')).toBe('label');
  });
  test('maps RecyclerView', () => {
    expect(mapAndroidRole('androidx.recyclerview.widget.RecyclerView')).toBe('list');
  });
  test('passes through unknown class (last segment, lowercased)', () => {
    expect(mapAndroidRole('com.example.CustomWidget')).toBe('customwidget');
  });
  test('empty string → generic', () => {
    expect(mapAndroidRole('')).toBe('generic');
  });
});

describe('toAndroidNode', () => {
  test('prefers text over content-desc for name', () => {
    const node = toAndroidNode({
      class: 'android.widget.Button',
      text: 'OK',
      'content-desc': 'Close',
      'resource-id': 'com.app:id/ok',
      enabled: 'true',
      clickable: 'true',
      scrollable: 'false',
      focusable: 'true',
      bounds: '[0,0][100,50]',
    });
    expect(node.name).toBe('OK');
  });
  test('falls back to content-desc when text is empty', () => {
    const node = toAndroidNode({
      class: 'android.widget.TextView',
      text: '',
      'content-desc': 'Close',
      bounds: '[0,0][100,50]',
    });
    expect(node.name).toBe('Close');
  });
  test('maps boolean attributes', () => {
    const node = toAndroidNode({
      class: 'android.widget.Button',
      text: '',
      'content-desc': '',
      bounds: '[0,0][100,50]',
      enabled: 'false',
      clickable: 'false',
      scrollable: 'true',
      focusable: 'false',
    });
    expect(node.enabled).toBe(false);
    expect(node.clickable).toBe(false);
    expect(node.scrollable).toBe(true);
    expect(node.focusable).toBe(false);
  });
});

describe('parseHierarchy', () => {
  test('returns all node elements', () => {
    const nodes = parseHierarchy(MINIMAL_XML);
    expect(nodes).toHaveLength(3);
  });
  test('first node is the FrameLayout container', () => {
    const nodes = parseHierarchy(MINIMAL_XML);
    expect(nodes[0]?.role).toBe('group');
  });
  test('button node attributes parsed correctly', () => {
    const nodes = parseHierarchy(MINIMAL_XML);
    const btn = nodes[1];
    expect(btn?.name).toBe('OK');
    expect(btn?.clickable).toBe(true);
    expect(btn?.resourceId).toBe('com.app:id/ok');
    expect(btn?.bounds).toEqual({ x: 270, y: 1000, width: 540, height: 100 });
  });
  test('throws AdapterError when no <hierarchy>', () => {
    expect(() => parseHierarchy('<root><node bounds="[0,0][1,1]" /></root>')).toThrow(AdapterError);
  });
  test('handles self-closing nodes', () => {
    const xml = `<hierarchy><node class="android.widget.Button" text="A" content-desc="" resource-id="" enabled="true" clickable="true" scrollable="false" focusable="true" bounds="[0,0][10,10]"/></hierarchy>`;
    const nodes = parseHierarchy(xml);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.name).toBe('A');
  });
});

describe('parseAndroidQuery', () => {
  test('parses role+name query', () => {
    expect(parseAndroidQuery('button "Save"')).toEqual({ role: 'button', name: 'Save' });
  });
  test('single-quoted name', () => {
    expect(parseAndroidQuery("textbox 'Email'")).toEqual({ role: 'textbox', name: 'Email' });
  });
  test('bare text → name only', () => {
    expect(parseAndroidQuery('OK')).toEqual({ name: 'OK' });
  });
  test('resource-id-style string → name only', () => {
    expect(parseAndroidQuery('com.app:id/submit')).toEqual({ name: 'com.app:id/submit' });
  });
  test('trimmed', () => {
    expect(parseAndroidQuery('  Save  ')).toEqual({ name: 'Save' });
  });
});

describe('matchesAndroidNode', () => {
  const btn = makeNode({ role: 'button', name: 'OK', resourceId: 'com.app:id/ok' });

  test('role+name match', () => {
    expect(matchesAndroidNode(btn, { role: 'button', name: 'ok' })).toBe(true);
  });
  test('role mismatch → false', () => {
    expect(matchesAndroidNode(btn, { role: 'textbox', name: 'ok' })).toBe(false);
  });
  test('name substring match (case-insensitive)', () => {
    expect(matchesAndroidNode(btn, { name: 'ok' })).toBe(true);
  });
  test('resource-id substring match', () => {
    expect(matchesAndroidNode(btn, { name: 'id/ok' })).toBe(true);
  });
  test('no parsed name → role-only match', () => {
    expect(matchesAndroidNode(btn, { role: 'button' })).toBe(true);
  });
  test('empty parsed query → always true', () => {
    expect(matchesAndroidNode(btn, {})).toBe(true);
  });
});

describe('applyAndroidFilters', () => {
  const nodes = [
    makeNode({ role: 'button', enabled: true, clickable: true, scrollable: false }),
    makeNode({ role: 'textbox', enabled: false, clickable: false, scrollable: false }),
    makeNode({ role: 'list', enabled: true, clickable: false, scrollable: true }),
  ];

  test('enabled_eq filters disabled nodes', () => {
    const result = applyAndroidFilters(nodes, { enabled_eq: false });
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('textbox');
  });
  test('clickable_eq filters non-clickable', () => {
    const result = applyAndroidFilters(nodes, { clickable_eq: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('button');
  });
  test('scrollable_eq filters', () => {
    const result = applyAndroidFilters(nodes, { scrollable_eq: true });
    expect(result).toHaveLength(1);
    expect(result[0]?.role).toBe('list');
  });
  test('role_in filters by role set', () => {
    const result = applyAndroidFilters(nodes, { role_in: ['button', 'textbox'] });
    expect(result).toHaveLength(2);
  });
  test('name_contains filters by name substring', () => {
    const withNames = [makeNode({ name: 'Submit' }), makeNode({ name: 'Cancel' })];
    expect(applyAndroidFilters(withNames, { name_contains: 'sub' })).toHaveLength(1);
  });
  test('id_contains filters by resource-id substring', () => {
    const withIds = [
      makeNode({ resourceId: 'com.app:id/submit' }),
      makeNode({ resourceId: 'com.app:id/cancel' }),
    ];
    expect(applyAndroidFilters(withIds, { id_contains: 'submit' })).toHaveLength(1);
  });
  test('throws on unknown filter key', () => {
    expect(() => applyAndroidFilters(nodes, { unknown_key: true })).toThrow(AdapterError);
  });
  test('throws when enabled_eq gets wrong type', () => {
    expect(() => applyAndroidFilters(nodes, { enabled_eq: 'yes' })).toThrow(AdapterError);
  });
  test('no filters → returns all', () => {
    expect(applyAndroidFilters(nodes)).toHaveLength(3);
  });
});

describe('centerWithin', () => {
  const region: Bounds = { x: 0, y: 0, width: 100, height: 100 };
  const inside: Node = {
    role: 'button',
    name: 'A',
    bounds: { x: 20, y: 20, width: 20, height: 20 },
    enabled: true,
  };
  const outside: Node = {
    role: 'button',
    name: 'B',
    bounds: { x: 200, y: 0, width: 20, height: 20 },
    enabled: true,
  };

  test('node center inside region → true', () => {
    expect(centerWithin(inside, region)).toBe(true);
  });
  test('node center outside region → false', () => {
    expect(centerWithin(outside, region)).toBe(false);
  });
});

describe('toNode', () => {
  test('strips internal flags', () => {
    const node = makeNode();
    const plain = toNode(node);
    expect('clickable' in plain).toBe(false);
    expect('scrollable' in plain).toBe(false);
    expect('focusable' in plain).toBe(false);
    expect('resourceId' in plain).toBe(false);
    expect(plain.role).toBe(node.role);
    expect(plain.name).toBe(node.name);
  });
});

describe('shapeNodes', () => {
  const nodes: AndroidNode[] = [
    makeNode({
      role: 'button',
      name: 'Save',
      enabled: true,
      clickable: true,
      resourceId: 'com.app:id/btn_save',
      bounds: { x: 0, y: 0, width: 100, height: 50 },
    }),
    makeNode({
      role: 'textbox',
      name: 'Email',
      enabled: true,
      clickable: false,
      resourceId: 'com.app:id/et_email',
      bounds: { x: 0, y: 100, width: 200, height: 40 },
    }),
    makeNode({
      role: 'button',
      name: 'Cancel',
      enabled: false,
      clickable: true,
      resourceId: 'com.app:id/btn_cancel',
      bounds: { x: 0, y: 200, width: 100, height: 50 },
    }),
  ];

  test('empty opts → all nodes (up to default limit)', () => {
    const result = shapeNodes(nodes, {});
    expect(result).toHaveLength(3);
  });
  test('query filters by name (exact substring, unique)', () => {
    const result = shapeNodes(nodes, { query: 'Save' });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Save');
  });
  test('query filters by role+name', () => {
    const result = shapeNodes(nodes, { query: 'button "Cancel"' });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Cancel');
  });
  test('limit caps results', () => {
    expect(shapeNodes(nodes, { limit: 2 })).toHaveLength(2);
  });
  test('filters applied — clickable_eq filters out non-clickable', () => {
    // only Save and Cancel are clickable
    const result = shapeNodes(nodes, { filters: { clickable_eq: true } });
    expect(result).toHaveLength(2);
    expect(result.map((n) => n.name)).toContain('Save');
    expect(result.map((n) => n.name)).toContain('Cancel');
  });
  test('query + filter narrows further', () => {
    // role+name query matches both buttons; filter to enabled-only → only Save
    const result = shapeNodes(nodes, { query: 'Cancel', filters: { enabled_eq: false } });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe('Cancel');
  });
  test('within scopes by region (center test)', () => {
    // textbox center is (100, 120) — inside region [0,0][300,200]
    const region: Bounds = { x: 0, y: 0, width: 300, height: 200 };
    const result = shapeNodes(nodes, {}, 200, region);
    // Save center (50, 25) in, Email center (100,120) in, Cancel center (50,225) out
    expect(result).toHaveLength(2);
  });
  test('returned nodes are plain Nodes (no internal fields)', () => {
    const result = shapeNodes(nodes, {});
    for (const n of result) {
      expect('clickable' in n).toBe(false);
    }
  });
});

// ===========================================================================
// android-adapter.ts — parseLogcat / applyLogFilters
// ===========================================================================

describe('parseLogcat', () => {
  const LOGCAT_LINE = '1546300800.000  1000  1001 I ActivityManager: Starting process';
  const WARN_LINE = '1546300801.500  1000  1001 W MyTag: low memory';
  const ERR_LINE = '1546300802.100  1000  1001 E CrashHandler: ANR detected';
  const DEBUG_LINE = '1546300803.000  1000  1001 D Debug: verbose output';
  const VERBOSE_LINE = '1546300804.000  1000  1001 V Verbose: very verbose';

  test('parses a single info line', () => {
    const entries = parseLogcat(LOGCAT_LINE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('info');
    expect(entries[0]?.text).toBe('Starting process');
    expect(entries[0]?.location).toBe('ActivityManager');
    expect(entries[0]?.timestamp).toBe(1546300800000);
  });
  test('maps W → warn', () => {
    expect(parseLogcat(WARN_LINE)[0]?.level).toBe('warn');
  });
  test('maps E → error', () => {
    expect(parseLogcat(ERR_LINE)[0]?.level).toBe('error');
  });
  test('maps D → debug', () => {
    expect(parseLogcat(DEBUG_LINE)[0]?.level).toBe('debug');
  });
  test('maps V → log', () => {
    expect(parseLogcat(VERBOSE_LINE)[0]?.level).toBe('log');
  });
  test('skips non-matching lines (header/empty)', () => {
    const raw = `--------- beginning of main\n${LOGCAT_LINE}`;
    expect(parseLogcat(raw)).toHaveLength(1);
  });
  test('parses multi-line output', () => {
    const raw = `${LOGCAT_LINE}\n${WARN_LINE}\n${ERR_LINE}`;
    expect(parseLogcat(raw)).toHaveLength(3);
  });
  test('empty string → empty array', () => {
    expect(parseLogcat('')).toHaveLength(0);
  });
});

describe('applyLogFilters', () => {
  const entries = [
    { level: 'info' as const, text: 'started', location: 'App', timestamp: 1000 },
    { level: 'error' as const, text: 'crash occurred', location: 'Crash', timestamp: 2000 },
    { level: 'warn' as const, text: 'low memory', location: 'Memory', timestamp: 3000 },
  ];

  test('no filters → returns all', () => {
    expect(applyLogFilters(entries)).toHaveLength(3);
  });
  test('level_eq filters to one level', () => {
    const result = applyLogFilters(entries, { level_eq: 'error' });
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe('error');
  });
  test('level_in filters to multiple levels', () => {
    const result = applyLogFilters(entries, { level_in: ['error', 'warn'] });
    expect(result).toHaveLength(2);
  });
  test('text_contains filters case-insensitively', () => {
    const result = applyLogFilters(entries, { text_contains: 'CRASH' });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('crash occurred');
  });
  test('throws on unknown filter key', () => {
    expect(() => applyLogFilters(entries, { unknown: 'x' })).toThrow(AdapterError);
  });
  test('throws when level_eq gets wrong type', () => {
    expect(() => applyLogFilters(entries, { level_eq: 123 })).toThrow(AdapterError);
  });
  test('throws when level_in gets wrong type', () => {
    expect(() => applyLogFilters(entries, { level_in: 'error' })).toThrow(AdapterError);
  });
});

// ===========================================================================
// commands.ts — pure argv builders
// ===========================================================================

describe('centerOf', () => {
  test('computes center of a bounds rect', () => {
    expect(centerOf({ x: 100, y: 200, width: 200, height: 100 })).toEqual({ x: 200, y: 250 });
  });
  test('rounds to integer', () => {
    expect(centerOf({ x: 0, y: 0, width: 101, height: 51 })).toEqual({ x: 51, y: 26 });
  });
});

describe('tapPointOf', () => {
  test('returns the node center when it has size', () => {
    expect(tapPointOf(makeNode({ bounds: { x: 100, y: 200, width: 200, height: 100 } }))).toEqual({
      x: 200,
      y: 250,
    });
  });

  test('zero-size node throws instead of tapping the screen origin', () => {
    const err = (() => {
      try {
        tapPointOf(makeNode({ name: 'Save', bounds: { x: 0, y: 0, width: 0, height: 0 } }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('zero size');
    expect((err as AdapterError).message).toContain('button "Save"');
  });

  test('zero width alone (collapsed view) throws', () => {
    expect(() => tapPointOf(makeNode({ bounds: { x: 10, y: 20, width: 0, height: 40 } }))).toThrow(
      AdapterError,
    );
  });

  test('zero height alone throws', () => {
    expect(() => tapPointOf(makeNode({ bounds: { x: 10, y: 20, width: 40, height: 0 } }))).toThrow(
      AdapterError,
    );
  });
});

describe('startArgs', () => {
  test('component form (pkg/.Activity) → am start', () => {
    expect(startArgs('com.example/.MainActivity')).toEqual([
      'am',
      'start',
      '-W',
      '-n',
      'com.example/.MainActivity',
    ]);
  });
  test('package form → monkey launch', () => {
    expect(startArgs('com.example')).toEqual([
      'monkey',
      '-p',
      'com.example',
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  });
  test('empty string → throws AdapterError', () => {
    expect(() => startArgs('')).toThrow(AdapterError);
  });
  test('whitespace-only → throws AdapterError', () => {
    expect(() => startArgs('   ')).toThrow(AdapterError);
  });
  test('shell metacharacters in the target → throws AdapterError (injection)', () => {
    expect(() => startArgs('com.app/.Main; rm -rf /sdcard')).toThrow(AdapterError);
    expect(() => startArgs('com.app/.Main && reboot')).toThrow(AdapterError);
    expect(() => startArgs('com.app$(id)')).toThrow(AdapterError);
    expect(() => startArgs('com.app/.Main`id`')).toThrow(AdapterError);
    expect(() => startArgs('com.app | tee /sdcard/x')).toThrow(AdapterError);
    expect(() => startArgs('com.app\nreboot')).toThrow(AdapterError);
  });
  test('inner class components (pkg/.Outer$Inner) still launch', () => {
    expect(startArgs('com.example/.Main$Inner')).toEqual([
      'am',
      'start',
      '-W',
      '-n',
      'com.example/.Main$Inner',
    ]);
  });
  test('fully qualified component form launches', () => {
    expect(startArgs('com.example/com.example.ui.MainActivity')).toEqual([
      'am',
      'start',
      '-W',
      '-n',
      'com.example/com.example.ui.MainActivity',
    ]);
  });
});

describe('tapArgs', () => {
  test('returns input tap argv', () => {
    expect(tapArgs(270, 500)).toEqual(['input', 'tap', '270', '500']);
  });
});

describe('escapeInputText', () => {
  test('spaces → %s', () => {
    expect(escapeInputText('hello world')).toBe('hello%sworld');
  });
  test('escapes shell-special chars', () => {
    expect(escapeInputText('a&b')).toBe('a\\&b');
    expect(escapeInputText('a|b')).toBe('a\\|b');
    expect(escapeInputText('a$b')).toBe('a\\$b');
  });
  test('escapes # (mksh comment at word start)', () => {
    expect(escapeInputText('#hashtag')).toBe('\\#hashtag');
  });
  test('escapes braces (mksh brace expansion)', () => {
    expect(escapeInputText('{a,b}')).toBe('\\{a,b\\}');
  });
  test('escapes glob/history/legacy chars', () => {
    expect(escapeInputText('a?b')).toBe('a\\?b');
    expect(escapeInputText('[a]')).toBe('\\[a\\]');
    expect(escapeInputText('hi!')).toBe('hi\\!');
    expect(escapeInputText('a^b')).toBe('a\\^b');
    expect(escapeInputText('a=b')).toBe('a\\=b');
  });
  test('plain alphanumerics pass through', () => {
    expect(escapeInputText('hello123')).toBe('hello123');
  });
  test('control chars → throws AdapterError (device-shell injection)', () => {
    expect(() => escapeInputText('hi\nrm -rf /sdcard')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\rreboot')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\tthere')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\x00there')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\x1bthere')).toThrow(AdapterError);
  });
});

describe('splitTextLines', () => {
  test('splits on \\n, \\r\\n and lone \\r', () => {
    expect(splitTextLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });
  test('text without line breaks stays one line', () => {
    expect(splitTextLines('hello world')).toEqual(['hello world']);
  });
  test('trailing newline yields a trailing empty line', () => {
    expect(splitTextLines('hi\n')).toEqual(['hi', '']);
  });
});

describe('splitTextForInput', () => {
  test('breaks between % and s so the device never sees a literal %s', () => {
    expect(splitTextForInput('50%sale')).toEqual(['50%', 'sale']);
  });
  test('multiple %s occurrences all split', () => {
    expect(splitTextForInput('%s%s')).toEqual(['%', 's%', 's']);
  });
  test('text without %s stays one chunk', () => {
    expect(splitTextForInput('hello world')).toEqual(['hello world']);
  });
  test('lone % is untouched', () => {
    expect(splitTextForInput('100%')).toEqual(['100%']);
  });
  test('empty text → no chunks', () => {
    expect(splitTextForInput('')).toEqual([]);
  });
});

describe('textArgs', () => {
  test('wraps in input text argv', () => {
    expect(textArgs('hello')).toEqual(['input', 'text', 'hello']);
  });
  test('escapes spaces', () => {
    expect(textArgs('hi there')).toEqual(['input', 'text', 'hi%sthere']);
  });
});

describe('swipeArgs', () => {
  test('returns five-arg input swipe argv', () => {
    expect(swipeArgs(0, 500, 0, 100)).toEqual(['input', 'swipe', '0', '500', '0', '100', '300']);
  });
  test('accepts custom duration', () => {
    expect(swipeArgs(0, 0, 100, 100, 500)).toEqual([
      'input',
      'swipe',
      '0',
      '0',
      '100',
      '100',
      '500',
    ]);
  });
});

describe('scrollSwipe', () => {
  const area: Bounds = { x: 0, y: 0, width: 1080, height: 2400 };

  test('down: finger moves upward (y2 < y1)', () => {
    const { y1, y2 } = scrollSwipe('down', area);
    expect(y1).toBeGreaterThan(y2);
  });
  test('up: finger moves downward (y2 > y1)', () => {
    const { y1, y2 } = scrollSwipe('up', area);
    expect(y2).toBeGreaterThan(y1);
  });
  test('left: finger moves rightward (x2 > x1) to reveal left content', () => {
    const { x1, x2 } = scrollSwipe('left', area);
    // Finger opposes direction: scroll left → drag RIGHT
    expect(x2).toBeGreaterThan(x1);
  });
  test('right: finger moves leftward (x2 < x1) to reveal right content', () => {
    const { x1, x2 } = scrollSwipe('right', area);
    // Finger opposes direction: scroll right → drag LEFT
    expect(x1).toBeGreaterThan(x2);
  });
  test('distance capped to 80% of span', () => {
    const { y1, y2 } = scrollSwipe('down', area, 99999);
    expect(Math.abs(y2 - y1)).toBeLessThanOrEqual(Math.round(area.height * 0.8));
  });
  test('custom amount', () => {
    const { y1, y2 } = scrollSwipe('down', area, 200);
    expect(Math.abs(y2 - y1)).toBeLessThanOrEqual(200);
  });
});

describe('keycodeFor', () => {
  test('maps enter', () => {
    expect(keycodeFor('enter')).toBe('KEYCODE_ENTER');
  });
  test('case-insensitive alias', () => {
    expect(keycodeFor('ENTER')).toBe('KEYCODE_ENTER');
  });
  test('single letter → KEYCODE_A', () => {
    expect(keycodeFor('a')).toBe('KEYCODE_A');
  });
  test('single digit → KEYCODE_5', () => {
    expect(keycodeFor('5')).toBe('KEYCODE_5');
  });
  test('raw KEYCODE_ passthrough (normalized)', () => {
    expect(keycodeFor('KEYCODE_ENTER')).toBe('KEYCODE_ENTER');
  });
  test('f1-f12 keys map to KEYCODE_F*', () => {
    expect(keycodeFor('f1')).toBe('KEYCODE_F1');
    expect(keycodeFor('f12')).toBe('KEYCODE_F12');
  });
  test('unknown token → throws AdapterError', () => {
    expect(() => keycodeFor('f13')).toThrow(AdapterError);
  });
});

describe('keyArgs', () => {
  test('single key → input keyevent', () => {
    expect(keyArgs('enter')).toEqual(['input', 'keyevent', 'KEYCODE_ENTER']);
  });
  test('chord → input keycombination', () => {
    expect(keyArgs('Control+a')).toEqual([
      'input',
      'keycombination',
      'KEYCODE_CTRL_LEFT',
      'KEYCODE_A',
    ]);
  });
  test('empty string → throws AdapterError', () => {
    expect(() => keyArgs('')).toThrow(AdapterError);
  });
});

describe('parseScreenSize', () => {
  test('parses Physical size', () => {
    expect(parseScreenSize('Physical size: 1080x2400')).toEqual({
      x: 0,
      y: 0,
      width: 1080,
      height: 2400,
    });
  });
  test('prefers Override size', () => {
    expect(parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1280')).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 1280,
    });
  });
  test('throws AdapterError on missing size', () => {
    expect(() => parseScreenSize('no size here')).toThrow(AdapterError);
  });
});

// ===========================================================================
// AndroidAdapter — behaviours over fake seams
// ===========================================================================

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

// ===========================================================================
// AdbUiAutomator (integration boundary — unit-testable via FakeAdb)
// ===========================================================================

describe('AdbUiAutomator', () => {
  test('dump calls uiautomator then cat and parses result', async () => {
    const { AdbUiAutomator } = await import('./uiautomator.js');
    const adb = new FakeAdb();
    adb.setResponse(`cat ${'/sdcard/window_dump.xml'}`, MINIMAL_XML);
    const src = new AdbUiAutomator(adb);
    const nodes = await src.dump();
    expect(nodes).toHaveLength(3);
    expect(adb.calls.some((c) => c.args[0] === 'uiautomator')).toBe(true);
    expect(adb.calls.some((c) => c.args[0] === 'cat')).toBe(true);
  });

  test('removes the previous dump before dumping (rm → dump → cat)', async () => {
    const { AdbUiAutomator } = await import('./uiautomator.js');
    const adb = new FakeAdb();
    await new AdbUiAutomator(adb).dump();
    expect(adb.calls.map((c) => c.args)).toEqual([
      ['rm', '-f', '/sdcard/window_dump.xml'],
      ['uiautomator', 'dump', '/sdcard/window_dump.xml'],
      ['cat', '/sdcard/window_dump.xml'],
    ]);
  });

  test('accepts the corrected "hierarchy" spelling too', async () => {
    const { AdbUiAutomator } = await import('./uiautomator.js');
    const adb = new FakeAdb();
    adb.setResponse(
      'uiautomator dump /sdcard/window_dump.xml',
      'UI hierarchy dumped to: /sdcard/window_dump.xml',
    );
    expect(await new AdbUiAutomator(adb).dump()).toHaveLength(3);
  });

  test('dump without the success line throws — never parses a stale file', async () => {
    const { AdbUiAutomator } = await import('./uiautomator.js');
    const adb = new FakeAdb();
    // The real exit-0 failure mode; the previous dump is still readable on device.
    adb.setResponse('uiautomator dump /sdcard/window_dump.xml', 'ERROR: could not get idle state.');
    const err = await new AdbUiAutomator(adb).dump().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('could not get idle state');
    expect(adb.calls.some((c) => c.args[0] === 'cat')).toBe(false);
  });

  test('silent dump failure (no output) throws', async () => {
    const { AdbUiAutomator } = await import('./uiautomator.js');
    const adb = new FakeAdb();
    adb.setResponse('uiautomator dump /sdcard/window_dump.xml', '');
    await expect(new AdbUiAutomator(adb).dump()).rejects.toThrow(AdapterError);
  });
});
