import { expect, test } from 'bun:test';
import type { BrowserContext, Page } from 'playwright-core';
import { AdapterError } from '../../errors.js';
import type { ConsoleEntry, NetworkEntry } from '../contract.js';
import {
  type CaptureSink,
  CdpCapture,
  filterConsole,
  filterNetwork,
  formatConsoleLine,
  formatNetworkLine,
  normalizeConsoleLevel,
} from './cdp.js';

// --- Fakes ------------------------------------------------------------------

type Listener = (arg: unknown) => void;

/** Minimal event emitter standing in for a Playwright `Page`/`BrowserContext`. */
class FakeEmitter {
  readonly #listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const arr = this.#listeners.get(event) ?? [];
    arr.push(listener);
    this.#listeners.set(event, arr);
    return this;
  }

  off(event: string, listener: Listener): this {
    const arr = this.#listeners.get(event) ?? [];
    this.#listeners.set(
      event,
      arr.filter((l) => l !== listener),
    );
    return this;
  }

  emit(event: string, arg: unknown): void {
    for (const l of this.#listeners.get(event) ?? []) l(arg);
  }

  count(): number {
    let n = 0;
    for (const arr of this.#listeners.values()) n += arr.length;
    return n;
  }
}

const fakeConsole = (type: string, text: string, url = 'app.js', line = 10, column = 5) => ({
  type: () => type,
  text: () => text,
  location: () => ({ url, line, column, lineNumber: line, columnNumber: column }),
});

const fakeResponse = (o: {
  method?: string;
  url: string;
  status: number;
  ok: boolean;
  resourceType?: string;
}) => ({
  status: () => o.status,
  ok: () => o.ok,
  url: () => o.url,
  request: () => ({
    method: () => o.method ?? 'GET',
    resourceType: () => o.resourceType ?? 'fetch',
  }),
});

const fakeFailed = (o: {
  method?: string;
  url: string;
  resourceType?: string;
  errorText: string | null;
}) => ({
  method: () => o.method ?? 'GET',
  url: () => o.url,
  resourceType: () => o.resourceType ?? 'fetch',
  failure: () => (o.errorText === null ? null : { errorText: o.errorText }),
});

function setup(opts?: { now?: () => number; cap?: number; sink?: CaptureSink }) {
  const page = new FakeEmitter();
  const context = new FakeEmitter();
  const cap = new CdpCapture({
    page: page as unknown as Page,
    context: context as unknown as BrowserContext,
    now: opts?.now ?? (() => 1000),
    cap: opts?.cap,
    sink: opts?.sink,
  });
  cap.start();
  return { page, context, cap };
}

// --- normalizeConsoleLevel --------------------------------------------------

test('normalizeConsoleLevel maps CDP types to normalized levels', () => {
  expect(normalizeConsoleLevel('error')).toBe('error');
  expect(normalizeConsoleLevel('assert')).toBe('error');
  expect(normalizeConsoleLevel('warning')).toBe('warn');
  expect(normalizeConsoleLevel('info')).toBe('info');
  expect(normalizeConsoleLevel('debug')).toBe('debug');
  expect(normalizeConsoleLevel('log')).toBe('log');
  expect(normalizeConsoleLevel('table')).toBe('log');
});

// --- line formatting --------------------------------------------------------

test('formatConsoleLine renders level, text, and location', () => {
  expect(
    formatConsoleLine({ level: 'error', text: 'boom', location: 'app.js:1:2', timestamp: 0 }),
  ).toBe('1970-01-01T00:00:00.000Z ERROR boom @ app.js:1:2');
});

test('formatConsoleLine omits location when absent', () => {
  expect(formatConsoleLine({ level: 'log', text: 'hi', timestamp: 0 })).toBe(
    '1970-01-01T00:00:00.000Z LOG hi',
  );
});

test('formatNetworkLine renders status and resourceType', () => {
  expect(
    formatNetworkLine({
      method: 'GET',
      url: 'http://x/a',
      status: 200,
      ok: true,
      resourceType: 'fetch',
      timestamp: 0,
    }),
  ).toBe('1970-01-01T00:00:00.000Z GET http://x/a → 200 [fetch]');
});

test('formatNetworkLine renders failures', () => {
  expect(
    formatNetworkLine({
      method: 'POST',
      url: 'http://x/b',
      status: 0,
      ok: false,
      error: 'net::ERR',
      timestamp: 0,
    }),
  ).toBe('1970-01-01T00:00:00.000Z POST http://x/b → FAILED net::ERR');
});

// --- filterConsole ----------------------------------------------------------

const c = (over: Partial<ConsoleEntry>): ConsoleEntry => ({
  level: 'log',
  text: '',
  timestamp: 0,
  ...over,
});

test('filterConsole returns all when no filters', () => {
  const entries = [c({ text: 'a' }), c({ text: 'b' })];
  expect(filterConsole(entries)).toEqual(entries);
});

test('filterConsole narrows by level_eq', () => {
  const entries = [c({ level: 'error', text: 'a' }), c({ level: 'log', text: 'b' })];
  expect(filterConsole(entries, { level_eq: 'error' }).map((e) => e.text)).toEqual(['a']);
});

test('filterConsole narrows by level_in', () => {
  const entries = [c({ level: 'error' }), c({ level: 'warn' }), c({ level: 'log' })];
  expect(filterConsole(entries, { level_in: ['error', 'warn'] }).map((e) => e.level)).toEqual([
    'error',
    'warn',
  ]);
});

test('filterConsole narrows by text_contains (case-insensitive)', () => {
  const entries = [c({ text: 'TypeError: x' }), c({ text: 'ok' })];
  expect(filterConsole(entries, { text_contains: 'typeerror' }).map((e) => e.text)).toEqual([
    'TypeError: x',
  ]);
});

test('filterConsole throws on unknown key', () => {
  expect(() => filterConsole([c({})], { bogus_eq: true })).toThrow(AdapterError);
});

test('filterConsole throws on wrong value type', () => {
  expect(() => filterConsole([c({})], { level_in: 'error' })).toThrow(AdapterError);
  expect(() => filterConsole([c({})], { level_eq: 5 })).toThrow(AdapterError);
});

// --- filterNetwork ----------------------------------------------------------

const n = (over: Partial<NetworkEntry>): NetworkEntry => ({
  method: 'GET',
  url: '',
  status: 200,
  ok: true,
  timestamp: 0,
  ...over,
});

test('filterNetwork narrows by status_gte', () => {
  const entries = [n({ status: 200 }), n({ status: 404 }), n({ status: 500 })];
  expect(filterNetwork(entries, { status_gte: 400 }).map((e) => e.status)).toEqual([404, 500]);
});

test('filterNetwork narrows by status_lt and status_eq', () => {
  const entries = [n({ status: 200 }), n({ status: 301 }), n({ status: 500 })];
  expect(filterNetwork(entries, { status_lt: 400 }).map((e) => e.status)).toEqual([200, 301]);
  expect(filterNetwork(entries, { status_eq: 301 }).map((e) => e.status)).toEqual([301]);
});

test('filterNetwork narrows by ok_eq and failed_eq', () => {
  const entries = [n({ ok: true }), n({ ok: false }), n({ ok: false, error: 'net::ERR' })];
  expect(filterNetwork(entries, { ok_eq: false }).length).toBe(2);
  expect(filterNetwork(entries, { failed_eq: true }).map((e) => e.error)).toEqual(['net::ERR']);
});

test('filterNetwork narrows by method_eq (case-insensitive), resource_in, url_contains', () => {
  const entries = [
    n({ method: 'GET', url: 'http://x/api/users', resourceType: 'xhr' }),
    n({ method: 'POST', url: 'http://x/assets/logo.png', resourceType: 'image' }),
  ];
  expect(filterNetwork(entries, { method_eq: 'post' }).map((e) => e.url)).toEqual([
    'http://x/assets/logo.png',
  ]);
  expect(filterNetwork(entries, { resource_in: ['xhr', 'fetch'] }).map((e) => e.method)).toEqual([
    'GET',
  ]);
  expect(filterNetwork(entries, { url_contains: '/API/' }).map((e) => e.method)).toEqual(['GET']);
});

test('filterNetwork throws on unknown key and wrong value type', () => {
  expect(() => filterNetwork([n({})], { bogus: 1 })).toThrow(AdapterError);
  expect(() => filterNetwork([n({})], { status_gte: '400' })).toThrow(AdapterError);
  expect(() => filterNetwork([n({})], { ok_eq: 'no' })).toThrow(AdapterError);
});

// --- CdpCapture -------------------------------------------------------------

test('captures console messages newest-first with normalized level', () => {
  const { page, cap } = setup();
  page.emit('console', fakeConsole('log', 'first'));
  page.emit('console', fakeConsole('warning', 'second'));
  const out = cap.console();
  expect(out.map((e) => e.text)).toEqual(['second', 'first']);
  expect(out[0]?.level).toBe('warn');
});

test('builds console location url:line:column, omits when no url', () => {
  const { page, cap } = setup();
  page.emit('console', fakeConsole('error', 'x', 'app.js', 3, 7));
  page.emit('console', fakeConsole('error', 'y', '', 0, 0));
  const out = cap.console();
  expect(out[0]?.location).toBeUndefined();
  expect(out[1]?.location).toBe('app.js:3:7');
});

test('folds uncaught pageerror into a console error entry', () => {
  const { page, cap } = setup();
  page.emit('pageerror', new Error('kaboom'));
  const out = cap.console();
  expect(out[0]?.level).toBe('error');
  expect(out[0]?.text).toBe('kaboom');
});

test('captures responses incl 4xx/5xx with ok flag', () => {
  const { context, cap } = setup();
  context.emit('response', fakeResponse({ url: 'http://x/ok', status: 200, ok: true }));
  context.emit(
    'response',
    fakeResponse({
      method: 'POST',
      url: 'http://x/bad',
      status: 500,
      ok: false,
      resourceType: 'xhr',
    }),
  );
  const out = cap.network();
  expect(out.map((e) => e.status)).toEqual([500, 200]);
  expect(out[0]?.ok).toBe(false);
  expect(out[0]?.error).toBeUndefined();
});

test('captures request failures as status 0 with error', () => {
  const { page, cap } = setup();
  page.emit('requestfailed', fakeFailed({ url: 'http://x/y', errorText: 'net::ERR_FAILED' }));
  const [entry] = cap.network();
  expect(entry?.status).toBe(0);
  expect(entry?.ok).toBe(false);
  expect(entry?.error).toBe('net::ERR_FAILED');
});

test('requestfailed falls back when failure() is null', () => {
  const { page, cap } = setup();
  page.emit('requestfailed', fakeFailed({ url: 'http://x/y', errorText: null }));
  expect(cap.network()[0]?.error).toBe('request failed');
});

test('limit caps results to the most recent', () => {
  const { page, cap } = setup();
  page.emit('console', fakeConsole('log', 'a'));
  page.emit('console', fakeConsole('log', 'b'));
  page.emit('console', fakeConsole('log', 'c'));
  expect(cap.console({ limit: 2 }).map((e) => e.text)).toEqual(['c', 'b']);
});

test('filters apply through console()/network()', () => {
  const { page, context, cap } = setup();
  page.emit('console', fakeConsole('log', 'noise'));
  page.emit('console', fakeConsole('error', 'boom'));
  expect(cap.console({ filters: { level_eq: 'error' } }).map((e) => e.text)).toEqual(['boom']);
  context.emit('response', fakeResponse({ url: 'http://x/a', status: 200, ok: true }));
  context.emit('response', fakeResponse({ url: 'http://x/b', status: 404, ok: false }));
  expect(cap.network({ filters: { status_gte: 400 } }).map((e) => e.status)).toEqual([404]);
});

test('ring buffer caps retained entries, dropping oldest', () => {
  const { page, cap } = setup({ cap: 2 });
  page.emit('console', fakeConsole('log', 'a'));
  page.emit('console', fakeConsole('log', 'b'));
  page.emit('console', fakeConsole('log', 'c'));
  expect(cap.console().map((e) => e.text)).toEqual(['c', 'b']);
});

test('streams formatted lines to the sink as entries arrive', () => {
  const lines: Array<[string, string]> = [];
  const { page, context } = setup({ now: () => 0, sink: (ch, line) => lines.push([ch, line]) });
  page.emit('console', fakeConsole('warning', 'hi', '', 0, 0));
  context.emit('response', fakeResponse({ url: 'http://x/a', status: 200, ok: true }));
  expect(lines).toEqual([
    ['console', '1970-01-01T00:00:00.000Z WARN hi'],
    ['network', '1970-01-01T00:00:00.000Z GET http://x/a → 200 [fetch]'],
  ]);
});

test('stop detaches every listener', () => {
  const { page, context, cap } = setup();
  expect(page.count() + context.count()).toBe(4);
  cap.stop();
  expect(page.count() + context.count()).toBe(0);
  page.emit('console', fakeConsole('log', 'late'));
  expect(cap.console()).toEqual([]);
});

test('start is idempotent (no double subscription)', () => {
  const { page, context, cap } = setup();
  cap.start();
  expect(page.count() + context.count()).toBe(4);
});
