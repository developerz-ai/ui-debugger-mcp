/**
 * Shared fakes for the `CdpCapture` suites (`cdp.test.ts`, `cdp.exchange.test.ts`):
 * a minimal Playwright `Page` emitter, console/response/failure stand-ins, and a
 * started capture over them.
 */

import type { Page } from 'playwright-core';
import { type CaptureSink, CdpCapture } from './cdp.js';
import { TabContext } from './tab-context.js';

type Listener = (arg: unknown) => void;

/** Minimal event emitter standing in for a Playwright `Page`. */
export class FakeEmitter {
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

export const fakeConsole = (type: string, text: string, url = 'app.js', line = 10, column = 5) => ({
  type: () => type,
  text: () => text,
  location: () => ({ url, line, column, lineNumber: line, columnNumber: column }),
});

export const fakeResponse = (o: {
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
    headers: () => o.requestHeaders ?? {},
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
    // Playwright's sync `headers()` is lower-cased names; the fakes pass them so.
    headers: () => o.responseHeaders ?? {},
    request: () => request,
  };
};

/**
 * Let the async response capture settle. The row is buffered synchronously, but
 * its bodies/headers (and its log line) land behind an await.
 */
export const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export const fakeFailed = (o: {
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

export function setup(opts?: {
  now?: () => number;
  cap?: number;
  sink?: CaptureSink;
  bodyWaitMs?: number;
}) {
  const page = new FakeEmitter();
  const tabs = new TabContext();
  const cap = new CdpCapture({
    page: page as unknown as Page,
    tabs,
    now: opts?.now ?? (() => 1000),
    cap: opts?.cap,
    sink: opts?.sink,
    bodyWaitMs: opts?.bodyWaitMs,
  });
  cap.start();
  return { page, cap, tabs };
}
