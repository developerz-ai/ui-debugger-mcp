/**
 * Attach teardown restores the adopted tab's pre-run URL — regression tests.
 *
 * Attaching takes over a tab in a browser we did NOT start (a developer's live
 * Chrome, a containerised one). The run then navigates it — `open()`, the
 * persona login, driver steps — and teardown must hand the tab back where it
 * was found, BEFORE the disconnect, while never touching any other tab and
 * never re-navigating a tab the run left alone.
 *
 * Same injected-chromium-seam pattern as `browser-adapter.lifecycle.test.ts`
 * (own minimal fakes to stay under the 500-LOC cap): a page fake with a
 * MUTABLE `url()` — the restore logic reads it before and after the run — a
 * `goto` spy that mutates it the way a real navigation would, and inert
 * `on`/`off` (only capture wiring subscribes here).
 */

import { expect, test } from 'bun:test';
import type { WebTarget } from '../../config/schema.js';
import { BrowserAdapter } from './browser-adapter.js';
import { NAV_TIMEOUT_MS } from './launch.js';

/** The injectable `chromium` seam's type, lifted off `BrowserAdapter.create` itself. */
type Launcher = NonNullable<Parameters<typeof BrowserAdapter.create>[0]['chromium']>;

const PRE_RUN_URL = 'http://127.0.0.1:9222/dashboard';

const webTarget = (over: Partial<WebTarget> = {}): WebTarget => ({
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  ...over,
});

/**
 * Minimal Playwright `Page` stand-in: mutable address, `goto` spy, inert
 * listeners. Every `goto` (the run's AND the restore's) is recorded in `gotos`
 * and echoed into the shared `events` trail, so a test can assert the ORDER of
 * navigations against the disconnect.
 */
function fakePage(url: string, events: string[]) {
  const state = {
    url,
    /** Every `goto` the adapter made, in order, with the timeout it asked for. */
    gotos: [] as Array<{ url: string; timeout: number | undefined }>,
    /** When set, a `goto` to THIS url rejects — the restore-failure case. */
    failGoto: undefined as string | undefined,
    /** When set, `url()` itself throws — the tab the owner closed mid-run. */
    dead: false,
  };
  const page = {
    on: () => undefined,
    off: () => undefined,
    bringToFront: async () => undefined, // selectTab asks the newly driven tab to front
    url: () => {
      if (state.dead) throw new Error('Target page, context or browser has been closed');
      return state.url;
    },
    goto: async (target: string, opts?: { timeout?: number }) => {
      if (target === state.failGoto) throw new Error('net::ERR_ABORTED');
      state.gotos.push({ url: target, timeout: opts?.timeout });
      state.url = target; // a real `goto` changes the address
      events.push(`goto:${target}`);
    },
  };
  return { page, state };
}

/**
 * An attached adapter over a fake browser whose disconnects land on the same
 * `events` trail as the pages' `goto`s — call order is the property under test.
 */
async function attached(pages: Array<ReturnType<typeof fakePage>['page']>, events: string[]) {
  let browserCloses = 0;
  const context = { pages: () => pages };
  const browser = {
    contexts: () => [context],
    newContext: async () => context,
    close: async () => {
      browserCloses += 1;
      events.push('browser.close');
    },
  };
  const chromium = {
    connectOverCDP: async () => browser,
  } as unknown as Launcher;
  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
  });
  return { adapter, closes: () => browserCloses };
}

// --- restore happens, in the right order ---------------------------------------

test('attach close() restores the adopted tab AFTER the run navigated it and BEFORE browser.close()', async () => {
  const events: string[] = [];
  const { page, state } = fakePage(PRE_RUN_URL, events);
  const { adapter, closes } = await attached([page], events);

  await adapter.open('/inbox'); // the run's first navigation — not the restore
  expect(state.url).toBe('http://localhost:5173/inbox');

  await adapter.close();
  // Order IS the property: the run's goto, then the restore, then the disconnect.
  expect(events).toEqual([
    'goto:http://localhost:5173/inbox',
    `goto:${PRE_RUN_URL}`,
    'browser.close',
  ]);
  // The restore nav carries the FIXED teardown cap — the run budget is gone by now.
  expect(state.gotos[1]).toEqual({ url: PRE_RUN_URL, timeout: 10_000 });

  await adapter.close(); // idempotent: the second close never re-navigates
  expect(events).toEqual([
    'goto:http://localhost:5173/inbox',
    `goto:${PRE_RUN_URL}`,
    'browser.close',
    'browser.close',
  ]);
  expect(state.gotos).toHaveLength(2);
  expect(closes()).toBe(2); // both closes disconnected — the browser was never stopped
});

test('the restored URL is the one snapshotted at attach, even after open() AND the persona login navigated', async () => {
  const events: string[] = [];
  const { page, state } = fakePage(PRE_RUN_URL, events);
  const { adapter } = await attached([page], events);

  // The run's `open()` to the target URL…
  await adapter.open('http://localhost:5173/app');
  // …then the persona login, which navigates THROUGH THE SAME adapter.open
  // (`services/login.ts`) before the loop's first step.
  await adapter.open('http://localhost:5173/login?next=/app');

  await adapter.close();
  // Both navigations happened, but the restore is the ORIGINAL pre-run
  // address — the snapshot predates open() and the sign-in alike.
  expect(state.gotos.map((g) => g.url)).toEqual([
    'http://localhost:5173/app',
    'http://localhost:5173/login?next=/app',
    PRE_RUN_URL,
  ]);
});

// --- scope: one tab, one disconnect ---------------------------------------------

test('a second, unrelated tab is never navigated, and the attached browser is only disconnected', async () => {
  const events: string[] = [];
  const adopted = fakePage(PRE_RUN_URL, events);
  const bystander = fakePage('http://127.0.0.1:9222/mail', events);
  const { adapter, closes } = await attached([adopted.page, bystander.page], events);

  await adapter.open('/inbox');
  await adapter.close();

  // The restore targets the ADOPTED page only — pages()[0] at attach time.
  expect(adopted.state.gotos.at(-1)).toEqual({ url: PRE_RUN_URL, timeout: 10_000 });
  // The bystander's goto spy never fired: its tab is not ours to move.
  expect(bystander.state.gotos).toEqual([]);
  // Disconnect once; attach never stops a browser we did not start.
  expect(closes()).toBe(1);
});

test('the restore targets the tab snapshotted AT ATTACH, not the one the driver last sat on', async () => {
  // Discriminating precondition for the guard above: the driver SWITCHES tabs
  // mid-run, so at close() the currently-driven tab is NOT the adopted one. A
  // restore keyed on the driven tab instead of the attach-time snapshot would
  // navigate the bystander here — every other test leaves them identical.
  const events: string[] = [];
  const adopted = fakePage(PRE_RUN_URL, events);
  const bystander = fakePage('http://127.0.0.1:9222/mail', events);
  const { adapter, closes } = await attached([adopted.page, bystander.page], events);

  await adapter.open('/feed'); // move the adopted tab while it is still driven…
  await adapter.selectTab(1); // …then switch the driver to the bystander…
  await adapter.open('/inbox'); // …and move THAT one too

  await adapter.close();
  // The snapshot page gets the restore — even though the driver ended elsewhere.
  expect(adopted.state.gotos.at(-1)).toEqual({ url: PRE_RUN_URL, timeout: 10_000 });
  // The tab we ended up driving is not the restore target: its run navigation is
  // all it ever received — and it spent the run's OWN nav cap, not the restore's
  // fixed 10s teardown cap (same 30s-vs-10s contrast test 1 pins on the adopted tab).
  expect(bystander.state.gotos).toEqual([
    { url: 'http://localhost:5173/inbox', timeout: NAV_TIMEOUT_MS },
  ]);
  // Order holds across the switch: feed, inbox, restore, disconnect.
  expect(events).toEqual([
    'goto:http://localhost:5173/feed',
    'goto:http://localhost:5173/inbox',
    `goto:${PRE_RUN_URL}`,
    'browser.close',
  ]);
  expect(closes()).toBe(1);
});

// --- managed is untouched --------------------------------------------------------

test('managed teardown stays context.close() only — no restore navigation on the managed page', async () => {
  const events: string[] = [];
  const { page, state } = fakePage('about:blank', events);
  let contextCloses = 0;
  const chromium = {
    launchPersistentContext: async () => ({
      pages: () => [page],
      close: async () => {
        contextCloses += 1;
        events.push('context.close');
      },
    }),
  } as unknown as Launcher;
  const adapter = await BrowserAdapter.create({
    config: webTarget(),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  await adapter.open('/app');
  await adapter.close();

  // The run's navigation happened; the restore did NOT — managed owns the profile.
  expect(events).toEqual(['goto:http://localhost:5173/app', 'context.close']);
  expect(state.gotos).toHaveLength(1);
  expect(contextCloses).toBe(1);
});

// --- best-effort: failure swallowed, unmoved tab skipped --------------------------

test('a failing restore navigation is swallowed — close() resolves and the disconnect still happens', async () => {
  const events: string[] = [];
  const { page, state } = fakePage(PRE_RUN_URL, events);
  state.failGoto = PRE_RUN_URL; // the restore `goto` rejects (wedged target)
  const { adapter, closes } = await attached([page], events);

  await adapter.open('/inbox'); // move the tab, so the restore is NOT skipped
  await expect(adapter.close()).resolves.toBeUndefined(); // the failure never surfaces
  expect(closes()).toBe(1); // the disconnect still ran
  expect(state.gotos).toHaveLength(1); // the failed restore left no navigation behind

  await adapter.close(); // and it is not retried on a second close
  expect(closes()).toBe(2);
  expect(state.gotos).toHaveLength(1);
});

test('a tab the owner closed mid-run throws from url() — close() still resolves and disconnects', async () => {
  const events: string[] = [];
  const { page, state } = fakePage(PRE_RUN_URL, events);
  const { adapter, closes } = await attached([page], events);

  await adapter.open('/inbox'); // the run moved the tab before the owner closed it
  state.dead = true; // tab (or whole browser) gone mid-run: reading its address throws

  await expect(adapter.close()).resolves.toBeUndefined(); // the dead handle never rejects teardown
  // The disconnect still ran — order holds, the CDP connection is not leaked.
  expect(events).toEqual(['goto:http://localhost:5173/inbox', 'browser.close']);
  expect(closes()).toBe(1);

  // The once-guard holds: a retried restore would throw from url() again —
  // this resolving proves the second close never touches the dead tab.
  await expect(adapter.close()).resolves.toBeUndefined();
  expect(closes()).toBe(2);
  expect(events.filter((event) => event === 'browser.close')).toHaveLength(2);
});

test('a tab the run never navigated is not reloaded — close() skips the goto when the url still matches', async () => {
  const events: string[] = [];
  const { page, state } = fakePage(PRE_RUN_URL, events);
  const { adapter, closes } = await attached([page], events);

  await adapter.close(); // no open() — the tab sits exactly where we found it
  expect(state.gotos).toEqual([]); // no pointless reload
  expect(events).toEqual(['browser.close']); // only the disconnect happened
  expect(closes()).toBe(1);
});
