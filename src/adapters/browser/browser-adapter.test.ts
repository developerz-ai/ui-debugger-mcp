import { expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { ScrollDirection } from '../contract.js';
import {
  appendDebugLogin,
  applyNodeFilters,
  type RawNode,
  scrollDelta,
} from './browser-adapter.js';

// --- appendDebugLogin -------------------------------------------------------

test('appendDebugLogin returns url unchanged when no debugLogin', () => {
  expect(appendDebugLogin('http://localhost:3000/login')).toBe('http://localhost:3000/login');
});

test('appendDebugLogin appends the bypass param', () => {
  expect(appendDebugLogin('http://localhost:3000/login', { param: 'debug-ai' })).toBe(
    'http://localhost:3000/login?debug-ai=true',
  );
});

test('appendDebugLogin merges with an existing query string', () => {
  expect(appendDebugLogin('http://localhost:3000/login?next=/home', { param: 'debug-ai' })).toBe(
    'http://localhost:3000/login?next=%2Fhome&debug-ai=true',
  );
});

test('appendDebugLogin overrides a pre-existing value for the same param', () => {
  expect(appendDebugLogin('http://localhost:3000/?debug-ai=false', { param: 'debug-ai' })).toBe(
    'http://localhost:3000/?debug-ai=true',
  );
});

// --- applyNodeFilters -------------------------------------------------------

const node = (over: Partial<RawNode>): RawNode => ({
  role: 'button',
  name: 'Submit',
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  enabled: true,
  visible: true,
  ...over,
});

test('applyNodeFilters returns all nodes when no filters', () => {
  const nodes = [node({}), node({ role: 'link' })];
  expect(applyNodeFilters(nodes)).toEqual(nodes);
});

test('applyNodeFilters filters by visible_eq', () => {
  const nodes = [node({ name: 'a', visible: true }), node({ name: 'b', visible: false })];
  const out = applyNodeFilters(nodes, { visible_eq: true });
  expect(out.map((n) => n.name)).toEqual(['a']);
});

test('applyNodeFilters filters by enabled_eq', () => {
  const nodes = [node({ name: 'a', enabled: false }), node({ name: 'b', enabled: true })];
  const out = applyNodeFilters(nodes, { enabled_eq: false });
  expect(out.map((n) => n.name)).toEqual(['a']);
});

test('applyNodeFilters filters by role_in', () => {
  const nodes = [node({ role: 'button' }), node({ role: 'link' }), node({ role: 'textbox' })];
  const out = applyNodeFilters(nodes, { role_in: ['button', 'link'] });
  expect(out.map((n) => n.role)).toEqual(['button', 'link']);
});

test('applyNodeFilters filters by name_contains (case-insensitive)', () => {
  const nodes = [node({ name: 'Save changes' }), node({ name: 'Cancel' })];
  const out = applyNodeFilters(nodes, { name_contains: 'SAVE' });
  expect(out.map((n) => n.name)).toEqual(['Save changes']);
});

test('applyNodeFilters combines multiple predicates (AND)', () => {
  const nodes = [
    node({ name: 'a', role: 'button', visible: true }),
    node({ name: 'b', role: 'button', visible: false }),
    node({ name: 'c', role: 'link', visible: true }),
  ];
  const out = applyNodeFilters(nodes, { role_in: ['button'], visible_eq: true });
  expect(out.map((n) => n.name)).toEqual(['a']);
});

test('applyNodeFilters throws on an unknown filter key', () => {
  expect(() => applyNodeFilters([node({})], { bogus_eq: true })).toThrow(AdapterError);
});

test('applyNodeFilters throws on a wrong value type', () => {
  expect(() => applyNodeFilters([node({})], { visible_eq: 'yes' })).toThrow(AdapterError);
  expect(() => applyNodeFilters([node({})], { role_in: 'button' })).toThrow(AdapterError);
  expect(() => applyNodeFilters([node({})], { name_contains: 5 })).toThrow(AdapterError);
});

// --- scrollDelta ------------------------------------------------------------

test('scrollDelta maps each direction onto signed wheel deltas', () => {
  expect(scrollDelta('up', 600)).toEqual([0, -600]);
  expect(scrollDelta('down', 600)).toEqual([0, 600]);
  expect(scrollDelta('left', 600)).toEqual([-600, 0]);
  expect(scrollDelta('right', 600)).toEqual([600, 0]);
});

test('scrollDelta scales by the given amount', () => {
  expect(scrollDelta('down', 120)).toEqual([0, 120]);
});

test('scrollDelta throws on an unknown direction', () => {
  expect(() => scrollDelta('diagonal' as ScrollDirection, 600)).toThrow(AdapterError);
});
