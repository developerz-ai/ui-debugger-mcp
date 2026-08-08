/**
 * The shared adapter contract — the one real seam in the system.
 *
 * Every adapter (browser/CDP, desktop/X11-Wayland, android/ADB) implements this
 * same small interface, so the debug agent's loop is **adapter-blind**: the
 * inner tool belt (`observe`/`act`/`look`) hits these methods and never learns
 * which protocol is underneath. Web reads the DOM, desktop the a11y tree, mobile
 * the view hierarchy — but all three normalize to the {@link Node} shape below,
 * falling back to vision (screenshot + coordinates) when no tree exists.
 *
 * Reads are **SQL-like**, not RPC: a handful of verbs with composable params
 * (`query`/`fields`/`filters`/`limit`/`within`) — see {@link Query}. The belt's
 * `observe({ kind })` selects the table (`tree`/`screenshot`/`console`/`network`)
 * and routes to the matching method here.
 *
 * Implementations MUST fail loud — throw an {@link AdapterError} (or a more
 * specific custom error), never swallow or return a silent fallback.
 *
 * See `idea/adapters.md` and `idea/mcp-tools.md`.
 */

/** On-screen rectangle in CSS/device pixels, origin top-left. Powers clicks + vision. */
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A single UI element, normalized across targets (DOM node / a11y node /
 * view-hierarchy node). Adapters map their native shape onto these four fields.
 */
export interface Node {
  /** Semantic role — `'button' | 'link' | 'textbox' | …` (ARIA/a11y, target-agnostic). */
  role: string;
  /** Accessible name — the visible label or text content. */
  name: string;
  /** On-screen rectangle; needed to click and to point the vision guy at it. */
  bounds: Bounds;
  /** Interactable — `false` when disabled/readonly. */
  enabled: boolean;
  /** Stable test hook (`data-testid` on web); absent when the element carries none. */
  testid?: string;
  /**
   * Live contents of a form control (`input`/`textarea`/`select`), absent elsewhere.
   *
   * Distinct from {@link name}, which stays the LABEL so the node remains
   * targetable. Without this the tree cannot answer "what is in this field?" —
   * the accessible name resolves to the label or placeholder, and the `value`
   * attribute never changes as the user types — so a driver verifying its own
   * input had to spend a vision call on it, every time.
   */
  value?: string;
  /** Live checked state of a checkbox/radio, absent elsewhere. Same rationale as {@link value}. */
  checked?: boolean;
  /**
   * The iframe this node lives in (its URL), absent for the main document.
   *
   * Embedded widgets — payment fields, editors, OAuth consent — are a separate
   * document that page-level selectors cannot reach. {@link Bounds} are still
   * page-absolute (the adapter offsets them by the frame's position), so a
   * coordinate click works the same either way; this field is what tells the
   * agent why a selector that "should" match doesn't.
   */
  frame?: string;
  /**
   * Computed text style (web, text-bearing nodes only) — lets the blind driver
   * catch invisible/low-contrast text structurally, without spending vision.
   */
  style?: NodeStyle;
}

/** Computed colour info for a text-bearing {@link Node} (web adapter). */
export interface NodeStyle {
  /** Computed CSS text colour, e.g. `rgb(255, 255, 255)`. */
  color: string;
  /** Effective background behind the element (nearest opaque ancestor). */
  backgroundColor: string;
  /** WCAG contrast ratio text-vs-background (1–21). < 4.5 hard to read; < 1.5 ≈ invisible. */
  contrast?: number;
}

/** Selectable {@link Node} columns for the `fields` projection (a `SELECT` whitelist). */
export type NodeField = keyof Node;

/**
 * How to point an action at an element: either a raw `query` selector the
 * adapter re-resolves (CSS/role/text · a11y role+name · resource-id/text), or a
 * {@link Node} already returned by {@link Adapter.find}/{@link Adapter.readState}.
 */
export type NodeRef = string | Node;

/** A single `filters` predicate value. Arrays back `_in`-style set membership. */
export type FilterValue = string | number | boolean | string[];

/**
 * Structured `WHERE field_op` predicates, keyed `<field>_<op>` — e.g.
 * `{ visible_eq: true, role_in: ['button', 'link'], status_gte: 400 }`. The set
 * of allowed keys is **whitelisted per adapter** (never an open injection
 * surface); unknown keys are rejected by the adapter, not silently ignored.
 */
export type Filters = Record<string, FilterValue>;

/**
 * SQL-like read parameters — push composition into params, like a `SELECT`.
 * All optional; an empty `Query` reads the whole (capped) tree.
 */
export interface Query {
  /** `WHERE` / selector — target node(s): CSS/role/text (web), a11y role+name (desktop), resource-id/text (android). */
  query?: string;
  /** `WHERE field_op` — structured predicates; see {@link Filters}. Whitelisted per adapter. */
  filters?: Filters;
  /** `LIMIT` — cap how many nodes come back, to keep the tree small. */
  limit?: number;
  /** Scope — restrict the search to a subtree/region (a selector or {@link Node}). */
  within?: NodeRef;
}

/** Read parameters for the append-only log channels (`console`/`network`). */
export interface LogQuery {
  /** `WHERE field_op` — e.g. `{ level_eq: 'error' }` (console) or `{ status_gte: 400 }` (network). */
  filters?: Filters;
  /** `LIMIT` — cap how many entries come back (most recent first). */
  limit?: number;
}

/** Encoding for {@link Adapter.screenshot}. `jpeg` is for photo-heavy frames only — see the method doc. */
export interface ScreenshotOptions {
  /** Wire format. Defaults to `png`. */
  format?: 'png' | 'jpeg';
  /** JPEG quality 1-100; ignored for `png`. High by default — UI text must stay readable. */
  quality?: number;
}

/** What {@link Adapter.waitFor} should block on; combine fields (all that are set must hold). */
export interface WaitOptions {
  /** Wait until a node matching this selector exists/becomes visible. */
  query?: string;
  /** Wait until in-flight requests settle (web: network idle). */
  networkIdle?: boolean;
  /** Hard cap in ms; on expiry the adapter throws (never resolves silently). */
  timeout?: number;
}

/** Cardinal direction for {@link Adapter.scroll}; each adapter maps it to wheel/gesture deltas. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** How {@link Adapter.scroll} moves content — a {@link ScrollDirection} plus optional distance and scope. */
export interface ScrollOptions {
  /** Which way to move the content (the viewport scrolls toward this edge). */
  direction: ScrollDirection;
  /** Distance in CSS/device pixels; omit for one adapter-default page-ish step. */
  amount?: number;
  /** Scope — scroll inside this subtree/region instead of the viewport (a selector or {@link Node}). */
  within?: NodeRef;
}

/** One console message captured from the target (CDP `console` + uncaught errors). */
export interface ConsoleEntry {
  /** Normalized severity (`'warning'` collapses to `'warn'`). */
  level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  /** The logged text (args joined). */
  text: string;
  /** Source location `url:line:col`, when known. */
  location?: string;
  /** Capture time, ms since epoch. */
  timestamp: number;
}

/** One network exchange captured from the target (CDP responses + failures). */
export interface NetworkEntry {
  /** HTTP method — `GET` | `POST` | … */
  method: string;
  /** Request URL. */
  url: string;
  /** HTTP status code; `0` when the request failed/aborted before a response. */
  status: number;
  /** `true` for a settled `2xx`/`3xx`; `false` for `4xx`/`5xx` or a failure. */
  ok: boolean;
  /** Resource kind — `'fetch' | 'xhr' | 'document' | 'image' | …` — for filtering. */
  resourceType?: string;
  /** Failure reason when the request errored/aborted (CDP `requestfailed`). */
  error?: string;
  /** Capture time, ms since epoch. */
  timestamp: number;
  /**
   * Wall-clock ms from the request leaving the page to its response arriving.
   * Absent when the request never produced a response, or when it was already
   * in flight before capture started.
   */
  durationMs?: number;
  /**
   * Request payload as sent (`POST`/`PUT`/`PATCH` bodies), truncated to a cap.
   * Captured for API traffic only ({@link BODY_RESOURCE_TYPES}) — a debugger needs
   * to see *what was submitted*, not the bytes of every script and image.
   */
  requestBody?: string;
  /**
   * Response payload, truncated to a cap. Captured for API traffic only. This is
   * where a `4xx` keeps its actual reason (the validation error, the message), so
   * it is the single most valuable field on a failing exchange.
   */
  responseBody?: string;
  /** Request headers, sensitive values redacted ({@link NetworkEntry.responseHeaders}). */
  requestHeaders?: Record<string, string>;
  /**
   * Response headers, sensitive values redacted — credential-bearing headers
   * (`authorization`, `cookie`, `set-cookie`, …) keep only a length marker, so the
   * agent can tell a header was *present* without the secret entering its context
   * (and from there, logs, findings, and the caller's transcript).
   */
  responseHeaders?: Record<string, string>;
}

/** One open tab/window of a multi-tab target (web). */
export interface TabInfo {
  /** Position in the target's tab list — what {@link Adapter.selectTab} takes. */
  index: number;
  /** Current URL of the tab. */
  url: string;
  /** Document title, empty while a fresh tab is still loading. */
  title: string;
  /** Whether this is the tab the adapter currently drives. */
  active: boolean;
}

/**
 * One contract, three protocols. The agent loop calls only these methods; each
 * adapter wires them to its real backend (CDP / X11-Wayland / ADB).
 */
export interface Adapter {
  /**
   * Go to the app: navigate to a URL (web) · launch/focus the window (desktop) · start the activity (android).
   *
   * `timeoutMs` is the caller's REMAINING wall-clock budget for the run: the adapter
   * shortens its own wait to fit inside it and never extends past its own default
   * (see `capWait`). Omit it for the adapter default.
   */
  open(target: string, timeoutMs?: number): Promise<void>;

  /** Resolve the first node matching {@link Query}; `null` if none match. */
  find(opts: Query): Promise<Node | null>;

  /** Click an element (re-resolving a selector, or using a found {@link Node}). */
  click(target: NodeRef): Promise<void>;

  /** Type `text` into an element (focuses it first). */
  type(target: NodeRef, text: string): Promise<void>;

  /** Press a key or chord on the focused element — `'Enter'` · `'Escape'` · `'Control+a'` (chords split on `+`). */
  pressKey(key: string): Promise<void>;

  /** Scroll the viewport — or a scoped region via {@link ScrollOptions.within} — one {@link ScrollDirection} step. */
  scroll(opts: ScrollOptions): Promise<void>;

  /** Read the structured UI tree as normalized {@link Node}s (DOM · a11y tree · view hierarchy). */
  readState(opts?: Query): Promise<Node[]>;

  /**
   * Capture the current frame (for evidence + the vision guy).
   *
   * PNG by default and for every evidence frame — UI is flat colour and sharp
   * text, which is exactly what PNG is good at. Measured on the `dummy/web`
   * fixture at 1280x720: PNG 43KB, JPEG q85 42KB, JPEG q90 49KB, JPEG q95 62KB —
   * so encoding UI as JPEG costs text quality and saves nothing.
   *
   * {@link ScreenshotOptions.format} exists for the inverse case: a photo-heavy
   * page, where PNG is pathological and a high-quality JPEG is many times
   * smaller with no visible loss on photographic content. `look` uses it only
   * above a size threshold that flat UI never reaches. Adapters that cannot
   * honour a format return PNG — the caller reads the real type off the result.
   */
  screenshot(opts?: ScreenshotOptions): Promise<Uint8Array>;

  /** Block until {@link WaitOptions} hold (node appears, network idle, …) or time out. */
  waitFor(opts: WaitOptions): Promise<void>;

  /** Read captured console messages, newest first, narrowed by {@link LogQuery}. Reads are non-destructive. */
  console(opts?: LogQuery): Promise<ConsoleEntry[]>;

  /** Read captured network exchanges, newest first, narrowed by {@link LogQuery}. Reads are non-destructive. */
  network(opts?: LogQuery): Promise<NetworkEntry[]>;

  /**
   * List the target's open tabs, newest last. OPTIONAL — implemented by targets
   * that have a tab concept (web); absent elsewhere, and the belt says so rather
   * than pretending a single-window target has one tab.
   */
  tabs?(): Promise<TabInfo[]>;

  /**
   * Drive a different tab from now on: every later read and action targets it,
   * and console/network capture follows. OPTIONAL, paired with {@link tabs}.
   * Throws when the index names no open tab.
   */
  selectTab?(index: number): Promise<void>;

  /**
   * URLs of full-document loads the driven target performed on its own, oldest
   * first — DRAINED by reading, so each caller gets only what happened since the
   * last read. OPTIONAL: implemented by targets with a document concept (web).
   *
   * A new document wipes every bit of in-page state, and nothing on screen says
   * so: a form that submits without `preventDefault`, a click on a plain link,
   * a session that expires into a redirect. The driver reads the fresh page,
   * finds its own earlier work undone, and reports the action it just took as
   * having done nothing — or, worse, as having worked. The queue is what lets
   * the belt say "the page reloaded" on the step that caused it.
   *
   * {@link open} drains its own load before returning, so a navigation the
   * driver ASKED for never surfaces here — what is left is exactly the surprise.
   */
  takeUnrequestedLoads?(): Promise<string[]>;

  /** Release the target: stop a **managed** process; for **attach**, disconnect only — never stop it. */
  close(): Promise<void>;
}
