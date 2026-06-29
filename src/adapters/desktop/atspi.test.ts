import { expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { Node } from '../contract.js';
import {
  type AtspiNode,
  applyDesktopFilters,
  BusctlAtspi,
  busctlData,
  centerWithin,
  hasState,
  mapRole,
  matchesQuery,
  parseChildren,
  parseExtents,
  parseRoleNameQuery,
  parseStateWords,
  shapeNodes,
  stateFlags,
  toNode,
} from './atspi.js';

// --- mapRole ----------------------------------------------------------------

test('mapRole normalizes AT-SPI role names to contract roles', () => {
  expect(mapRole('push button')).toBe('button');
  expect(mapRole('entry')).toBe('textbox');
  expect(mapRole('page tab')).toBe('tab');
  expect(mapRole('frame')).toBe('window');
  expect(mapRole('Check Box')).toBe('checkbox');
});

test('mapRole passes unknown roles through cleaned', () => {
  expect(mapRole('  custom  widget ')).toBe('custom widget');
});

// --- busctlData -------------------------------------------------------------

test('busctlData returns the data field', () => {
  expect(busctlData('{"type":"s","data":["hi"]}')).toEqual(['hi']);
});

test('busctlData throws on non-JSON or a missing data field', () => {
  expect(() => busctlData('not json')).toThrow(AdapterError);
  expect(() => busctlData('{"type":"s"}')).toThrow(AdapterError);
});

// --- parseExtents -----------------------------------------------------------

test('parseExtents decodes (iiii) into Bounds', () => {
  expect(parseExtents([10, 20, 100, 40])).toEqual({ x: 10, y: 20, width: 100, height: 40 });
});

test('parseExtents throws on a bad shape', () => {
  expect(() => parseExtents([1, 2, 3])).toThrow(AdapterError);
  expect(() => parseExtents('nope')).toThrow(AdapterError);
  expect(() => parseExtents([1, 2, 3, 'x'])).toThrow(AdapterError);
});

// --- state bitfield ---------------------------------------------------------

const STATE_ENABLED_VISIBLE = (1 << 8) | (1 << 24) | (1 << 25) | (1 << 30);

test('hasState reads a bit from the split 64-bit field', () => {
  expect(hasState([1 << 8, 0], 8)).toBe(true);
  expect(hasState([1 << 8, 0], 9)).toBe(false);
  expect(hasState([0, 1 << 1], 33)).toBe(true); // bit 33 → high word, bit 1
});

test('parseStateWords decodes au into a word pair', () => {
  expect(parseStateWords([256, 0])).toEqual([256, 0]);
  expect(() => parseStateWords([256])).toThrow(AdapterError);
});

test('stateFlags requires ENABLED+SENSITIVE and SHOWING+VISIBLE', () => {
  expect(stateFlags([STATE_ENABLED_VISIBLE, 0])).toEqual({ enabled: true, visible: true });
  expect(stateFlags([1 << 8, 0])).toEqual({ enabled: false, visible: false }); // enabled w/o sensitive
  expect(stateFlags([(1 << 8) | (1 << 24), 0])).toEqual({ enabled: true, visible: false });
});

// --- parseChildren ----------------------------------------------------------

test('parseChildren decodes a(so) into refs', () => {
  expect(
    parseChildren([
      [':1.5', '/a'],
      [':1.6', '/b'],
    ]),
  ).toEqual([
    { dest: ':1.5', path: '/a' },
    { dest: ':1.6', path: '/b' },
  ]);
});

test('parseChildren throws on a malformed ref', () => {
  expect(() => parseChildren([[':1.5']])).toThrow(AdapterError);
  expect(() => parseChildren('nope')).toThrow(AdapterError);
});

// --- query parsing + matching -----------------------------------------------

test('parseRoleNameQuery splits role "name" from plain text', () => {
  expect(parseRoleNameQuery('button "Save"')).toEqual({ role: 'button', name: 'Save' });
  expect(parseRoleNameQuery("link 'Home'")).toEqual({ role: 'link', name: 'Home' });
  expect(parseRoleNameQuery('Save changes')).toEqual({ name: 'Save changes' });
});

test('matchesQuery matches role exactly and name as a case-insensitive substring', () => {
  const node: Node = {
    role: 'button',
    name: 'Save changes',
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    enabled: true,
  };
  expect(matchesQuery(node, { role: 'button', name: 'save' })).toBe(true);
  expect(matchesQuery(node, { role: 'link' })).toBe(false);
  expect(matchesQuery(node, { name: 'cancel' })).toBe(false);
});

// --- applyDesktopFilters ----------------------------------------------------

const node = (over: Partial<AtspiNode>): AtspiNode => ({
  role: 'button',
  name: 'Submit',
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  enabled: true,
  visible: true,
  ...over,
});

test('applyDesktopFilters narrows by the whitelisted keys', () => {
  const nodes = [node({ name: 'a', visible: false }), node({ name: 'b', role: 'link' })];
  expect(applyDesktopFilters(nodes, { visible_eq: true }).map((n) => n.name)).toEqual(['b']);
  expect(applyDesktopFilters(nodes, { role_in: ['link'] }).map((n) => n.name)).toEqual(['b']);
  expect(applyDesktopFilters(nodes, { name_contains: 'A' }).map((n) => n.name)).toEqual(['a']);
});

test('applyDesktopFilters throws on an unknown key or wrong type', () => {
  expect(() => applyDesktopFilters([node({})], { bogus_eq: true })).toThrow(AdapterError);
  expect(() => applyDesktopFilters([node({})], { visible_eq: 'yes' })).toThrow(AdapterError);
});

// --- shapeNodes / toNode / centerWithin -------------------------------------

test('toNode drops the internal visible flag', () => {
  expect(toNode(node({ visible: false }))).toEqual({
    role: 'button',
    name: 'Submit',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    enabled: true,
  });
});

test('centerWithin tests a node center against a region', () => {
  const n = node({ bounds: { x: 10, y: 10, width: 20, height: 20 } }); // center (20,20)
  expect(centerWithin(n, { x: 0, y: 0, width: 50, height: 50 })).toBe(true);
  expect(centerWithin(n, { x: 100, y: 100, width: 10, height: 10 })).toBe(false);
});

test('shapeNodes applies query, filters, region, limit and returns plain Nodes', () => {
  const nodes = [
    node({ name: 'Save', bounds: { x: 0, y: 0, width: 10, height: 10 } }),
    node({ name: 'Save copy', bounds: { x: 500, y: 500, width: 10, height: 10 } }),
    node({ name: 'Cancel', bounds: { x: 0, y: 0, width: 10, height: 10 } }),
  ];
  const out = shapeNodes(nodes, { query: 'Save' }, 200, { x: 0, y: 0, width: 100, height: 100 });
  expect(out.map((n) => n.name)).toEqual(['Save']); // 'Save copy' excluded by region
  expect(out[0]).not.toHaveProperty('visible');
});

test('shapeNodes caps by limit', () => {
  const nodes = [node({ name: 'a' }), node({ name: 'b' }), node({ name: 'c' })];
  expect(shapeNodes(nodes, {}, 2).map((n) => n.name)).toEqual(['a', 'b']);
});

// --- BusctlAtspi.readTree (injected fake bus) -------------------------------

/** A canned a11y bus: root → app(frame) → button(push button), leaf has no children. */
function fakeBus(): { exec: (args: string[]) => Promise<string>; addressCalls: () => number } {
  let addressCalls = 0;
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) {
      addressCalls += 1;
      return call(['unix:path=/tmp/at-spi/bus']);
    }
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) {
      if (path === '/org/a11y/atspi/accessible/root') return call([[[':1.5', '/app']]]);
      if (path === '/app') return call([[[':1.5', '/btn']]]);
      return call([[]]);
    }
    if (args.includes('GetRoleName')) return call([path === '/app' ? 'frame' : 'push button']);
    if (args.includes('get-property')) return call(path === '/app' ? 'My App' : 'OK');
    if (args.includes('GetState')) return call([[STATE_ENABLED_VISIBLE, 0]]);
    if (args.includes('GetExtents')) {
      return call([path === '/app' ? [0, 0, 800, 600] : [10, 20, 100, 40]]);
    }
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec, addressCalls: () => addressCalls };
}

test('BusctlAtspi.readTree walks + normalizes the a11y tree', async () => {
  const bus = fakeBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree();
  expect(nodes.map((n) => n.role)).toEqual(['window', 'button']);
  expect(nodes.map((n) => n.name)).toEqual(['My App', 'OK']);
  const button = nodes[1];
  expect(button?.bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  expect(button?.enabled).toBe(true);
  expect(button?.visible).toBe(true);
  expect(bus.addressCalls()).toBe(1); // a11y bus address resolved once and cached
});

test('BusctlAtspi.readTree respects maxNodes', async () => {
  const bus = fakeBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({ maxNodes: 1 });
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.name).toBe('My App');
});

test('BusctlAtspi.readTree fails loud on a malformed reply', async () => {
  const exec = async (): Promise<string> => 'garbage';
  await expect(new BusctlAtspi({ exec }).readTree()).rejects.toThrow(AdapterError);
});
