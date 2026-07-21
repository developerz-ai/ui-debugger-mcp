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

import { existsSync } from 'node:fs';
import { URL } from 'node:url';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import type {
  Adapter,
  Bounds,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollDirection,
  ScrollOptions,
  WaitOptions,
} from '../contract.js';
import { capToLimit } from '../limit.js';
import type { CaptureSink } from './cdp.js';
import { CdpCapture } from './cdp.js';
import { NODE_EXTRACTOR, type RawNode } from './extractor.js';
import { applyNodeFilters, centerWithin } from './filters.js';
import { closeOnFailure, createFailure } from './launch.js';
import { normalizeQuery } from './query.js';

export type { RawNode } from './extractor.js';
export { applyNodeFilters, NODE_FILTER_KEYS } from './filters.js';

/** System Chrome channel used as the last resort when no binary can be resolved. */
const DEFAULT_CHANNEL = 'chrome';

/** Detect the Playwright-managed Chromium binary; null if it isn't installed. */
function detectManagedChromium(): string | null {
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null; // Playwright browser not installed
  }
}

/**
 * Pick the Chromium binary for a managed launch. Order:
 *   1. explicit `executablePath` from config
 *   2. the Playwright-managed Chromium, if it's installed (`npx playwright install chromium`)
 *   3. fall back to the system Google Chrome channel
 * Without (2) the adapter failed on hosts that have the managed Chromium but no
 * system Chrome — the common dev setup. `detect` is injected so the ordering is
 * unit-testable without a real browser install.
 */
export function resolveLaunchBinary(
  config: WebTarget,
  detect: () => string | null = detectManagedChromium,
): { executablePath: string } | { channel: string } {
  if (config.executablePath) return { executablePath: config.executablePath };
  const managed = detect();
  if (managed) return { executablePath: managed };
  return { channel: DEFAULT_CHANNEL };
}

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/** One wheel step (CSS px) when `scroll` is called without an explicit `amount` — page-ish. */
const DEFAULT_SCROLL_STEP = 600;

/** Interactive + semantic elements `readState` surfaces when no `query` is given. */
const DEFAULT_SELECTOR =
  'a[href], button, input, select, textarea, [role], [tabindex], [onclick], [contenteditable="true"], summary, label, h1, h2, h3, h4, h5, h6, [data-testid], p, img';

/**
 * Resolve a navigate target against the configured base URL. Drivers often pass
 * a relative path (`/`, `/login`) — `page.goto` rejects those as "invalid URL",
 * so anchor them to `base`. Absolute targets pass through unchanged.
 */
export function resolveTargetUrl(target: string, base?: string): string {
  try {
    return new URL(target, base).toString();
  } catch {
    return target; // relative target with no usable base — let `goto` surface a clear error
  }
}

/**
 * Append the login-bypass query param (`?<param>=true`) when `debugLogin` is configured.
 * A relative `target` (no config `url` base to anchor it) can't carry a query param —
 * fail loud with an {@link AdapterError} instead of leaking a raw `TypeError: Invalid URL`.
 */
export function appendDebugLogin(target: string, debugLogin?: { param: string }): string {
  if (!debugLogin) return target;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new AdapterError(
      `cannot append debug-login param to relative target ${JSON.stringify(target)} — set the web target's \`url\` in .ui-debugger-mcp.json so it resolves to an absolute URL`,
    );
  }
  url.searchParams.set(debugLogin.param, 'true');
  return url.toString();
}

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

/**
 * True when `point` falls outside a non-null `viewport`. Coordinate clicks use
 * viewport-relative bounds (`getBoundingClientRect`), so an off-screen center
 * dispatches a CDP click that lands on nothing — silently. Null viewport
 * (e.g. some attach targets) → never outside; we can't judge.
 */
export function isOutsideViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number } | null,
): boolean {
  if (!viewport) return false;
  return point.x < 0 || point.x > viewport.width || point.y < 0 || point.y > viewport.height;
}

/**
 * Map a {@link ScrollDirection} + pixel `amount` onto Playwright wheel deltas
 * `[deltaX, deltaY]` (the viewport scrolls toward that edge). Fails loud on an
 * unrecognized direction — the switch is exhaustive over the union, so a bad
 * value can only arrive from an unchecked boundary.
 */
export function scrollDelta(direction: ScrollDirection, amount: number): [number, number] {
  switch (direction) {
    case 'up':
      return [0, -amount];
    case 'down':
      return [0, amount];
    case 'left':
      return [-amount, 0];
    case 'right':
      return [amount, 0];
    default: {
      const unreachable: never = direction;
      throw new AdapterError(`unknown scroll direction: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Drop the internal `visible` flag — the public contract returns plain {@link Node}s. */
function toNode(node: RawNode): Node {
  const out: Node = {
    role: node.role,
    name: node.name,
    bounds: node.bounds,
    enabled: node.enabled,
  };
  if (node.testid) out.testid = node.testid;
  if (node.style) out.style = node.style;
  return out;
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
}

/**
 * The web {@link Adapter}: a Playwright-driven Chrome page. Construct via
 * {@link BrowserAdapter.create} (async launch/connect can't live in a constructor).
 */
export class BrowserAdapter implements Adapter {
  readonly #config: WebTarget;
  readonly #context: BrowserContext;
  readonly #page: Page;
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
    try {
      return cdpUrl
        ? await BrowserAdapter.#attach(init.config, launcher, init.onLog)
        : await BrowserAdapter.#launch(init.config, init.profileDir, launcher, init.onLog);
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
    onLog?: CaptureSink,
  ): Promise<BrowserAdapter> {
    // Still CDP: Playwright drives Chromium exclusively over the DevTools Protocol
    // (here a CDP pipe; `#attach` uses a CDP WebSocket). A persistent context is the
    // supported way to own a Chrome process WITH the per-project profile — both
    // managed and attach speak the same protocol, only the transport differs.
    const context = await launcher.launchPersistentContext(profileDir, {
      headless: config.headless,
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
    onLog?: CaptureSink,
  ): Promise<BrowserAdapter> {
    if (!config.cdpUrl) {
      throw new AdapterError('attach mode requires `cdpUrl`');
    }
    const browser = await launcher.connectOverCDP(config.cdpUrl);
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

  async open(target: string): Promise<void> {
    // Resolution lives inside `#run` so URL failures surface as AdapterError too.
    await this.#run('open', async () => {
      const resolved = resolveTargetUrl(target, this.#config.url);
      const url = appendDebugLogin(resolved, this.#config.debugLogin);
      await this.#page.goto(url);
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
        await this.#page.locator(normalizeQuery(target)).first().click();
        return;
      }
      await this.#clickBoundsCenter(target);
    });
  }

  async type(target: NodeRef, text: string): Promise<void> {
    // Same semantics for both NodeRef forms: focus the target, then type into it
    // (the contract is "focuses it first"). A selector focuses via click rather
    // than `fill()` so it appends like the coordinate path instead of replacing.
    await this.#run('type', async () => {
      if (typeof target === 'string') {
        await this.#page.locator(normalizeQuery(target)).first().click();
      } else {
        await this.#clickBoundsCenter(target);
      }
      await this.#page.keyboard.type(text);
    });
  }

  /**
   * Center of `bounds`, asserted on-screen. Bounds are viewport-relative, so CDP
   * mouse events at an off-screen center land on nothing — silently. Fail loud
   * instead so the agent knows to scroll it into view first.
   */
  #centerInViewport(bounds: Bounds): { x: number; y: number } {
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    if (isOutsideViewport(center, this.#page.viewportSize())) {
      throw new AdapterError(
        `element center (${Math.round(center.x)}, ${Math.round(center.y)}) is outside the viewport — scroll it into view first, then re-read its bounds`,
      );
    }
    return center;
  }

  /** Coordinate click at a {@link Node}'s bounds center, shared by `click` and `type`. */
  async #clickBoundsCenter(node: Node): Promise<void> {
    const center = this.#centerInViewport(node.bounds);
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
        const center = this.#centerInViewport(await this.#regionBox(opts.within));
        await this.#page.mouse.move(center.x, center.y);
      }
      await this.#page.mouse.wheel(dx, dy);
    });
  }

  async readState(opts: Query = {}): Promise<Node[]> {
    return this.#run('readState', () => this.#collect(opts, DEFAULT_LIMIT));
  }

  async screenshot(): Promise<Uint8Array> {
    return this.#run('screenshot', async () => {
      const buffer = await this.#page.screenshot({ type: 'png' });
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
        await this.#page
          .locator(normalizeQuery(opts.query))
          .first()
          .waitFor({ state: 'visible', timeout: opts.timeout });
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

  /** Build, scope, filter, and cap the normalized node list shared by `find`/`readState`. */
  async #collect(opts: Query, defaultLimit?: number): Promise<Node[]> {
    // Agent queries are role+name / plain text (what the tree shows), not raw CSS —
    // normalize them onto a Playwright engine; an absent query reads the default set.
    const selector = opts.query ? normalizeQuery(opts.query) : DEFAULT_SELECTOR;
    const scope =
      typeof opts.within === 'string'
        ? this.#page.locator(normalizeQuery(opts.within))
        : this.#page;
    let nodes = await scope.locator(selector).evaluateAll<RawNode[]>(NODE_EXTRACTOR);

    if (opts.within && typeof opts.within !== 'string') {
      const region = opts.within.bounds;
      nodes = nodes.filter((n) => centerWithin(n, region));
    }
    nodes = applyNodeFilters(nodes, opts.filters);

    return capToLimit(nodes, opts.limit ?? defaultLimit).map(toNode);
  }

  /** Resolve a scroll `within` scope to an on-screen rectangle (Node bounds, or a located selector). */
  async #regionBox(within: NodeRef): Promise<Bounds> {
    if (typeof within !== 'string') return within.bounds;
    const box = await this.#page.locator(normalizeQuery(within)).first().boundingBox();
    if (!box) {
      throw new AdapterError(`scroll \`within\` target not found or not visible: ${within}`);
    }
    return box;
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
