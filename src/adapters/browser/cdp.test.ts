import { expect, test } from 'bun:test';
import type { Page } from 'playwright-core';
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
  truncateBody,
} from './cdp.js';

// --- Fakes ------------------------------------------------------------------

type Listener = (arg: unknown) => void;

/** Minimal event emitter standing in for a Playwright `Page`. */
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
  body?: string;
  postData?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
}) => {
  // One request object per response: duration keys off request IDENTITY, so a
  // fake that minted a fresh one per call could never be timed.
  const request = {
    method: () => o.method ?? 'GET',
    url: () => o.url,
    resourceType: () => o.resourceType ?? 'fetch',
    postData: () => o.postData ?? null,
    allHeaders: async () => o.requestHeaders ?? {},
  };
  return {
    status: () => o.status,
    ok: () => o.ok,
    url: () => o.url,
    text: async () => {
      if (o.body === undefined) throw new Error('body unavailable');
      return o.body;
    },
    allHeaders: async () => o.responseHeaders ?? {},
    request: () => request,
  };
};

/**
 * Let the async response capture settle. `#onResponse` awaits the body before
 * buffering, so a test that emits and reads in the same tick sees nothing.
 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

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
  const cap = new CdpCapture({
    page: page as unknown as Page,
    now: opts?.now ?? (() => 1000),
    cap: opts?.cap,
    sink: opts?.sink,
  });
  cap.start();
  return { page, cap };
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

test('captures responses incl 4xx/5xx with ok flag', async () => {
  const { page, cap } = setup();
  page.emit('response', fakeResponse({ url: 'http://x/ok', status: 200, ok: true }));
  page.emit(
    'response',
    fakeResponse({
      method: 'POST',
      url: 'http://x/bad',
      status: 500,
      ok: false,
      resourceType: 'xhr',
    }),
  );
  await flush();
  const out = cap.network();
  expect(out.map((e) => e.status)).toEqual([500, 200]);
  expect(out[0]?.ok).toBe(false);
  expect(out[0]?.error).toBeUndefined();
});

test('captures API request/response bodies — a 4xx keeps its reason', async () => {
  const { page, cap } = setup();
  page.emit(
    'response',
    fakeResponse({
      method: 'POST',
      url: 'http://x/api/register',
      status: 400,
      ok: false,
      resourceType: 'fetch',
      postData: '{"email":"a@b.c"}',
      body: '{"error":"password too short"}',
    }),
  );
  await flush();
  const [entry] = cap.network();
  expect(entry?.requestBody).toBe('{"email":"a@b.c"}');
  expect(entry?.responseBody).toBe('{"error":"password too short"}');
});

test('skips bodies for static assets — never buffers script/image bytes', async () => {
  const { page, cap } = setup();
  page.emit(
    'response',
    fakeResponse({
      url: 'http://x/app.js',
      status: 200,
      ok: true,
      resourceType: 'script',
      body: 'console.log(1)',
      postData: 'nope',
    }),
  );
  await flush();
  const [entry] = cap.network();
  expect(entry?.responseBody).toBeUndefined();
  expect(entry?.requestBody).toBeUndefined();
  expect(entry?.requestHeaders).toBeUndefined();
});

test('redacts credential headers, keeping only their length', async () => {
  const { page, cap } = setup();
  page.emit(
    'response',
    fakeResponse({
      url: 'http://x/api/me',
      status: 200,
      ok: true,
      resourceType: 'fetch',
      body: '{}',
      requestHeaders: { cookie: 'session=supersecret', accept: 'application/json' },
      responseHeaders: { 'set-cookie': 'session=abc', 'content-type': 'application/json' },
    }),
  );
  await flush();
  const [entry] = cap.network();
  expect(entry?.requestHeaders?.['cookie']).toBe('<redacted, 19 chars>');
  expect(entry?.requestHeaders?.['accept']).toBe('application/json');
  expect(entry?.responseHeaders?.['set-cookie']).toBe('<redacted, 11 chars>');
  expect(entry?.responseHeaders?.['content-type']).toBe('application/json');
});

test('an unreadable body is not a capture failure — the exchange still lands', async () => {
  const { page, cap } = setup();
  // `fakeResponse` with no `body` throws from text(), like a redirect would.
  page.emit('response', fakeResponse({ url: 'http://x/api/a', status: 302, ok: true }));
  await flush();
  const [entry] = cap.network();
  expect(entry?.status).toBe(302);
  expect(entry?.responseBody).toBeUndefined();
});

test('times a request from send to response', async () => {
  let clock = 1000;
  const page = new FakeEmitter();
  const cap = new CdpCapture({ page: page as unknown as Page, now: () => clock });
  cap.start();
  const response = fakeResponse({
    url: 'http://x/api/slow',
    status: 200,
    ok: true,
    resourceType: 'fetch',
    body: '{}',
  });
  page.emit('request', response.request());
  clock = 1250;
  page.emit('response', response);
  await flush();
  expect(cap.network()[0]?.durationMs).toBe(250);
});

test('a request whose start was never seen reports no duration', async () => {
  const { page, cap } = setup();
  page.emit('response', fakeResponse({ url: 'http://x/api/a', status: 200, ok: true, body: '{}' }));
  await flush();
  expect(cap.network()[0]?.durationMs).toBeUndefined();
});

test('network() sorts newest-first by capture time, not by await order', async () => {
  // A slow body resolves after a later response's — insertion order lies.
  let clock = 1000;
  const page = new FakeEmitter();
  const cap = new CdpCapture({ page: page as unknown as Page, now: () => clock });
  cap.start();
  const slow = {
    ...fakeResponse({ url: 'http://x/api/slow', status: 200, ok: true, resourceType: 'fetch' }),
    text: async () => {
      await new Promise((r) => setTimeout(r, 10));
      return '{}';
    },
  };
  page.emit('response', slow);
  clock = 2000;
  page.emit(
    'response',
    fakeResponse({ url: 'http://x/api/fast', status: 200, ok: true, body: '{}' }),
  );
  await new Promise((r) => setTimeout(r, 30));
  expect(cap.network().map((e) => e.url)).toEqual(['http://x/api/fast', 'http://x/api/slow']);
});

test('filterNetwork narrows by duration_gte and body_contains', () => {
  const entries = [
    n({ url: 'fast', durationMs: 10 }),
    n({ url: 'slow', durationMs: 900 }),
    n({ url: 'untimed' }),
    n({ url: 'boom', responseBody: '{"error":"nope"}' }),
  ];
  expect(filterNetwork(entries, { duration_gte: 500 }).map((e) => e.url)).toEqual(['slow']);
  expect(filterNetwork(entries, { body_contains: 'ERROR' }).map((e) => e.url)).toEqual(['boom']);
});

test('formatNetworkLine carries duration + the payloads of a failure', () => {
  expect(
    formatNetworkLine({
      method: 'POST',
      url: 'http://x/api/login',
      status: 401,
      ok: false,
      resourceType: 'fetch',
      timestamp: 0,
      durationMs: 42,
      requestBody: '{"email":"a"}',
      responseBody: '{"error":"bad creds"}',
    }),
  ).toBe(
    '1970-01-01T00:00:00.000Z POST http://x/api/login → 401 [fetch] 42ms ' +
      'req="{\\"email\\":\\"a\\"}" res="{\\"error\\":\\"bad creds\\"}"',
  );
});

test('truncateBody marks what it dropped', () => {
  expect(truncateBody('abcdef', 3)).toBe('abc…[truncated, 6 chars total]');
  expect(truncateBody('abc', 3)).toBe('abc');
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

test('filters apply through console()/network()', async () => {
  const { page, cap } = setup();
  page.emit('console', fakeConsole('log', 'noise'));
  page.emit('console', fakeConsole('error', 'boom'));
  expect(cap.console({ filters: { level_eq: 'error' } }).map((e) => e.text)).toEqual(['boom']);
  page.emit('response', fakeResponse({ url: 'http://x/a', status: 200, ok: true }));
  page.emit('response', fakeResponse({ url: 'http://x/b', status: 404, ok: false }));
  await flush();
  expect(cap.network({ filters: { status_gte: 400 } }).map((e) => e.status)).toEqual([404]);
});

test('ring buffer caps retained entries, dropping oldest', () => {
  const { page, cap } = setup({ cap: 2 });
  page.emit('console', fakeConsole('log', 'a'));
  page.emit('console', fakeConsole('log', 'b'));
  page.emit('console', fakeConsole('log', 'c'));
  expect(cap.console().map((e) => e.text)).toEqual(['c', 'b']);
});

test('streams formatted lines to the sink as entries arrive', async () => {
  const lines: Array<[string, string]> = [];
  const { page } = setup({ now: () => 0, sink: (ch, line) => lines.push([ch, line]) });
  page.emit('console', fakeConsole('warning', 'hi', '', 0, 0));
  page.emit('response', fakeResponse({ url: 'http://x/a', status: 200, ok: true }));
  await flush();
  expect(lines).toEqual([
    ['console', '1970-01-01T00:00:00.000Z WARN hi'],
    ['network', '1970-01-01T00:00:00.000Z GET http://x/a → 200 [fetch]'],
  ]);
});

test('stop detaches every listener', () => {
  const { page, cap } = setup();
  expect(page.count()).toBe(5);
  cap.stop();
  expect(page.count()).toBe(0);
  page.emit('console', fakeConsole('log', 'late'));
  expect(cap.console()).toEqual([]);
});

test('start is idempotent (no double subscription)', () => {
  const { page, cap } = setup();
  cap.start();
  expect(page.count()).toBe(5);
});

// --- rebind (tab switch) ----------------------------------------------------

test('rebind moves listeners to the new page and keeps what was captured', async () => {
  const { page, cap } = setup();
  page.emit('console', fakeConsole('error', 'from tab 0'));

  const next = new FakeEmitter();
  cap.rebind(next as unknown as Page);

  // Old page is fully detached; the new one is live.
  expect(page.count()).toBe(0);
  expect(next.count()).toBe(5);

  next.emit('console', fakeConsole('error', 'from tab 1'));
  page.emit('console', fakeConsole('error', 'ignored'));

  // History survives the switch — the errors that sent the agent into the new
  // tab are usually the whole reason it went.
  expect(cap.console().map((e) => e.text)).toEqual(['from tab 1', 'from tab 0']);
});

test('rebind on a stopped capture does not resubscribe', () => {
  const { cap } = setup();
  cap.stop();
  const next = new FakeEmitter();
  cap.rebind(next as unknown as Page);
  expect(next.count()).toBe(0);
});

test('an abort after a response is teardown, not a second failed request', async () => {
  const { page, cap } = setup();
  const response = fakeResponse({
    method: 'POST',
    url: 'http://x/api/logout',
    status: 204,
    ok: true,
    resourceType: 'fetch',
    body: '',
  });
  page.emit('response', response);
  // Chrome fires this when the page navigates away right after the response —
  // with the SAME Request object, which is how the echo is recognized.
  const request = response.request() as unknown as {
    failure: () => { errorText: string };
  };
  request.failure = () => ({ errorText: 'net::ERR_ABORTED' });
  page.emit('requestfailed', request);
  await flush();

  const entries = cap.network();
  expect(entries.length).toBe(1);
  expect(entries[0]?.status).toBe(204);
  expect(entries[0]?.error).toBeUndefined();
});

test('a request that never answered is still recorded as failed', async () => {
  const { page, cap } = setup();
  page.emit(
    'requestfailed',
    fakeFailed({ url: 'http://x/api/dead', errorText: 'net::ERR_FAILED' }),
  );
  await flush();
  expect(cap.network()[0]?.error).toBe('net::ERR_FAILED');
});
