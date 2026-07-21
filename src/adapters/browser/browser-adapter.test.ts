import { expect, test } from 'bun:test';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import type { ScrollDirection } from '../contract.js';
import {
  appendDebugLogin,
  applyNodeFilters,
  BrowserAdapter,
  isOutsideViewport,
  type RawNode,
  remainingTimeout,
  resolveLaunchBinary,
  resolveTargetUrl,
  scrollDelta,
} from './browser-adapter.js';

// See `browser-adapter.lifecycle.test.ts` for tests that exercise class-level
// behavior (create/attach wiring, waitFor, scroll, close) against a fake
// `chromium` launcher — kept out of this file to stay under the 500-LOC cap
// and to keep this file's scope to the pure helper functions.

// --- resolveLaunchBinary ----------------------------------------------------

const webTarget = (over: Partial<WebTarget> = {}): WebTarget => ({
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  ...over,
});

test('resolveLaunchBinary prefers an explicit executablePath', () => {
  expect(
    resolveLaunchBinary(webTarget({ executablePath: '/opt/my/chrome' }), () => '/managed'),
  ).toEqual({ executablePath: '/opt/my/chrome' });
});

test('resolveLaunchBinary uses the managed Chromium when no executablePath', () => {
  expect(resolveLaunchBinary(webTarget(), () => '/cache/ms-playwright/chrome')).toEqual({
    executablePath: '/cache/ms-playwright/chrome',
  });
});

test('resolveLaunchBinary falls back to the system Chrome channel when none found', () => {
  expect(resolveLaunchBinary(webTarget(), () => null)).toEqual({ channel: 'chrome' });
});

// --- create (failure paths) -------------------------------------------------

test('create surfaces a failed CDP attach as AdapterError, never a raw Playwright error', async () => {
  // Port 1 is never listening, so `connectOverCDP` refuses immediately — no browser
  // binary needed to prove the header contract ("every Playwright call is wrapped").
  const failed = BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:1' }),
    profileDir: '/tmp/unused-profile',
  });
  await expect(failed).rejects.toThrow(AdapterError);
  await expect(failed).rejects.toThrow(/cannot attach to http:\/\/127\.0\.0\.1:1/);
});

// --- resolveTargetUrl -------------------------------------------------------

test('resolveTargetUrl anchors a relative path to the base', () => {
  expect(resolveTargetUrl('/', 'http://localhost:5173')).toBe('http://localhost:5173/');
  expect(resolveTargetUrl('/login', 'http://localhost:5173')).toBe('http://localhost:5173/login');
});

test('resolveTargetUrl passes an absolute URL through', () => {
  expect(resolveTargetUrl('http://example.com/x', 'http://localhost:5173')).toBe(
    'http://example.com/x',
  );
});

test('resolveTargetUrl passes a relative target through when there is no base', () => {
  // Config `url` is optional — `goto` must receive the raw string and surface
  // its own clear "invalid URL" error, not a mangled resolution.
  expect(resolveTargetUrl('/login')).toBe('/login');
});

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

test('appendDebugLogin passes a relative target through when no debugLogin is configured', () => {
  expect(appendDebugLogin('/login')).toBe('/login');
});

test('appendDebugLogin throws AdapterError (not TypeError) for a relative target', () => {
  // Relative target + no config `url` base: fail loud with a pointer to the fix,
  // never an uncaught `TypeError: Invalid URL`.
  expect(() => appendDebugLogin('/login', { param: 'debug-ai' })).toThrow(AdapterError);
  expect(() => appendDebugLogin('/login', { param: 'debug-ai' })).toThrow(/`url`/);
});

// --- remainingTimeout ---------------------------------------------------------

test('remainingTimeout returns undefined when no deadline was set (Playwright default)', () => {
  expect(remainingTimeout(undefined, 1_000)).toBeUndefined();
});

test('remainingTimeout returns the time left until the deadline', () => {
  // A 30s cap shared across waitFor phases: the second wait only gets what's left.
  expect(remainingTimeout(31_000, 1_000)).toBe(30_000);
  expect(remainingTimeout(31_000, 25_000)).toBe(6_000);
});

test('remainingTimeout floors an exhausted budget at 1ms so the wait fails fast', () => {
  // 0 means "no timeout" to Playwright — never hand it that.
  expect(remainingTimeout(1_000, 1_000)).toBe(1);
  expect(remainingTimeout(1_000, 5_000)).toBe(1);
});

// --- isOutsideViewport --------------------------------------------------------

const VIEWPORT = { width: 1280, height: 720 };

test('isOutsideViewport accepts points inside the viewport (edges inclusive)', () => {
  expect(isOutsideViewport({ x: 640, y: 360 }, VIEWPORT)).toBe(false);
  expect(isOutsideViewport({ x: 0, y: 0 }, VIEWPORT)).toBe(false);
  expect(isOutsideViewport({ x: 1280, y: 720 }, VIEWPORT)).toBe(false);
});

test('isOutsideViewport flags a below-the-fold or off-screen center', () => {
  expect(isOutsideViewport({ x: 640, y: 900 }, VIEWPORT)).toBe(true); // below the fold
  expect(isOutsideViewport({ x: -5, y: 360 }, VIEWPORT)).toBe(true);
  expect(isOutsideViewport({ x: 1500, y: 360 }, VIEWPORT)).toBe(true);
  expect(isOutsideViewport({ x: 640, y: -10 }, VIEWPORT)).toBe(true);
});

test('isOutsideViewport never flags when the viewport is unknown (null)', () => {
  expect(isOutsideViewport({ x: 9_999, y: 9_999 }, null)).toBe(false);
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

test('contrast_lt keeps only text nodes with contrast below the threshold', () => {
  const base = { role: 'p', name: 'x', bounds: { x: 0, y: 0, width: 1, height: 1 }, enabled: true };
  const invisible: RawNode = {
    ...base,
    visible: true,
    style: { color: 'rgb(255, 255, 255)', backgroundColor: 'rgb(253, 253, 253)', contrast: 1.02 },
  };
  const readable: RawNode = {
    ...base,
    visible: true,
    style: { color: 'rgb(0, 0, 0)', backgroundColor: 'rgb(255, 255, 255)', contrast: 21 },
  };
  const styleless: RawNode = { ...base, visible: true };
  const out = applyNodeFilters([invisible, readable, styleless], { contrast_lt: 4.5 });
  expect(out).toEqual([invisible]);
});

test('contrast_lt drops hidden low-contrast text (never rendered = not a finding)', () => {
  const base = { role: 'p', name: 'x', bounds: { x: 0, y: 0, width: 1, height: 1 }, enabled: true };
  const style = {
    color: 'rgb(255, 255, 255)',
    backgroundColor: 'rgb(253, 253, 253)',
    contrast: 1.02,
  };
  const shown: RawNode = { ...base, visible: true, style };
  const hidden: RawNode = { ...base, visible: false, style };
  const out = applyNodeFilters([shown, hidden], { contrast_lt: 4.5 });
  expect(out).toEqual([shown]);
});

test('contrast_lt rejects a non-number threshold', () => {
  const nodes: RawNode[] = [];
  expect(() => applyNodeFilters(nodes, { contrast_lt: 'low' })).toThrow(AdapterError);
});
