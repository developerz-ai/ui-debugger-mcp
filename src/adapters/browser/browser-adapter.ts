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
import { AdapterError } from '../../errors.js';
import type {
  Adapter,
  Bounds,
  ConsoleEntry,
  Filters,
  FilterValue,
  LogQuery,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollDirection,
  ScrollOptions,
  WaitOptions,
} from '../contract.js';
import type { CaptureSink } from './cdp.js';
import { CdpCapture } from './cdp.js';
import { normalizeQuery } from './query.js';

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
  'a[href], button, input, select, textarea, [role], [tabindex], [onclick], [contenteditable="true"], summary, label, h1, h2, h3, h4, h5, h6';

/** Whitelisted `filters` keys for this adapter — anything else is rejected, not ignored. */
export const NODE_FILTER_KEYS = ['visible_eq', 'enabled_eq', 'role_in', 'name_contains'] as const;

/** A {@link Node} plus the computed `visible` flag backing the `visible_eq` filter. */
export interface RawNode extends Node {
  visible: boolean;
}

/**
 * Minimal in-page element shape. The DOM lib is off project-wide (Node/Bun only),
 * so we type the handful of members the extractor touches; annotations are erased
 * at runtime, so this never reaches the browser.
 */
interface DomEl {
  tagName: string;
  textContent: string | null;
  disabled?: boolean;
  labels?: ArrayLike<DomEl> | null;
  ownerDocument: { getElementById(id: string): DomEl | null };
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
}

/**
 * In-page `window.getComputedStyle`, typed locally (the DOM lib is off project-wide).
 * Resolves to the page global at runtime — the extractor below is serialized into
 * the page, so this stays a free identifier, never a module reference.
 */
declare function getComputedStyle(el: DomEl): { display: string; visibility: string };

/**
 * Browser-side element → {@link RawNode} extractor. Playwright serializes this and
 * runs it in the page, so it MUST stay self-contained: no module references, only
 * its params and nested locals. One batched call powers both `find` and
 * `readState`.
 */
const NODE_EXTRACTOR = (elements: DomEl[]): RawNode[] => {
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  const implicitRole = (el: DomEl): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
        return 'button';
      }
      return 'textbox';
    }
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (
      tag === 'h1' ||
      tag === 'h2' ||
      tag === 'h3' ||
      tag === 'h4' ||
      tag === 'h5' ||
      tag === 'h6'
    ) {
      return 'heading';
    }
    return tag;
  };

  const accessibleName = (el: DomEl): string => {
    const label = clean(el.getAttribute('aria-label'));
    if (label) return label;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = clean(
        labelledby
          .split(/\s+/)
          .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    if (el.labels && el.labels.length > 0) {
      const text = clean(
        Array.from(el.labels)
          .map((l) => l.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    const alt = clean(el.getAttribute('alt'));
    if (alt) return alt;
    const text = clean(el.textContent);
    if (text) return text;
    const value = clean(el.getAttribute('value'));
    if (value) return value;
    return clean(el.getAttribute('title'));
  };

  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      role: clean(el.getAttribute('role')) || implicitRole(el),
      name: accessibleName(el),
      bounds: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      enabled: el.disabled !== true && el.getAttribute('aria-disabled') !== 'true',
      visible:
        r.width > 0 &&
        r.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !el.hasAttribute('hidden') &&
        el.getAttribute('aria-hidden') !== 'true',
    };
  });
};

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

function expectBoolean(key: string, value: FilterValue): boolean {
  if (typeof value !== 'boolean') {
    throw new AdapterError(`filter \`${key}\` expects a boolean`);
  }
  return value;
}

function expectString(key: string, value: FilterValue): string {
  if (typeof value !== 'string') {
    throw new AdapterError(`filter \`${key}\` expects a string`);
  }
  return value;
}

function expectStringArray(key: string, value: FilterValue): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new AdapterError(`filter \`${key}\` expects a string[]`);
  }
  return value;
}

/**
 * Apply the whitelisted node `filters` in JS. Throws {@link AdapterError} on an
 * unknown key (no silent injection surface) or a wrong value type.
 */
export function applyNodeFilters(nodes: RawNode[], filters?: Filters): RawNode[] {
  if (!filters) return nodes;
  let out = nodes;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'visible_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.visible === want);
        break;
      }
      case 'enabled_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.enabled === want);
        break;
      }
      case 'role_in': {
        const roles = expectStringArray(key, value);
        out = out.filter((n) => roles.includes(n.role));
        break;
      }
      case 'name_contains': {
        const needle = expectString(key, value).toLowerCase();
        out = out.filter((n) => n.name.toLowerCase().includes(needle));
        break;
      }
      default:
        throw new AdapterError(
          `unknown filter \`${key}\` for browser adapter (allowed: ${NODE_FILTER_KEYS.join(', ')})`,
        );
    }
  }
  return out;
}

/** True when a node's center sits inside `region` — used to scope by a {@link Node} `within`. */
function centerWithin(node: RawNode, region: Bounds): boolean {
  const cx = node.bounds.x + node.bounds.width / 2;
  const cy = node.bounds.y + node.bounds.height / 2;
  return (
    cx >= region.x &&
    cx <= region.x + region.width &&
    cy >= region.y &&
    cy <= region.y + region.height
  );
}

/** Drop the internal `visible` flag — the public contract returns plain {@link Node}s. */
function toNode(node: RawNode): Node {
  return { role: node.role, name: node.name, bounds: node.bounds, enabled: node.enabled };
}

interface AdapterHandles {
  config: WebTarget;
  context: BrowserContext;
  page: Page;
  browser: Browser | null;
  mode: 'managed' | 'attach';
  capture: CdpCapture;
}

export interface BrowserAdapterInit {
  /** Resolved web-target config (url, headless, debugLogin, cdpUrl, …). */
  config: WebTarget;
  /** Absolute persistent-profile dir for a managed launch; ignored when attaching. */
  profileDir: string;
  /** Optional sink for streaming captured console/network lines to `findings-store`. */
  onLog?: CaptureSink;
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
    return init.config.cdpUrl
      ? BrowserAdapter.#attach(init.config, init.onLog)
      : BrowserAdapter.#launch(init.config, init.profileDir, init.onLog);
  }

  static async #launch(
    config: WebTarget,
    profileDir: string,
    onLog?: CaptureSink,
  ): Promise<BrowserAdapter> {
    // Still CDP: Playwright drives Chromium exclusively over the DevTools Protocol
    // (here a CDP pipe; `#attach` uses a CDP WebSocket). A persistent context is the
    // supported way to own a Chrome process WITH the per-project profile — both
    // managed and attach speak the same protocol, only the transport differs.
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: config.headless,
      ...resolveLaunchBinary(config),
    });
    const page = context.pages()[0] ?? (await context.newPage());
    const capture = BrowserAdapter.#startCapture(page, onLog);
    return new BrowserAdapter({ config, context, page, browser: null, mode: 'managed', capture });
  }

  static async #attach(config: WebTarget, onLog?: CaptureSink): Promise<BrowserAdapter> {
    if (!config.cdpUrl) {
      throw new AdapterError('attach mode requires `cdpUrl`');
    }
    const browser = await chromium.connectOverCDP(config.cdpUrl);
    const context = browser.contexts()[0] ?? (await browser.newContext());
    const page = context.pages()[0] ?? (await context.newPage());
    const capture = BrowserAdapter.#startCapture(page, onLog);
    return new BrowserAdapter({ config, context, page, browser, mode: 'attach', capture });
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
   * Coordinate click at a {@link Node}'s bounds center, shared by `click` and
   * `type`. Bounds are viewport-relative, so an off-screen center would make CDP
   * click nothing — fail loud instead so the agent knows to scroll first.
   */
  async #clickBoundsCenter(node: Node): Promise<void> {
    const { x, y, width, height } = node.bounds;
    const center = { x: x + width / 2, y: y + height / 2 };
    if (isOutsideViewport(center, this.#page.viewportSize())) {
      throw new AdapterError(
        `element center (${Math.round(center.x)}, ${Math.round(center.y)}) is outside the viewport — scroll it into view first, then re-read its bounds`,
      );
    }
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
      if (opts.within !== undefined) {
        const { x, y, width, height } = await this.#regionBox(opts.within);
        await this.#page.mouse.move(x + width / 2, y + height / 2);
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

    const limit = opts.limit ?? defaultLimit;
    if (limit !== undefined) nodes = nodes.slice(0, limit);
    return nodes.map(toNode);
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
      throw new AdapterError(
        `browser.${op} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
