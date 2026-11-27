/**
 * Browser-adapter lifecycle — how the adapter's handles come to be.
 *
 * Two lifecycles (see `idea/adapters.md`):
 *   - **managed** (default): launch a persistent context with the per-project
 *     profile; we OWN start/stop. `executablePath` picks the binary, else system
 *     Chrome (`channel`) — `playwright-core` ships no bundled browser.
 *   - **attach**: connect to an already-running browser over CDP (`cdpUrl`) and
 *     NEVER start/stop it — `close()` returns the adopted tab to its pre-run
 *     URL (best-effort) and then disconnects.
 *
 * Split out of `browser-adapter.ts` (500-LOC cap): this module only ASSEMBLES the
 * raw {@link AdapterHandles}; the adapter class alone turns them into a
 * `BrowserAdapter` (its constructor stays private there), so the dependency runs
 * one way — nothing here imports the class.
 *
 * Fails loud — every Playwright call is wrapped to throw {@link AdapterError}
 * (`createFailure` names the failing lifecycle; see `launch.ts`).
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import { capWait } from '../budget.js';
import type { CaptureSink } from './cdp.js';
import { CdpCapture } from './cdp.js';
import { withTimeout } from './exchange-read.js';
import {
  closeOnFailure,
  createFailure,
  LAUNCH_TIMEOUT_MS,
  RESTORE_TIMEOUT_MS,
  resolveLaunchBinary,
} from './launch.js';
import { TabContext } from './tab-context.js';

export interface AdapterHandles {
  config: WebTarget;
  context: BrowserContext;
  page: Page;
  browser: Browser | null;
  mode: 'managed' | 'attach';
  capture: CdpCapture;
  /** The run's tab registry — one naming scheme for the capture and the adapter. */
  tabs: TabContext;
  /**
   * `true` when attach found no tab to adopt and OPENED `page` itself — a tab in
   * a browser we do not own, so teardown closes it rather than leave it behind.
   * Always `false` for managed (the whole context is ours and closes anyway).
   */
  createdPage: boolean;
}

/** The slice of `chromium` this adapter actually calls — the test seam below overrides it. */
type ChromiumLauncher = Pick<typeof chromium, 'launchPersistentContext' | 'connectOverCDP'>;

export interface BrowserAdapterInit {
  /** Resolved web-target config (url, headless, debugLogin, cdpUrl, …). */
  config: WebTarget;
  /** Absolute persistent-profile dir for a managed launch; ignored when attaching. */
  profileDir: string;
  /** Optional sink for streaming captured console/network lines to `findings-store`. */
  onLog?: CaptureSink;
  /** Override the Playwright launcher/connector (test seam) — defaults to the real `chromium`. */
  chromium?: ChromiumLauncher;
  /**
   * The run's remaining wall-clock budget (ms) for getting Chrome up. Shortens the
   * launch/connect wait so it fits inside the caller's `timeout`; omit for the default.
   */
  timeoutMs?: number;
}

/**
 * Assemble the adapter's raw handles: attach over `cdpUrl` when set, else launch a
 * managed persistent context.
 */
export async function openBrowserHandles(init: BrowserAdapterInit): Promise<AdapterHandles> {
  const { cdpUrl } = init.config;
  const launcher = init.chromium ?? chromium;
  // ONE registry names every tab of this run: the capture stamps a row with the
  // label of the page it fired on, and the adapter's `tabs()` listing reports
  // the same label — so a `[tab-2]` marker in the durable log resolves to the
  // tab the driver drove.
  const tabs = new TabContext();
  // Nothing raw escapes: launch, connect and post-connect wiring all leave here as
  // AdapterError (header contract). Cleanup of a half-built adapter happens below.
  const wait = capWait(LAUNCH_TIMEOUT_MS, init.timeoutMs);
  try {
    return cdpUrl
      ? await attachHandles(init.config, launcher, wait, init.onLog, tabs)
      : await launchHandles(init.config, init.profileDir, launcher, wait, init.onLog, tabs);
  } catch (error) {
    throw createFailure(
      error,
      cdpUrl ? { mode: 'attach', cdpUrl } : { mode: 'managed', profileDir: init.profileDir },
    );
  }
}

async function launchHandles(
  config: WebTarget,
  profileDir: string,
  launcher: ChromiumLauncher,
  timeout: number,
  onLog: CaptureSink | undefined,
  tabs: TabContext,
): Promise<AdapterHandles> {
  // Still CDP: Playwright drives Chromium exclusively over the DevTools Protocol
  // (here a CDP pipe; `attachHandles` uses a CDP WebSocket). A persistent context is the
  // supported way to own a Chrome process WITH the per-project profile — both
  // managed and attach speak the same protocol, only the transport differs.
  const context = await launcher.launchPersistentContext(profileDir, {
    headless: config.headless,
    timeout,
    // Signals stay with `main.ts`, which owns the graceful shutdown. These default
    // to `true`, and Playwright's own SIGINT handler is
    // `gracefullyCloseAll().then(() => process.exit(130))` — it ran right after
    // ours started and killed the process mid-teardown, so the terminal findings
    // write, the summary and `replay.mp4` never landed and `state.json` was left
    // saying `running`. On SIGTERM it closed Chrome underneath a loop that was
    // still unwinding, and the last flush died as `Target closed`.
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    ...resolveLaunchBinary(config),
  });
  // Chrome is LIVE from here on and holds the profile lock — a throw past this point
  // must close it, or every later run of this project fails to launch.
  return closeOnFailure(context, async () => {
    const page = context.pages()[0] ?? (await context.newPage());
    const capture = startCapture(page, onLog, tabs);
    return {
      config,
      context,
      page,
      browser: null,
      mode: 'managed',
      capture,
      tabs,
      createdPage: false,
    };
  });
}

async function attachHandles(
  config: WebTarget,
  launcher: ChromiumLauncher,
  timeout: number,
  onLog: CaptureSink | undefined,
  tabs: TabContext,
): Promise<AdapterHandles> {
  if (!config.cdpUrl) {
    throw new AdapterError('attach mode requires `cdpUrl`');
  }
  const browser = await launcher.connectOverCDP(config.cdpUrl, { timeout });
  // Cleanup here drops the CONNECTION only — same disconnect semantics `close()`
  // relies on, so a failed attach never stops a browser we did not start.
  return closeOnFailure(browser, async () => {
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const adopted = context.pages()[0];
    const page = adopted ?? (await context.newPage());
    const capture = startCapture(page, onLog, tabs);
    const createdPage = adopted === undefined;
    return { config, context, page, browser, mode: 'attach', capture, tabs, createdPage };
  });
}

/** Wire console/network capture onto the live page before the first navigation. */
function startCapture(page: Page, onLog: CaptureSink | undefined, tabs: TabContext): CdpCapture {
  const capture = new CdpCapture({ page, sink: onLog, tabs });
  capture.start();
  return capture;
}

/**
 * What attach teardown owes the tab it drove: the ADOPTED tab goes back to the
 * URL it carried at attach; a tab attach OPENED itself (the browser had none to
 * adopt) is closed — "restoring" it to `about:blank` would leave a stray tab in
 * a browser that is not ours.
 */
export type TabHandBack = { page: Page; url: string } | { page: Page; close: true };

/**
 * Hand the attached tab back (see {@link TabHandBack}); `null` does nothing.
 *
 * A tab the run never moved already sits on the snapshot, so it is not reloaded
 * — navigating it again would only flash the owner's screen. Every failure is
 * swallowed on purpose: the browser was never ours, the run is already over,
 * and neither a wedged `goto` nor a tab the owner closed mid-run — reading a dead
 * handle's address throws — may fail the teardown or skip the disconnect that
 * follows (same best-effort posture as `closeOnFailure` in `launch.ts`).
 * `waitMs` (default `RESTORE_TIMEOUT_MS`) caps BOTH waits — teardown has no run
 * budget to shorten, and `page.close()` has no timeout of its own: a browser that
 * keeps the socket open but never answers would otherwise block the disconnect.
 */
export async function handBackTab(
  handBack: TabHandBack | null,
  waitMs: number = RESTORE_TIMEOUT_MS,
): Promise<void> {
  if (!handBack) return;
  try {
    if ('close' in handBack) {
      const closing = handBack.page.close();
      closing.catch(() => undefined); // abandoned past the cap: never unhandled
      await withTimeout(closing, waitMs);
      return;
    }
    if (handBack.page.url() === handBack.url) return;
    await handBack.page.goto(handBack.url, { timeout: waitMs });
  } catch {
    // Best-effort only — the caller's disconnect must still happen.
  }
}
