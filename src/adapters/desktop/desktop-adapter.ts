/**
 * Desktop adapter — drives a native Linux app behind the shared {@link Adapter}
 * contract, so the agent loop stays adapter-blind.
 *
 * Composition (split per SRP — see siblings):
 *   - read   → {@link AtspiSource} (AT-SPI2 a11y tree over D-Bus, `atspi.ts`)
 *   - input  → {@link PointerInput} (xdotool, X11/XWayland, `input.ts`)
 *   - capture→ {@link ScreenCapture} (scrot/grim per compositor, `capture.ts`)
 *
 * **Managed only**: the desktop target has no attach handle (unlike web `cdpUrl` /
 * android `adbSerial`), so `open` launches the configured command and `close` stops
 * it. Reads/clicks/type key off the AT-SPI tree — its screen extents give the
 * click coordinates. A custom-drawn surface (a canvas, a game, a custom widget)
 * exposes no a11y node, so it is simply absent from the tree: `find`, `click` and
 * `type` cannot reach it. There is no automatic vision/OCR fallback: this adapter
 * has no OCR/pixel path, so the adapter never switches to pixels — a read yields
 * tree nodes or nothing. Only the agent-level `look` can describe a frame.
 *
 * **Every read is scoped to one window.** The AT-SPI tree spans every application
 * on the desktop, so an unscoped lookup for "Save" can resolve to another app's
 * button and the click lands in the wrong window. The scope is the configured
 * `window` when the target has one, else the window the last `open` selected;
 * with neither, a read fails loud rather than reading the whole desktop.
 *
 * Desktop apps expose no console/network channels — those methods throw loud
 * ({@link AdapterError}), never a silent empty list. Every backend failure surfaces
 * as an {@link AdapterError}; our own loud errors pass through un-rewrapped.
 */

import type { DesktopTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import { capWait } from '../budget.js';
import type {
  Adapter,
  Bounds,
  ConsoleEntry,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollOptions,
  SelectorDialect,
  WaitOptions,
} from '../contract.js';
import {
  type AtspiScope,
  type AtspiSource,
  BusctlAtspi,
  parseRoleNameQuery,
  shapeNodes,
} from './atspi.js';
import { type ScreenCapture, Screenshot } from './capture.js';
import {
  centerOf,
  clickPointOf,
  expectOnScreen,
  type PointerInput,
  type WindowMatch,
  Xdotool,
} from './input.js';
import { ManagedApp, withWaylandHint } from './managed-app.js';
import { desktopEnv } from './proc.js';
import { abortError, pollUntilPresent } from './wait-poll.js';

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/**
 * Wall-clock cap on one `readState` walk. Every visited node costs ~4 busctl spawns, so a
 * big tree (Electron with accessibility on) can run for minutes. The contract has no
 * "truncated" marker on a node list, so a walk cut off by this cap fails loud rather than
 * hand the driver a tree that silently stops partway.
 */
const READ_WALK_MS = 30_000;

/** How many matches `find` inspects to prefer an exact name over a substring one. */
const FIND_CANDIDATES = 20;
/** Wall-clock cap on that ranking walk; on expiry `find` keeps its first (substring) hit. */
const FIND_RANK_MS = 3000;

/** `waitFor` defaults — poll the a11y tree for a query until it appears or times out. */
const DEFAULT_WAIT_MS = 5000;

/** How long `open` waits for the launched window to appear before failing loud. */
const WINDOW_WAIT_MS = 10_000;

/** Wheel-step calibration: pixels-per-click, and the default page-ish distance. */
const SCROLL_STEP_PX = 120;
const DEFAULT_SCROLL_AMOUNT = 360;

/** Map a pixel scroll `amount` onto a positive integer count of wheel clicks. */
export function scrollRepeat(amount?: number): number {
  return Math.max(1, Math.round((amount ?? DEFAULT_SCROLL_AMOUNT) / SCROLL_STEP_PX));
}

interface DesktopAdapterHandles {
  config: DesktopTarget;
  env: NodeJS.ProcessEnv;
  atspi: AtspiSource;
  input: PointerInput;
  capture: ScreenCapture;
  readWalkMs: number;
}

export interface DesktopAdapterInit {
  /** Resolved desktop-target config (launch command, window match, display). */
  config: DesktopTarget;
  /** Override the AT-SPI read backend (defaults to {@link BusctlAtspi}); a seam for tests. */
  atspi?: AtspiSource;
  /** Override the input backend (defaults to {@link Xdotool}); a seam for tests. */
  input?: PointerInput;
  /** Override the capture backend (defaults to {@link Screenshot}); a seam for tests. */
  capture?: ScreenCapture;
  /** Wall-clock cap of one `readState` walk (defaults to {@link READ_WALK_MS}); a seam for tests. */
  readWalkMs?: number;
}

/**
 * The desktop {@link Adapter}: an xdotool + AT-SPI2 + scrot/grim trio behind one
 * contract. Construct via {@link DesktopAdapter.create}.
 */
export class DesktopAdapter implements Adapter {
  /**
   * The native selector grammar — the AT-SPI parser this adapter's
   * `find`/`click`/`type` accept: `role "name"` or a bare name substring, and
   * nothing else. Declared here, not derived from the absence of `tabs`: the
   * dialect is the grammar, and the grammar is the adapter's own.
   */
  readonly selectorDialect: SelectorDialect = 'native';
  readonly #config: DesktopTarget;
  readonly #env: NodeJS.ProcessEnv;
  readonly #atspi: AtspiSource;
  readonly #input: PointerInput;
  readonly #capture: ScreenCapture;
  readonly #readWalkMs: number;
  readonly #app: ManagedApp;
  /**
   * The window identity the reads are scoped to — the app/window the AT-SPI
   * walk is restricted to.
   *
   * The a11y tree spans EVERY application on the desktop, so an unscoped read
   * returns whichever application happened to answer first: two apps with the
   * same "Save" label and the click lands in the wrong one.
   *
   * The scope is the CONFIGURED `window` whenever the target configures one:
   * that is the window xdotool activates, so it is the window the reads must
   * name — and a later `open` of another window does NOT re-scope them (the
   * configured window still wins the match, so the scope stays put). Only a
   * target with NO configured window takes its scope from the window `open`
   * last selected, and there a later `open` of another window DOES re-scope
   * the reads.
   */
  #scope: AtspiScope | null = null;

  private constructor(handles: DesktopAdapterHandles) {
    this.#config = handles.config;
    this.#env = handles.env;
    this.#atspi = handles.atspi;
    this.#input = handles.input;
    this.#capture = handles.capture;
    this.#readWalkMs = handles.readWalkMs;
    this.#app = new ManagedApp(handles.config.launch, handles.env);
  }

  /** Wire the adapter from config, binding each backend to the chosen X11 display. */
  static create(init: DesktopAdapterInit): DesktopAdapter {
    const display = init.config.display ?? undefined;
    return new DesktopAdapter({
      config: init.config,
      env: desktopEnv(display),
      atspi: init.atspi ?? new BusctlAtspi({ display }),
      input: init.input ?? new Xdotool({ display }),
      capture: init.capture ?? new Screenshot({ display }),
      readWalkMs: init.readWalkMs ?? READ_WALK_MS,
    });
  }

  /**
   * Launch the managed app (once) and activate the target window. `target` is a title
   * fallback for the configured `window` match.
   *
   * Never resolves having verified nothing: with no window to match it fails before
   * spawning, and a `launch` command that dies (bad binary → 127, crash → signal)
   * rejects with that exit code as soon as it happens — not after the window timeout.
   */
  async open(target: string, timeoutMs?: number): Promise<void> {
    await this.#run('open', async () => {
      const match = this.#windowMatch(target);
      if (!match) {
        throw new AdapterError(
          'desktop: no window to drive — set `window.title` or `window.class` on the desktop ' +
            'target, or pass a window title as the open target',
        );
      }
      await this.#app.reapLingering();
      const { died } = this.#app.launch();
      // The window wait fits inside the run's remaining cap when that is the shorter one.
      const waitMs = capWait(WINDOW_WAIT_MS, timeoutMs);
      // The wait gets an ABSOLUTE deadline, not just a duration: the xdotool calls it
      // makes are capped by the time left until then, so an in-flight search cannot
      // outlive the budget the run has left.
      const deadline = Date.now() + waitMs;
      const activated = this.#input.activateWindow(match, waitMs, deadline);
      // Pre-handle the loser: when the child dies first, the window wait keeps polling
      // (bounded by the cap above) and its later rejection must not go unhandled.
      activated.catch(() => {});
      await Promise.race([activated, died]).catch((error: unknown) => {
        throw this.#env.WAYLAND_DISPLAY ? withWaylandHint(error) : error;
      });
      // The window that is now up is the one every later read is scoped to — the
      // a11y tree holds every application on the desktop, so the scope is what
      // keeps a lookup inside this one.
      this.#scope = { title: match.title, class: match.class };
    });
  }

  async find(opts: Query): Promise<Node | null> {
    return this.#run('find', async () => {
      const first = (await this.readState({ ...opts, limit: 1 }))[0];
      if (!first || !opts.query) return first ?? null;
      const wanted = parseRoleNameQuery(opts.query).name;
      if (wanted === undefined || first.name === wanted) return first;
      // The first hit is only a substring match ("Save As" for "Save"): look at a bounded
      // set of further matches and prefer an exact name, then a case-insensitive one.
      // The ranking is a refinement, not the lookup: it gets its own short cap, and when
      // that expires the substring hit already in hand is the answer (a deliberate
      // fallback — failing here would break every selector act on a large tree).
      const rankMs = Math.min(FIND_RANK_MS, this.#readWalkMs);
      const rankDeadline = Date.now() + rankMs;
      let candidates: Node[];
      try {
        candidates = await this.#readNodes({ ...opts, limit: FIND_CANDIDATES }, rankMs);
      } catch (error) {
        if (error instanceof AdapterError && Date.now() >= rankDeadline) return first;
        throw error;
      }
      return (
        candidates.find((n) => n.name === wanted) ??
        candidates.find((n) => n.name.toLowerCase() === wanted.toLowerCase()) ??
        first
      );
    });
  }

  async readState(opts: Query = {}): Promise<Node[]> {
    return this.#run('readState', () => this.#readNodes(opts, this.#readWalkMs));
  }

  /** One AT-SPI read shaped onto contract nodes, its walk capped at `walkMs` (loud on a partial tree). */
  async #readNodes(opts: Query, walkMs: number): Promise<Node[]> {
    const scope = this.#readScope();
    const region = opts.within !== undefined ? await this.#regionBounds(opts.within) : undefined;
    // A bounded query (role/name) + maxNodes let the AT-SPI walk skip describing
    // (and stop once it has found) more than the caller could ever use — `find`
    // (and thus `waitFor`'s poll loop) asks for `limit: 1`, so a match on the first
    // matching node ends the walk instead of describing the whole tree. Region
    // scoping (`within`) and `filters` are applied downstream in `shapeNodes`, not
    // visible to the walk itself, so an early match-count stop could wrongly skip a
    // same-query match that would have survived them (the first `Save` found is
    // disabled, the enabled one sits deeper) — only tighten `maxNodes` when there is
    // no post-walk narrowing to reconcile against.
    const query = opts.query ? parseRoleNameQuery(opts.query) : undefined;
    // `visible_eq: true` is pushed into the walk (it then counts only showing nodes
    // toward `maxNodes`, keeping the early stop); any other filter still narrows after.
    const { visible_eq: visibleEq, ...otherFilters } = opts.filters ?? {};
    const visibleOnly = visibleEq === true;
    const narrowed =
      region !== undefined ||
      Object.keys(otherFilters).length > 0 ||
      (visibleEq !== undefined && !visibleOnly);
    const maxNodes = narrowed ? DEFAULT_LIMIT : (opts.limit ?? DEFAULT_LIMIT);
    const deadline = Date.now() + walkMs;
    const nodes = await this.#atspi.readTree({ query, maxNodes, scope, visibleOnly, deadline });
    // A walk that stopped on the clock (not on `maxNodes`) returned a partial tree.
    if (Date.now() >= deadline && nodes.length < maxNodes) {
      throw new AdapterError(
        `desktop: readState walk hit its ${walkMs}ms cap after ${nodes.length} nodes — ` +
          'the tree is too large to read whole; narrow it with `query`, `filters` or `within`',
      );
    }
    return shapeNodes(nodes, opts, DEFAULT_LIMIT, region);
  }

  async click(target: NodeRef): Promise<void> {
    await this.#run('click', async () => {
      const { x, y } = clickPointOf(await this.#resolve(target));
      await this.#input.clickPoint(x, y);
    });
  }

  async type(target: NodeRef, text: string): Promise<void> {
    // Contract: focus the target first, then type. Click its center to focus.
    await this.#run('type', async () => {
      const { x, y } = clickPointOf(await this.#resolve(target));
      await this.#input.clickPoint(x, y);
      await this.#input.typeText(text);
    });
  }

  async pressKey(key: string): Promise<void> {
    if (key.trim() === '') {
      throw new AdapterError('pressKey requires a non-empty key');
    }
    await this.#run('pressKey', () => this.#input.key(key));
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    await this.#run('scroll', async () => {
      // Scope: park the cursor over the region first so the wheel targets it.
      // Unscoped, the wheel goes wherever the pointer last was — possibly another app.
      // Park it over the target window (or the `within` region) first.
      const anchor =
        opts.within !== undefined
          ? await this.#regionBounds(opts.within)
          : await this.#rootBounds();
      if (anchor) {
        const { x, y } = centerOf(anchor);
        await this.#input.move(x, y);
      }
      await this.#input.scroll(opts.direction, scrollRepeat(opts.amount));
    });
  }

  async screenshot(): Promise<Uint8Array> {
    return this.#run('screenshot', () => this.#capture.capture());
  }

  async waitFor(opts: WaitOptions): Promise<void> {
    if (opts.networkIdle) {
      throw new AdapterError('desktop: `networkIdle` wait is unsupported (no network channel)');
    }
    const query = opts.query;
    if (!query) {
      throw new AdapterError('waitFor requires `query` (desktop has no networkIdle)');
    }
    const timeout = opts.timeout ?? DEFAULT_WAIT_MS;
    // NaN would make `Date.now() >= deadline` false forever — an unbounded poll.
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new AdapterError(
        `desktop: waitFor \`timeout\` must be a non-negative, finite number of ms (got ${timeout})`,
      );
    }
    const signal = opts.signal;
    if (signal?.aborted) throw abortError();
    await this.#run('waitFor', async () => {
      const deadline = Date.now() + timeout;
      // One abort latch for the whole wait: it cuts short both an in-flight walk and
      // the poll nap, and its listener is removed on every exit path below.
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        if (!signal) return;
        onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      aborted.catch(() => {});
      try {
        await pollUntilPresent({
          present: () => this.#present(query, deadline),
          label: `waitFor timed out after ${timeout}ms (${query})`,
          deadline,
          aborted,
        });
      } finally {
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      }
    });
  }

  /**
   * One deadline-bounded poll for `query`. The wait's deadline goes **into** the walk:
   * every visited node costs a couple of busctl spawns, so on a big tree (Electron with
   * accessibility on) a single poll can run for minutes and `waitFor` — which only
   * checks the clock between polls — would overshoot its timeout by a whole walk.
   */
  async #present(query: string, deadline: number): Promise<boolean> {
    const scope = this.#readScope();
    const nodes = await this.#atspi.readTree({
      query: parseRoleNameQuery(query),
      maxNodes: 1,
      deadline,
      scope,
      // "exists/becomes visible": a hidden twin (another tab's "Save") is not the thing awaited.
      visibleOnly: true,
    });
    return shapeNodes(nodes, { query, limit: 1 }, DEFAULT_LIMIT).length > 0;
  }

  /** Desktop apps expose no console channel — unsupported, surfaced loud. */
  async console(): Promise<ConsoleEntry[]> {
    throw new AdapterError('desktop target has no console channel (unsupported)');
  }

  /** Desktop apps expose no network channel — unsupported, surfaced loud. */
  async network(): Promise<NetworkEntry[]> {
    throw new AdapterError('desktop target has no network channel (unsupported)');
  }

  /**
   * Managed teardown: SIGTERM the launched process group, then SIGKILL it if it is still
   * alive after the grace period; an already-dead process is a no-op.
   *
   * The handle is dropped only once the group is confirmed gone — an app that traps
   * SIGTERM (prompting "save changes?") would otherwise survive `close`, with nothing
   * left to kill it and its X/profile locks held until the user does it by hand.
   */
  async close(): Promise<void> {
    await this.#run('close', () => this.#app.stop());
  }

  /** Resolve a {@link NodeRef} to a concrete {@link Node}, re-querying a selector. */
  async #resolve(target: NodeRef): Promise<Node> {
    if (typeof target !== 'string') return target;
    // Visible only: a click on a hidden match lands on stale extents — whatever is there.
    const node = await this.find({ query: target, filters: { visible_eq: true } });
    if (!node) {
      throw new AdapterError(`desktop: no visible element matched query ${JSON.stringify(target)}`);
    }
    return node;
  }

  /**
   * The scope every read must carry — the window the target is bound to.
   *
   * The scope in force is the configured `window` when the target has one (a
   * later `open` of another window does not change it — the configured window
   * still wins the match), else the window the last `open` selected. With
   * neither there is no window to read: an unscoped read walks EVERY
   * application on the desktop, so a lookup for "Save" can resolve to another
   * app's button and the click lands in the wrong window. That is the bug this
   * scope exists to prevent, so the read fails loud instead of silently
   * reading the whole desktop.
   */
  #readScope(): AtspiScope {
    const scope = this.#scope ?? this.#config.window;
    if (!scope || (!scope.title && !scope.class)) {
      throw new AdapterError(
        'desktop: no window selected — set `window.title` or `window.class` on the desktop ' +
          'target, or open a window first; an unscoped read would match any application on ' +
          'the desktop',
      );
    }
    return scope;
  }

  /** On-screen bounds of the scoped window itself, or null when AT-SPI cannot measure it. */
  async #rootBounds(): Promise<Bounds | null> {
    const [root] = await this.#atspi.readTree({ maxNodes: 1, scope: this.#readScope() });
    return root?.measured && root.bounds.width > 0 && root.bounds.height > 0 ? root.bounds : null;
  }

  /** Resolve a scope `within` (a {@link Node} or a selector) to an on-screen rectangle.
   *
   * A zero-size region is rejected, not scoped to: it would park the scroll cursor at
   * the screen origin and (via `centerWithin`) read as a region nothing sits in.
   */
  async #regionBounds(within: NodeRef): Promise<Bounds> {
    if (typeof within !== 'string') return expectOnScreen(within);
    const node = await this.find({ query: within });
    if (!node) throw new AdapterError(`desktop: \`within\` target not found: ${within}`);
    return expectOnScreen(node);
  }

  /** Pick the window to drive: configured match wins, else a non-empty `open` title fallback. */
  #windowMatch(target: string): WindowMatch | null {
    const configured = this.#config.window;
    if (configured && (configured.title || configured.class)) return configured;
    if (target.trim() !== '') return { title: target };
    return null;
  }

  /** Run a backend call, re-throwing as a loud {@link AdapterError} (our own errors pass through). */
  async #run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      // Aborts keep their `AbortError` name — the caller recognises them by it.
      if (
        error instanceof UiDebuggerError ||
        (error instanceof Error && error.name === 'AbortError')
      ) {
        throw error;
      }
      throw new AdapterError(
        `desktop.${op} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
