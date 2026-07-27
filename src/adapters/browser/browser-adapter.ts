/**
 * Browser adapter — drives a Chrome page over CDP via Playwright.
 *
 * Two lifecycles (see `idea/adapters.md`):
 *   - **managed** (default): launch a persistent context with the per-project
 *     profile; we OWN start/stop. `executablePath` picks the binary, else system
 *     Chrome (`channel`) — `playwright-core` ships no bundled browser.
 *   - **attach**: connect to an already-running browser over CDP (`cdpUrl`) and
 *     NEVER start/stop it — `close()` only disconnects.
 *
 * Implements the shared {@link Adapter} contract over the DOM/a11y: every element
 * normalizes to a {@link Node} (role/name/bounds/enabled) via one batched in-page
 * extraction. Console/network capture is wired by the CDP capture module (next).
 *
 * Fails loud — every Playwright call is wrapped to throw {@link AdapterError},
 * never a silent fallback.
 */

import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import { capWait } from '../budget.js';
import type {
  Adapter,
  Bounds,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScreenshotOptions,
  ScrollOptions,
  TabInfo,
  WaitOptions,
} from '../contract.js';
import { capToLimit } from '../limit.js';
import type { CaptureSink } from './cdp.js';
import { CdpCapture } from './cdp.js';
import { NODE_EXTRACTOR, type RawNode } from './extractor.js';
import { applyNodeFilters, centerWithin } from './filters.js';
import {
  frameOffset,
  isFrameGone,
  isOutsideViewport,
  placeInPage,
  scrollDelta,
  toNode,
  VIEWPORT_PROBE,
} from './geometry.js';
import {
  appendDebugLogin,
  closeOnFailure,
  createFailure,
  LAUNCH_TIMEOUT_MS,
  NAV_TIMEOUT_MS,
  resolveLaunchBinary,
  resolveTargetUrl,
  unreachableFailure,
} from './launch.js';
import { locateAcrossFrames, regionAcrossFrames, waitAcrossFrames } from './locate.js';
import { normalizeQuery } from './query.js';

// The adapter stays the one import surface its callers (and tests) know: the
// helpers it leans on live in `geometry.ts`/`launch.ts` only to keep every file
// under the 500-LOC cap.
export type { RawNode } from './extractor.js';
export { applyNodeFilters, NODE_FILTER_KEYS } from './filters.js';
export { isFrameGone, isOutsideViewport, scrollDelta } from './geometry.js';
export {
  appendDebugLogin,
  resolveLaunchBinary,
  resolveTargetUrl,
  unreachableFailure,
} from './launch.js';

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/** One wheel step (CSS px) when `scroll` is called without an explicit `amount` — page-ish. */
const DEFAULT_SCROLL_STEP = 600;

/** Interactive + semantic elements `readState` surfaces when no `query` is given. */
const DEFAULT_SELECTOR =
  'a[href], button, input, select, textarea, [role], [tabindex], [onclick], [contenteditable="true"], summary, label, h1, h2, h3, h4, h5, h6, [data-testid], p, img';

/**
 * Milliseconds left until `deadline`, floored at 1 so an exhausted budget still
 * hands Playwright a real timeout (0 means "no timeout" there) and fails fast.
 * No deadline → `undefined` (Playwright's default applies). `now` is injectable
 * for tests.
 */
export function remainingTimeout(deadline?: number, now: number = Date.now()): number | undefined {
  if (deadline === undefined) return undefined;
  return Math.max(1, deadline - now);
}

interface AdapterHandles {
  config: WebTarget;
  context: BrowserContext;
  page: Page;
  browser: Browser | null;
  mode: 'managed' | 'attach';
  capture: CdpCapture;
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
 * The web {@link Adapter}: a Playwright-driven Chrome page. Construct via
 * {@link BrowserAdapter.create} (async launch/connect can't live in a constructor).
 */
export class BrowserAdapter implements Adapter {
  readonly #config: WebTarget;
  readonly #context: BrowserContext;
  /** The tab currently driven — reassigned by {@link BrowserAdapter.selectTab}. */
  #page: Page;
  readonly #browser: Browser | null;
  readonly #mode: 'managed' | 'attach';
  readonly #capture: CdpCapture;

  private constructor(handles: AdapterHandles) {
    this.#config = handles.config;
    this.#context = handles.context;
    this.#page = handles.page;
    this.#browser = handles.browser;
    this.#mode = handles.mode;
    this.#capture = handles.capture;
  }

  /** Open the adapter: attach over `cdpUrl` when set, else launch a managed persistent context. */
  static async create(init: BrowserAdapterInit): Promise<BrowserAdapter> {
    const { cdpUrl } = init.config;
    const launcher = init.chromium ?? chromium;
    // Nothing raw escapes: launch, connect and post-connect wiring all leave here as
    // AdapterError (header contract). Cleanup of a half-built adapter happens below.
    const wait = capWait(LAUNCH_TIMEOUT_MS, init.timeoutMs);
    try {
      return cdpUrl
        ? await BrowserAdapter.#attach(init.config, launcher, wait, init.onLog)
        : await BrowserAdapter.#launch(init.config, init.profileDir, launcher, wait, init.onLog);
    } catch (error) {
      throw createFailure(
        error,
        cdpUrl ? { mode: 'attach', cdpUrl } : { mode: 'managed', profileDir: init.profileDir },
      );
    }
  }

  static async #launch(
    config: WebTarget,
    profileDir: string,
    launcher: ChromiumLauncher,
    timeout: number,
    onLog?: CaptureSink,
  ): Promise<BrowserAdapter> {
    // Still CDP: Playwright drives Chromium exclusively over the DevTools Protocol
    // (here a CDP pipe; `#attach` uses a CDP WebSocket). A persistent context is the
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
      const capture = BrowserAdapter.#startCapture(page, onLog);
      return new BrowserAdapter({ config, context, page, browser: null, mode: 'managed', capture });
    });
  }

  static async #attach(
    config: WebTarget,
    launcher: ChromiumLauncher,
    timeout: number,
    onLog?: CaptureSink,
  ): Promise<BrowserAdapter> {
    if (!config.cdpUrl) {
      throw new AdapterError('attach mode requires `cdpUrl`');
    }
    const browser = await launcher.connectOverCDP(config.cdpUrl, { timeout });
    // Cleanup here drops the CONNECTION only — same disconnect semantics `close()`
    // relies on, so a failed attach never stops a browser we did not start.
    return closeOnFailure(browser, async () => {
      const context = browser.contexts()[0] ?? (await browser.newContext());
      const page = context.pages()[0] ?? (await context.newPage());
      const capture = BrowserAdapter.#startCapture(page, onLog);
      return new BrowserAdapter({ config, context, page, browser, mode: 'attach', capture });
    });
  }

  /** Wire console/network capture onto the live page before the first navigation. */
  static #startCapture(page: Page, onLog?: CaptureSink): CdpCapture {
    const capture = new CdpCapture({ page, sink: onLog });
    capture.start();
    return capture;
  }

  async open(target: string, timeoutMs?: number): Promise<void> {
    // Resolution lives inside `#run` so URL failures surface as AdapterError too.
    await this.#run('open', async () => {
      const resolved = resolveTargetUrl(target, this.#config.url);
      const url = appendDebugLogin(resolved, this.#config.debugLogin);
      try {
        // The first navigation spends the run's budget, not a fresh 30s of its own.
        await this.#page.goto(url, { timeout: capWait(NAV_TIMEOUT_MS, timeoutMs) });
      } catch (error) {
        // A target that is not serving is not a UI bug — say so here, naming the
        // port, instead of letting the run report an empty page for 300 seconds.
        throw unreachableFailure(error, url) ?? error;
      }
    });
  }

  async find(opts: Query): Promise<Node | null> {
    return this.#run('find', async () => {
      const nodes = await this.#collect({ ...opts, limit: 1 });
      return nodes[0] ?? null;
    });
  }

  async click(target: NodeRef): Promise<void> {
    await this.#run('click', async () => {
      if (typeof target === 'string') {
        await (await locateAcrossFrames(this.#page, target)).click();
        return;
      }
      await this.#clickBoundsCenter(target);
    });
  }

  async type(target: NodeRef, text: string): Promise<void> {
    // Same semantics for both NodeRef forms: focus the target, then type into it
    // (the contract is "focuses it first"). Focus comes from a click rather than
    // `fill()` so typing APPENDS instead of replacing — but a click drops the caret
    // wherever it landed, i.e. mid-string on a pre-filled field, and the driver's
    // own read-back then shows spliced garbage it cannot explain. `End` parks the
    // caret after the existing value first.
    await this.#run('type', async () => {
      if (typeof target === 'string') {
        await (await locateAcrossFrames(this.#page, target)).click();
      } else {
        await this.#clickBoundsCenter(target);
      }
      await this.#page.keyboard.press('End');
      await this.#page.keyboard.type(text);
    });
  }

  /**
   * The page's visible area in CSS px.
   *
   * `viewportSize()` is null for EVERY attach target — `connectOverCDP` hard-codes
   * `noDefaultViewport: true` — and treating "unknown" as "inside" switched the
   * off-viewport guard off exactly where the window size is least predictable. The
   * page can always answer for itself, so ask it before giving up.
   */
  async #viewport(): Promise<{ width: number; height: number } | null> {
    return this.#page.viewportSize() ?? (await this.#page.evaluate(VIEWPORT_PROBE));
  }

  /**
   * Center of `bounds`, asserted on-screen. Bounds are viewport-relative, so CDP
   * mouse events at an off-screen center land on nothing — silently. Fail loud
   * instead so the agent knows to scroll it into view first.
   */
  async #centerInViewport(bounds: Bounds): Promise<{ x: number; y: number }> {
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    if (isOutsideViewport(center, await this.#viewport())) {
      throw new AdapterError(
        `element center (${Math.round(center.x)}, ${Math.round(center.y)}) is outside the viewport — scroll it into view first, then re-read its bounds`,
      );
    }
    return center;
  }

  /** Coordinate click at a {@link Node}'s bounds center, shared by `click` and `type`. */
  async #clickBoundsCenter(node: Node): Promise<void> {
    const center = await this.#centerInViewport(node.bounds);
    await this.#page.mouse.click(center.x, center.y);
  }

  async pressKey(key: string): Promise<void> {
    if (key.trim() === '') {
      throw new AdapterError('pressKey requires a non-empty key');
    }
    // Playwright's `press` parses chords from the `+`-joined string (`Control+A`):
    // it holds the modifiers while tapping the final key, and throws on an unknown
    // key — both surfaced loud via `#run` (CDP `Input.dispatchKeyEvent` underneath).
    await this.#run('pressKey', async () => {
      await this.#page.keyboard.press(key);
    });
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    const [dx, dy] = scrollDelta(opts.direction, opts.amount ?? DEFAULT_SCROLL_STEP);
    await this.#run('scroll', async () => {
      // Scope: park the cursor over the region first, so the wheel event targets the
      // scrollable element under it instead of the viewport. No scope → wheel where
      // the mouse already is (`Input.dispatchMouseEvent` of type `mouseWheel`).
      // Same viewport guard as the coordinate click: an off-screen region would
      // move the cursor nowhere and scroll the viewport instead — silently wrong.
      if (opts.within !== undefined) {
        const center = await this.#centerInViewport(
          await regionAcrossFrames(this.#page, opts.within),
        );
        await this.#page.mouse.move(center.x, center.y);
      }
      await this.#page.mouse.wheel(dx, dy);
    });
  }

  async readState(opts: Query = {}): Promise<Node[]> {
    return this.#run('readState', () => this.#collect(opts, DEFAULT_LIMIT));
  }

  async screenshot(opts?: ScreenshotOptions): Promise<Uint8Array> {
    return this.#run('screenshot', async () => {
      const buffer =
        opts?.format === 'jpeg'
          ? await this.#page.screenshot({ type: 'jpeg', quality: opts.quality ?? 92 })
          : await this.#page.screenshot({ type: 'png' });
      return new Uint8Array(buffer);
    });
  }

  async waitFor(opts: WaitOptions): Promise<void> {
    if (!opts.query && !opts.networkIdle) {
      throw new AdapterError('waitFor requires `query` and/or `networkIdle`');
    }
    // `timeout` caps the WHOLE wait, not each phase — with both `query` and
    // `networkIdle` set, the second wait only gets what's left of the budget.
    const deadline = opts.timeout === undefined ? undefined : Date.now() + opts.timeout;
    await this.#run('waitFor', async () => {
      if (opts.query) {
        await waitAcrossFrames(this.#page, opts.query, opts.timeout);
      }
      if (opts.networkIdle) {
        await this.#page.waitForLoadState('networkidle', { timeout: remainingTimeout(deadline) });
      }
    });
  }

  async console(opts?: LogQuery): Promise<ConsoleEntry[]> {
    return this.#capture.console(opts);
  }

  async network(opts?: LogQuery): Promise<NetworkEntry[]> {
    return this.#capture.network(opts);
  }

  async close(): Promise<void> {
    // Detach capture first so no events fire mid-teardown.
    this.#capture.stop();
    await this.#run('close', async () => {
      if (this.#mode === 'attach') {
        // Attach: disconnect only — never stop a browser we did not start.
        if (this.#browser) await this.#browser.close();
        return;
      }
      // Managed: close the persistent context we own (stops the browser).
      await this.#context.close();
    });
  }

  /**
   * Build, scope, filter, and cap the normalized node list shared by `find`/`readState`.
   *
   * Reads EVERY frame of the page, not just the main document: a page-level
   * locator stops at an iframe boundary, so anything embedded (payment fields,
   * editors, consent screens) was previously invisible — the agent saw an empty
   * region and had no way to learn why. Child-frame bounds are translated into
   * page coordinates, so a coordinate click needs no frame awareness at all.
   */
  async #collect(opts: Query, defaultLimit?: number): Promise<Node[]> {
    // Agent queries are role+name / plain text (what the tree shows), not raw CSS —
    // normalize them onto a Playwright engine; an absent query reads the default set.
    const selector = opts.query ? normalizeQuery(opts.query) : DEFAULT_SELECTOR;
    // A `within` scope is resolved ONCE, to a page-coordinate rect. Re-resolving a
    // string scope inside every frame (what `frame.locator(within)` did) matched
    // nothing in the child frames — so a scope living in the main document silently
    // dropped everything embedded under it, e.g. the Stripe field inside `#checkout`.
    const region =
      opts.within === undefined ? null : await regionAcrossFrames(this.#page, opts.within);

    let nodes: RawNode[] = [];
    for (const frame of this.#page.frames()) {
      const offset = await frameOffset(frame);
      if (offset === null) continue;
      let found: RawNode[];
      try {
        found = await frame.locator(selector).evaluateAll<RawNode[]>(NODE_EXTRACTOR);
      } catch (error) {
        // Only a vanished frame is skippable — a bad selector must fail loud.
        if (isFrameGone(error, frame.isDetached())) continue;
        throw error;
      }
      nodes.push(...found.map((node) => placeInPage(node, offset, frame)));
    }

    if (region) nodes = nodes.filter((n) => centerWithin(n, region));
    nodes = applyNodeFilters(nodes, opts.filters);

    return capToLimit(nodes, opts.limit ?? defaultLimit).map(toNode);
  }

  async tabs(): Promise<TabInfo[]> {
    return this.#run('tabs', async () => {
      const pages = this.#context.pages();
      return Promise.all(
        pages.map(async (page, index) => ({
          index,
          url: page.url(),
          // A tab opened a moment ago may not have a document yet.
          title: await page.title().catch(() => ''),
          active: page === this.#page,
        })),
      );
    });
  }

  async selectTab(index: number): Promise<void> {
    await this.#run('selectTab', async () => {
      const pages = this.#context.pages();
      const page = pages[index];
      if (!page) {
        throw new AdapterError(
          `no tab at index ${index} — ${pages.length} open (0…${Math.max(0, pages.length - 1)})`,
        );
      }
      this.#page = page;
      // Capture is page-scoped: without this the new tab records no console or
      // network activity at all, while the old one keeps recording unseen.
      this.#capture.rebind(page);
      await page.bringToFront();
    });
  }

  /** Run a Playwright call, re-throwing any failure as a loud {@link AdapterError}. */
  async #run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UiDebuggerError) throw error;
      throw new AdapterError(
        `browser.${op} failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
