/**
 * Browser-adapter lifecycle — how the adapter's handles come to be.
 *
 * Two lifecycles (see `idea/adapters.md`):
 *   - **managed** (default): launch a persistent context with the per-project
 *     profile; we OWN start/stop. `executablePath` picks the binary, else system
 *     Chrome (`channel`) — `playwright-core` ships no bundled browser.
 *   - **attach**: connect to an already-running browser over CDP (`cdpUrl`) and
 *     NEVER start/stop it — `close()` only disconnects.
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
import { closeOnFailure, createFailure, LAUNCH_TIMEOUT_MS, resolveLaunchBinary } from './launch.js';
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
    return { config, context, page, browser: null, mode: 'managed', capture, tabs };
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
    const page = context.pages()[0] ?? (await context.newPage());
    const capture = startCapture(page, onLog, tabs);
    return { config, context, page, browser, mode: 'attach', capture, tabs };
  });
}

/** Wire console/network capture onto the live page before the first navigation. */
function startCapture(page: Page, onLog: CaptureSink | undefined, tabs: TabContext): CdpCapture {
  const capture = new CdpCapture({ page, sink: onLog, tabs });
  capture.start();
  return capture;
}
