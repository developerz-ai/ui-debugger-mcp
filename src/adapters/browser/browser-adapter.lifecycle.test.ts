/**
 * `BrowserAdapter` class-level behavior — create/attach wiring, `waitFor`,
 * `scroll`, `close` — exercised against a fake `chromium` launcher injected via
 * `BrowserAdapterInit.chromium` (a test seam, same pattern as
 * `AndroidAdapterInit.adb` / `DesktopAdapterInit.atspi`), rather than a real
 * browser or a global module mock. Split out of `browser-adapter.test.ts`
 * (which stays pure-function-only) to keep both files under the 500-LOC cap.
 *
 * Module-mocking `playwright-core` was tried first and rejected: `mock.module`
 * replaces the module for the WHOLE test run, and `bun test` does not fully
 * serialize test files against each other — a mock set here was observed
 * leaking into concurrently-running assertions in
 * `browser-adapter.integration.test.ts`. The injected-seam approach below has
 * no such cross-file blast radius.
 */

import { expect, test } from 'bun:test';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import type { Node } from '../contract.js';
import { BrowserAdapter } from './browser-adapter.js';

/** The injectable `chromium` seam's type, lifted off `BrowserAdapter.create` itself. */
type Launcher = NonNullable<Parameters<typeof BrowserAdapter.create>[0]['chromium']>;

const webTarget = (over: Partial<WebTarget> = {}): WebTarget => ({
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  ...over,
});

interface FakePageOpts {
  viewport?: { width: number; height: number } | null;
  waitForError?: Error;
  /** What `page.evaluate` answers — the in-page viewport probe, for attach targets. */
  evaluate?: () => unknown;
  /** Extra frames beyond the main one, for the cross-frame selector paths. */
  extraFrames?: Array<ReturnType<typeof fakeFrame>>;
}

/** Minimal stand-in for a Playwright `Frame` — `#collect`/`#locate`/`waitFor` fan out over these. */
function fakeFrame(opts: { waitForError?: Error; count?: number } = {}) {
  return {
    parentFrame: () => null,
    isDetached: () => false,
    locator: () => ({
      first: () => ({
        click: async () => undefined,
        count: async () => opts.count ?? 0,
        waitFor: async () => {
          if (opts.waitForError) throw opts.waitForError;
        },
        boundingBox: async () => ({ x: 0, y: 0, width: 10, height: 10 }),
      }),
      evaluateAll: async () => [],
    }),
  };
}

/** Minimal stand-in for a Playwright `Page` — only the members the adapter calls. */
function fakePage(opts: FakePageOpts = {}) {
  const main = fakeFrame({ ...(opts.waitForError ? { waitForError: opts.waitForError } : {}) });
  return {
    on: () => undefined,
    off: () => undefined,
    viewportSize: () => opts.viewport ?? { width: 1280, height: 720 },
    evaluate: async () => opts.evaluate?.() ?? { width: 1280, height: 720 },
    frames: () => [main, ...(opts.extraFrames ?? [])],
    mouse: {
      move: async () => undefined,
      wheel: async () => undefined,
      click: async () => undefined,
    },
    keyboard: { type: async () => undefined, press: async () => undefined },
    goto: async () => undefined,
    screenshot: async () => new Uint8Array(),
    waitForLoadState: async () => undefined,
    locator: main.locator,
  };
}

/**
 * Build a fake `chromium` launcher from partial `launchPersistentContext`/`connectOverCDP`
 * stubs. Untyped input on purpose — a fake never has the real, 40-plus-option
 * Playwright signature, so this casts once instead of fighting structural checks
 * per call site.
 */
function fakeLauncher(over: Record<string, unknown>): Launcher {
  return over as unknown as Launcher;
}

// --- create (launch failure cleanup) -----------------------------------------

test('create closes a just-launched context when post-connect setup throws (no zombie Chrome)', async () => {
  let closes = 0;
  const fakeContext = {
    pages: () => [],
    newPage: async () => {
      throw new Error('newPage: Target closed');
    },
    close: async () => {
      closes += 1;
    },
  };
  const chromium = fakeLauncher({ launchPersistentContext: async () => fakeContext });

  const created = BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
  });
  await expect(created).rejects.toThrow(AdapterError);
  expect(closes).toBe(1); // the half-built context was closed, not leaked
});

// --- create/open (the run's wall-clock budget) --------------------------------

test('a launch + first navigation spend the run budget, not Playwright’s own defaults', async () => {
  let launchTimeout: number | undefined;
  let gotoTimeout: number | undefined;
  const page = {
    ...fakePage(),
    goto: async (_url: string, opts?: { timeout?: number }) => {
      gotoTimeout = opts?.timeout;
    },
  };
  const chromium = fakeLauncher({
    launchPersistentContext: async (_dir: string, opts?: { timeout?: number }) => {
      launchTimeout = opts?.timeout;
      return { pages: () => [page], close: async () => undefined };
    },
  });

  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
    timeoutMs: 4_000,
  });
  await adapter.open('http://localhost:5173', 2_500);

  expect(launchTimeout).toBe(4_000);
  expect(gotoTimeout).toBe(2_500);
});

test('a budget wider than the adapter default never extends it', async () => {
  let launchTimeout: number | undefined;
  let gotoTimeout: number | undefined;
  const page = {
    ...fakePage(),
    goto: async (_url: string, opts?: { timeout?: number }) => {
      gotoTimeout = opts?.timeout;
    },
  };
  const chromium = fakeLauncher({
    launchPersistentContext: async (_dir: string, opts?: { timeout?: number }) => {
      launchTimeout = opts?.timeout;
      return { pages: () => [page], close: async () => undefined };
    },
  });

  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
    timeoutMs: 300_000,
  });
  await adapter.open('http://localhost:5173', 300_000);

  expect(launchTimeout).toBe(30_000);
  expect(gotoTimeout).toBe(30_000);
});

// --- create (attach cdpUrl path) ---------------------------------------------

test('create (attach) reuses the browser’s existing context/page instead of opening new ones', async () => {
  const page = fakePage();
  const context = { pages: () => [page] };
  let newContextCalls = 0;
  let connectedUrl: string | undefined;
  const browser = {
    contexts: () => [context],
    newContext: async () => {
      newContextCalls += 1;
      return context;
    },
    close: async () => undefined,
  };
  const chromium = fakeLauncher({
    connectOverCDP: async (url: string) => {
      connectedUrl = url;
      return browser;
    },
  });

  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  expect(adapter).toBeInstanceOf(BrowserAdapter);
  expect(connectedUrl).toBe('http://127.0.0.1:9222');
  expect(newContextCalls).toBe(0);
});

test('create (attach) opens a fresh context/page when the browser has none', async () => {
  const page = fakePage();
  let newContextCalls = 0;
  let newPageCalls = 0;
  const freshContext = {
    pages: () => [],
    newPage: async () => {
      newPageCalls += 1;
      return page;
    },
  };
  const browser = {
    contexts: () => [],
    newContext: async () => {
      newContextCalls += 1;
      return freshContext;
    },
    close: async () => undefined,
  };
  const chromium = fakeLauncher({ connectOverCDP: async () => browser });

  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  expect(adapter).toBeInstanceOf(BrowserAdapter);
  expect(newContextCalls).toBe(1);
  expect(newPageCalls).toBe(1);
});

// --- close (idempotent) -------------------------------------------------------

test('close() is idempotent — calling it twice never throws (managed mode)', async () => {
  let contextCloses = 0;
  const fakeContext = {
    pages: () => [fakePage()],
    close: async () => {
      contextCloses += 1;
    },
  };
  const chromium = fakeLauncher({ launchPersistentContext: async () => fakeContext });

  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  await expect(adapter.close()).resolves.toBeUndefined();
  await expect(adapter.close()).resolves.toBeUndefined();
  expect(contextCloses).toBe(2);
});

test('close() on an attached browser only disconnects, and is idempotent too', async () => {
  let browserCloses = 0;
  const context = { pages: () => [fakePage()] };
  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => {
      browserCloses += 1;
    },
  };
  const chromium = fakeLauncher({ connectOverCDP: async () => browser });

  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  await expect(adapter.close()).resolves.toBeUndefined();
  await expect(adapter.close()).resolves.toBeUndefined();
  expect(browserCloses).toBe(2); // never stops a browser we didn't start managing — just disconnects
});

// --- waitFor (timeout) --------------------------------------------------------

test('waitFor surfaces a Playwright timeout as AdapterError, not a raw error', async () => {
  const page = fakePage({ waitForError: new Error('Timeout 500ms exceeded.') });
  const fakeContext = { pages: () => [page], close: async () => undefined };
  const chromium = fakeLauncher({ launchPersistentContext: async () => fakeContext });

  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  const waited = adapter.waitFor({ query: '#missing', timeout: 500 });
  await expect(waited).rejects.toThrow(AdapterError);
  await expect(adapter.waitFor({ query: '#missing', timeout: 500 })).rejects.toThrow(
    /Timeout 500ms exceeded/,
  );
});

test('waitFor resolves off a CHILD frame — the wait falls through iframes like every other selector', async () => {
  // `page.locator()` stops at the iframe boundary, so a driver that read a node
  // tagged `frame=…` and then waited for it burned the whole timeout.
  const embedded = fakeFrame({ count: 1 });
  const page = fakePage({
    // The MAIN frame never has it — Playwright brands a wait that ran out as this.
    waitForError: Object.assign(new Error('Timeout 500ms exceeded.'), { name: 'TimeoutError' }),
    extraFrames: [embedded],
  });
  const fakeContext = { pages: () => [page], close: async () => undefined };
  const chromium = fakeLauncher({ launchPersistentContext: async () => fakeContext });

  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  await expect(
    adapter.waitFor({ query: 'data-testid=card-number', timeout: 500 }),
  ).resolves.toBeUndefined();
});

// --- scroll (off-viewport guard) ---------------------------------------------

test('the off-viewport guard still works when Playwright reports no viewport (attach)', async () => {
  // `connectOverCDP` hard-codes `noDefaultViewport: true`, so EVERY attach target
  // reports null — treating that as "inside" disabled the guard exactly there.
  const context = {
    pages: () => [fakePage({ viewport: null, evaluate: () => ({ width: 1280, height: 720 }) })],
  };
  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => undefined,
  };
  const chromium = fakeLauncher({ connectOverCDP: async () => browser });

  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  const belowTheFold: Node = {
    role: 'button',
    name: 'Pay now',
    bounds: { x: 100, y: 4_200, width: 80, height: 30 },
    enabled: true,
  };
  await expect(adapter.click(belowTheFold)).rejects.toThrow(/outside the viewport/);
});

test('scroll: an off-viewport `within` Node fails loud instead of scrolling blind', async () => {
  const fakeContext = {
    pages: () => [fakePage({ viewport: { width: 1280, height: 720 } })],
    close: async () => undefined,
  };
  const chromium = fakeLauncher({ launchPersistentContext: async () => fakeContext });

  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  const offscreen: Node = {
    role: 'generic',
    name: 'off-screen box',
    bounds: { x: 5_000, y: 5_000, width: 10, height: 10 },
    enabled: true,
  };
  const scrolled = adapter.scroll({ direction: 'down', within: offscreen });
  await expect(scrolled).rejects.toThrow(AdapterError);
  await expect(adapter.scroll({ direction: 'down', within: offscreen })).rejects.toThrow(
    /outside the viewport/,
  );
});
