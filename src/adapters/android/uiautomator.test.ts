/**
 * Unit tests for the view-hierarchy reader (`uiautomator.ts`) — XML parsing, the
 * android query/filter language, node shaping, and {@link AdbUiAutomator}'s
 * stale-dump guard over a faked {@link Adb} seam. No real device needed.
 */

import { describe, expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { Bounds, Node } from '../contract.js';
import type { Adb } from './adb.js';
import {
  AdbUiAutomator,
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

/** Fake ADB seam — records calls, canned responses (used by the {@link AdbUiAutomator} tests). */
class FakeAdb implements Adb {
  calls: Array<{ args: string[] }> = [];
  responses: Map<string, string> = new Map();

  setResponse(key: string, value: string): void {
    this.responses.set(key, value);
  }

  async shell(command: string[]): Promise<string> {
    this.calls.push({ args: command });
    const key = command.join(' ');
    if (this.responses.has(key)) return this.responses.get(key) ?? '';
    if (command[0] === 'rm') return '';
    // The real success line (AOSP typo included) — dumps assert it, so the default must carry it.
    if (command[0] === 'uiautomator') return 'UI hierchary dumped to: /sdcard/window_dump.xml';
    if (command[0] === 'cat') return MINIMAL_XML;
    return '';
  }

  async execOut(): Promise<Uint8Array> {
    return new Uint8Array();
  }

  async adb(): Promise<string> {
    return '';
  }
}

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

describe('AdbUiAutomator', () => {
  test('dump calls uiautomator then cat and parses result', async () => {
    const adb = new FakeAdb();
    adb.setResponse('cat /sdcard/window_dump.xml', MINIMAL_XML);
    const src = new AdbUiAutomator(adb);
    const nodes = await src.dump();
    expect(nodes).toHaveLength(3);
    expect(adb.calls.some((c) => c.args[0] === 'uiautomator')).toBe(true);
    expect(adb.calls.some((c) => c.args[0] === 'cat')).toBe(true);
  });

  test('removes the previous dump before dumping (rm → dump → cat)', async () => {
    const adb = new FakeAdb();
    await new AdbUiAutomator(adb).dump();
    expect(adb.calls.map((c) => c.args)).toEqual([
      ['rm', '-f', '/sdcard/window_dump.xml'],
      ['uiautomator', 'dump', '/sdcard/window_dump.xml'],
      ['cat', '/sdcard/window_dump.xml'],
    ]);
  });

  test('accepts the corrected "hierarchy" spelling too', async () => {
    const adb = new FakeAdb();
    adb.setResponse(
      'uiautomator dump /sdcard/window_dump.xml',
      'UI hierarchy dumped to: /sdcard/window_dump.xml',
    );
    expect(await new AdbUiAutomator(adb).dump()).toHaveLength(3);
  });

  test('dump without the success line throws — never parses a stale file', async () => {
    const adb = new FakeAdb();
    // The real exit-0 failure mode; the previous dump is still readable on device.
    adb.setResponse('uiautomator dump /sdcard/window_dump.xml', 'ERROR: could not get idle state.');
    const err = await new AdbUiAutomator(adb).dump().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('could not get idle state');
    expect(adb.calls.some((c) => c.args[0] === 'cat')).toBe(false);
  });

  test('silent dump failure (no output) throws', async () => {
    const adb = new FakeAdb();
    adb.setResponse('uiautomator dump /sdcard/window_dump.xml', '');
    await expect(new AdbUiAutomator(adb).dump()).rejects.toThrow(AdapterError);
  });
});
