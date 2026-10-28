/**
 * Tab attribution end to end — the adapter, the capture and the durable trail.
 *
 * The unit tests next door prove the pieces (the capture stamps at event time
 * in `cdp.test.ts`, the renderers draw the marker in `log-format.test.ts`).
 * This file proves the PROMISE the durable trail makes: a row names the tab it
 * came from, the name survives a tab switch and a closing tab, and the marker
 * is opaque — it carries no URL and no secret, and it does not defeat the
 * per-run redactor.
 *
 * A fake browser context stands in for Playwright: its pages are event
 * emitters, so a test can fire the console/network events the capture listens
 * for, and the tab list can be shortened mid-run to shift the indices.
 */

import { expect, test } from 'bun:test';
import type { WebTarget } from '../../config/schema.js';
import { createSecretRedactor } from '../../redact.js';
import { BrowserAdapter } from './browser-adapter.js';
import type { CaptureSink } from './cdp.js';

type Listener = (arg: unknown) => void;

/** Minimal stand-in for a Playwright `Page`: an event emitter plus the few reads the adapter makes. */
class FakePage {
  readonly #listeners = new Map<string, Listener[]>();
  /** The page's address — a landmark, never part of the tab marker. */
  location: string;

  constructor(location: string) {
    this.location = location;
  }

  on(event: string, listener: Listener): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  off(event: string, listener: Listener): this {
    this.#listeners.set(
      event,
      (this.#listeners.get(event) ?? []).filter((l) => l !== listener),
    );
    return this;
  }

  /** Fire one of the events the capture listens for. */
  emit(event: string, arg: unknown): void {
    for (const listener of [...(this.#listeners.get(event) ?? [])]) listener(arg);
  }

  url(): string {
    return this.location;
  }

  title = async (): Promise<string> => 'Fake tab';

  evaluate = async (): Promise<boolean> => true;

  bringToFront = async (): Promise<void> => undefined;
}

/** A console message as Playwright hands it over. */
const fakeConsole = (type: string, text: string) => ({
  type: () => type,
  text: () => text,
  location: () => ({ url: '', line: 0, column: 0 }),
});

/** A response as Playwright hands it over — one request object, so it can be timed. */
const fakeResponse = (url: string) => {
  const request = {
    method: () => 'GET',
    url: () => url,
    resourceType: () => 'fetch',
    postData: () => null,
    allHeaders: async () => ({}),
  };
  return {
    status: () => 200,
    ok: () => true,
    url: () => url,
    text: async () => '{}',
    allHeaders: async () => ({}),
    request: () => request,
  };
};

/** Let the async response capture settle — the row is buffered at once, its line lands after the body read. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const webTarget = (over: Partial<WebTarget> = {}): WebTarget => ({
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  ...over,
});

/** The injectable `chromium` seam's type, lifted off `BrowserAdapter.create` itself. */
type Launcher = NonNullable<Parameters<typeof BrowserAdapter.create>[0]['chromium']>;

/**
 * An attached adapter over a fake context whose page list the test controls.
 *
 * `onLog` stands in for the session's sink: `session-builder.ts` binds it to
 * `logs/console.log` / `logs/network.log` through the per-run redactor, and
 * that is the trail these tests read.
 */
async function attached(pages: FakePage[], onLog?: CaptureSink) {
  const context = { pages: () => pages };
  const browser = {
    contexts: () => [context],
    close: async () => undefined,
  };
  const chromium = {
    connectOverCDP: async () => browser,
  } as unknown as Launcher;
  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://localhost:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
    onLog,
  });
  return { adapter };
}

// --- the trail names the tab -------------------------------------------------

test('each captured row names the tab it came from', async () => {
  const lines: string[] = [];
  const first = new FakePage('http://localhost:5173/one');
  const second = new FakePage('http://localhost:5173/two');
  const { adapter } = await attached([first, second], (_channel, line) => lines.push(line));
  try {
    first.emit('console', fakeConsole('log', 'from the first tab'));
    await adapter.selectTab(1);
    second.emit('console', fakeConsole('log', 'from the second tab'));

    expect(lines[0]).toMatch(/^\S+ \[tab-1\] LOG from the first tab$/);
    expect(lines[1]).toMatch(/^\S+ \[tab-2\] LOG from the second tab$/);
  } finally {
    await adapter.close();
  }
});

test('a network row names the tab its response came from', async () => {
  const lines: string[] = [];
  const page = new FakePage('http://localhost:5173/one');
  const { adapter } = await attached([page], (_channel, line) => lines.push(line));
  try {
    page.emit('response', fakeResponse('http://localhost:5173/api/me'));
    await flush();
    expect(lines[0]).toMatch(
      /^\S+ \[tab-1\] GET http:\/\/localhost:5173\/api\/me → 200 \[fetch\]$/,
    );
  } finally {
    await adapter.close();
  }
});

test('the tabs listing carries the same id the rows carry', async () => {
  const first = new FakePage('http://localhost:5173/one');
  const second = new FakePage('http://localhost:5173/two');
  const { adapter } = await attached([first, second]);
  try {
    // The id is the SAME label the log lines carry — that is what resolves a
    // `[tab-2]` marker to the tab the driver drove.
    expect((await adapter.tabs()).map(({ index, id }) => ({ index, id }))).toEqual([
      { index: 0, id: 'tab-1' },
      { index: 1, id: 'tab-2' },
    ]);
  } finally {
    await adapter.close();
  }
});

// --- the label follows the page, not the index -------------------------------

test('closing an earlier tab shifts the indices — the same page keeps its marker', async () => {
  const lines: string[] = [];
  const first = new FakePage('http://localhost:5173/one');
  const second = new FakePage('http://localhost:5173/two');
  const pages = [first, second];
  const { adapter } = await attached(pages, (_channel, line) => lines.push(line));
  try {
    first.emit('console', fakeConsole('log', 'before the close'));

    // The first tab closes: `second` is now index 0. A label built from the
    // index would now read `tab-1` — the CLOSED tab's marker, pointing at the
    // wrong tab for the rest of the run.
    pages.splice(0, 1);
    await adapter.selectTab(0);
    second.emit('console', fakeConsole('log', 'after the close'));

    expect((await adapter.tabs()).map(({ index, id }) => ({ index, id }))).toEqual([
      { index: 0, id: 'tab-2' },
    ]);
    expect(lines[0]).toMatch(/^\S+ \[tab-1\] LOG before the close$/);
    expect(lines[1]).toMatch(/^\S+ \[tab-2\] LOG after the close$/);
  } finally {
    await adapter.close();
  }
});

// --- the marker is opaque ----------------------------------------------------

test('the marker is opaque — it leaks no URL and no secret, and the redactor still scrubs the row', async () => {
  // `hunter2` is a SYNTHETIC persona value (7 chars → `<redacted, 7 chars>`),
  // never a real credential — the same redactor `session-builder.ts` binds per
  // run and wraps every `logs/*.log` sink.
  const redact = createSecretRedactor(['hunter2']);
  const lines: string[] = [];
  const page = new FakePage('http://localhost:5173/login?code=secret');
  const { adapter } = await attached([page], (_channel, line) => lines.push(redact(line)));
  try {
    page.emit('console', fakeConsole('log', 'typed hunter2'));

    const line = lines[0] ?? '';
    // The marker holds the opaque label and NOTHING else — no URL, no title.
    expect(line).toMatch(/^\S+ \[([^\]]*)\] LOG typed <redacted, 7 chars>$/);
    expect(line.match(/\[([^\]]*)\]/)?.[1]).toBe('tab-1');
    // The secret is gone; the marker never carried it.
    expect(line).not.toContain('hunter2');
    expect(line).not.toContain('localhost');
  } finally {
    await adapter.close();
  }
});
