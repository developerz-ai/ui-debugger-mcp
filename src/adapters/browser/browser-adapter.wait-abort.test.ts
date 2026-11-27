/**
 * `waitFor({signal})` — an aborted run stops its wait AT ONCE.
 *
 * The contract: an already-aborted or mid-wait abort rejects with an
 * `AbortError`-named error (what the belt and the loop key off), every frame
 * poller stops, and the abort listener is removed on every path — success,
 * timeout and abort alike. Same injected-chromium seam as
 * `browser-adapter.lifecycle.test.ts`, with a frame fake whose `waitFor` behaves
 * like Playwright's: it never matches and times out after its slice.
 */

import { expect, test } from 'bun:test';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import { BrowserAdapter } from './browser-adapter.js';

type Launcher = NonNullable<Parameters<typeof BrowserAdapter.create>[0]['chromium']>;

const webTarget: WebTarget = { adapter: 'browser', url: 'http://localhost:5173', headless: true };

/** Playwright brands an expired wait `TimeoutError` — the poll's "not here yet". */
function timeoutError(ms: number): Error {
  const error = new Error(`Timeout ${ms}ms exceeded.`);
  error.name = 'TimeoutError';
  return error;
}

/**
 * A managed adapter over one page whose selector never appears (`matches: false`)
 * or appears at once, and whose networkidle wait hangs until its timeout.
 */
async function adapterWith(opts: { matches: boolean }) {
  const calls = { frameWaits: 0 };
  const frame = {
    parentFrame: () => null,
    isDetached: () => false,
    locator: () => ({
      first: () => ({
        waitFor: async ({ timeout }: { timeout: number }) => {
          calls.frameWaits += 1;
          if (opts.matches) return;
          await Bun.sleep(timeout);
          throw timeoutError(timeout);
        },
      }),
    }),
  };
  const page = {
    on: () => undefined,
    off: () => undefined,
    url: () => 'about:blank',
    frames: () => [frame],
    waitForLoadState: async (_state: string, { timeout }: { timeout: number }) => {
      await Bun.sleep(timeout);
      throw timeoutError(timeout);
    },
  };
  const context = { pages: () => [page], close: async () => undefined };
  const adapter = await BrowserAdapter.create({
    config: webTarget,
    profileDir: '/tmp/unused-profile',
    chromium: { launchPersistentContext: async () => context } as unknown as Launcher,
  });
  return { adapter, calls };
}

/** An AbortController whose signal counts live `abort` listeners. */
function trackedSignal() {
  const controller = new AbortController();
  const live = new Set<unknown>();
  const { signal } = controller;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = ((type: string, fn: EventListener, o?: AddEventListenerOptions) => {
    if (type === 'abort') live.add(fn);
    add(type, fn, o);
  }) as typeof signal.addEventListener;
  signal.removeEventListener = ((type: string, fn: EventListener) => {
    if (type === 'abort') live.delete(fn);
    remove(type, fn);
  }) as typeof signal.removeEventListener;
  return { controller, signal, live };
}

test('an already-aborted signal rejects AbortError before any poller starts', async () => {
  const { adapter, calls } = await adapterWith({ matches: true });
  const signal = AbortSignal.abort();
  const error = await adapter.waitFor({ query: '#x', signal }).catch((e: unknown) => e);
  expect((error as Error).name).toBe('AbortError');
  expect(calls.frameWaits).toBe(0);
});

test('a mid-wait abort rejects AbortError at once and the frame poll stops', async () => {
  const { adapter, calls } = await adapterWith({ matches: false });
  const { controller, signal, live } = trackedSignal();
  const started = Date.now();
  const waiting = adapter
    .waitFor({ query: '#never', timeout: 10_000, signal })
    .catch((e: unknown) => e);
  await Bun.sleep(30);
  controller.abort();

  const error = await waiting;
  expect((error as Error).name).toBe('AbortError');
  expect(Date.now() - started).toBeLessThan(200); // not the 10s budget, not even one slice
  expect(live.size).toBe(0);

  // The in-flight slice runs out (≤250ms); no NEW slice may start after the abort.
  await Bun.sleep(400);
  const settled = calls.frameWaits;
  await Bun.sleep(400);
  expect(calls.frameWaits).toBe(settled);
  expect(settled).toBe(1);
});

test('an abort during the networkidle phase rejects AbortError, not the full timeout', async () => {
  const { adapter } = await adapterWith({ matches: true });
  const { controller, signal, live } = trackedSignal();
  const started = Date.now();
  const waiting = adapter
    .waitFor({ query: '#x', networkIdle: true, timeout: 10_000, signal })
    .catch((e: unknown) => e);
  await Bun.sleep(30);
  controller.abort();
  expect(((await waiting) as Error).name).toBe('AbortError');
  expect(Date.now() - started).toBeLessThan(200);
  expect(live.size).toBe(0);
});

test('a custom abort reason still surfaces AbortError-named', async () => {
  const { adapter } = await adapterWith({ matches: false });
  const controller = new AbortController();
  const waiting = adapter
    .waitFor({ query: '#never', timeout: 10_000, signal: controller.signal })
    .catch((e: unknown) => e);
  controller.abort(new Error('run timed out'));
  expect(((await waiting) as Error).name).toBe('AbortError');
});

test('the abort listener is removed on success and on timeout too', async () => {
  const hit = await adapterWith({ matches: true });
  const ok = trackedSignal();
  await hit.adapter.waitFor({ query: '#x', signal: ok.signal });
  expect(ok.live.size).toBe(0);

  const miss = await adapterWith({ matches: false });
  const late = trackedSignal();
  const error = await miss.adapter
    .waitFor({ query: '#never', timeout: 50, signal: late.signal })
    .catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AdapterError); // an expiry stays an ordinary adapter failure
  expect(late.live.size).toBe(0);
});
