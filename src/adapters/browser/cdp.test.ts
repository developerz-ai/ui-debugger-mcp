/**
 * `CdpCapture` — the live console/network observers. The pure pieces it leans on
 * are covered next door: rendering + redaction in `log-format.test.ts`, the
 * whitelisted `filters` in `log-filters.test.ts`.
 */

import { expect, test } from 'bun:test';
import type { Page } from 'playwright-core';
import { BODY_UNFINISHED, type CaptureSink, CdpCapture } from './cdp.js';

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
 * Let the async response capture settle. The row is buffered synchronously, but
 * its bodies/headers (and its log line) land behind an await.
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

function setup(opts?: {
  now?: () => number;
  cap?: number;
  sink?: CaptureSink;
  bodyWaitMs?: number;
}) {
  const page = new FakeEmitter();
  const cap = new CdpCapture({
    page: page as unknown as Page,
    now: opts?.now ?? (() => 1000),
    cap: opts?.cap,
    sink: opts?.sink,
    bodyWaitMs: opts?.bodyWaitMs,
  });
  cap.start();
  return { page, cap };
}

// --- CdpCapture -------------------------------------------------------------

test('captures console messages newest-first with normalized level', () => {
  const { page, cap } = setup();
  page.emit('console', fakeConsole('log', 'first'));
  page.emit('console', fakeConsole('warning', 'second'));
  const out = cap.console();
  expect(out.map((e) => e.text)).toEqual(['second', 'first']);
  expect(out[0]?.level).toBe('warn');
});

test('builds console location url:line:column 1-BASED, omits when no url', () => {
  // Playwright reports both 0-based; `url:line:col` is read 1-based, so the raw
  // numbers sent the smart agent to the line above the actual error.
  const { page, cap } = setup();
  page.emit('console', fakeConsole('error', 'x', 'app.js', 3, 7));
  page.emit('console', fakeConsole('error', 'y', '', 0, 0));
  const out = cap.console();
  expect(out[0]?.location).toBeUndefined();
  expect(out[1]?.location).toBe('app.js:4:8');
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
  expect(entry?.requestHeaders?.cookie).toBe('<redacted, 19 chars>');
  expect(entry?.requestHeaders?.accept).toBe('application/json');
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

// --- a body that never finishes ---------------------------------------------

test('a streaming response is recorded IMMEDIATELY, before its body finishes', async () => {
  // `fetch('/events')` (SSE, long-poll) only "finishes" at teardown. Waiting for
  // the body before buffering left the exchange with zero trace — no row, no log
  // line — and the abort at teardown was then swallowed as a response echo.
  const lines: string[] = [];
  const { page, cap } = setup({ bodyWaitMs: 20, sink: (_ch, line) => lines.push(line) });
  const streaming = {
    ...fakeResponse({ url: 'http://x/events', status: 200, ok: true, resourceType: 'fetch' }),
    text: () => new Promise<string>(() => undefined), // never settles
  };
  page.emit('response', streaming);

  // Visible in the SAME tick the headers arrived — the driver polls, it cannot wait.
  const [live] = cap.network();
  expect(live?.url).toBe('http://x/events');
  expect(live?.status).toBe(200);
  expect(live?.responseBody).toBeUndefined();

  // The teardown abort that finally ends the stream neither erases the row nor
  // adds a phantom second one.
  const request = streaming.request() as unknown as { failure: () => { errorText: string } };
  request.failure = () => ({ errorText: 'net::ERR_ABORTED' });
  page.emit('requestfailed', request);

  // Once the cap expires the row says WHY the body is missing, and the durable
  // log line finally lands (once, with everything that could be read).
  await new Promise((r) => setTimeout(r, 60));
  const entries = cap.network();
  expect(entries.length).toBe(1);
  expect(entries[0]?.responseBody).toBe(BODY_UNFINISHED);
  expect(entries[0]?.error).toBeUndefined();
  expect(lines.filter((l) => l.includes('/events')).length).toBe(1);
});

test('a REAL failure after the response amends the exchange instead of vanishing', async () => {
  // A connection reset mid-body is not the teardown echo: reported as a clean
  // `200 ok:true` it is indistinguishable from a body-less success.
  const lines: string[] = [];
  const { page, cap } = setup({ sink: (_ch, line) => lines.push(line) });
  const response = fakeResponse({ url: 'http://x/api/report', status: 200, ok: true, body: '{' });
  page.emit('response', response);
  await flush();
  const request = response.request() as unknown as { failure: () => { errorText: string } };
  request.failure = () => ({ errorText: 'net::ERR_CONNECTION_RESET' });
  page.emit('requestfailed', request);

  const entries = cap.network();
  expect(entries.length).toBe(1);
  expect(entries[0]?.error).toBe('net::ERR_CONNECTION_RESET');
  expect(entries[0]?.ok).toBe(false);
  expect(entries[0]?.status).toBe(200);
  // The durable log carries the amended verdict too, not just the clean line.
  expect(lines.some((l) => l.includes('FAILED net::ERR_CONNECTION_RESET'))).toBe(true);
});

test('a credential-bearing URL never reaches the buffer or the log verbatim', async () => {
  const lines: string[] = [];
  const { page, cap } = setup({ sink: (_ch, line) => lines.push(line) });
  const url = 'https://app/oauth?access_token=ya29.SECRET';
  page.emit('response', fakeResponse({ url, status: 200, ok: true, body: '{}' }));
  page.emit(
    'requestfailed',
    fakeFailed({ url: 'https://app/reset?token=SECRET2', errorText: 'net::ERR_FAILED' }),
  );
  await flush();
  const urls = cap.network().map((e) => e.url);
  expect(urls.some((u) => u.includes('ya29.SECRET'))).toBe(false);
  expect(urls.some((u) => u.includes('SECRET2'))).toBe(false);
  expect(urls).toContain('https://app/oauth?access_token=<redacted, 11 chars>');
  expect(lines.some((l) => l.includes('SECRET'))).toBe(false);
});
