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
  /** `SELECT cols` — which {@link Node} fields to populate for a sparse read; omit for all. */
  fields?: NodeField[];
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
}

/**
 * One contract, three protocols. The agent loop calls only these methods; each
 * adapter wires them to its real backend (CDP / X11-Wayland / ADB).
 */
export interface Adapter {
  /** Go to the app: navigate to a URL (web) · launch/focus the window (desktop) · start the activity (android). */
  open(target: string): Promise<void>;

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

  /** Capture the current frame as PNG bytes (for evidence + the vision guy). */
  screenshot(): Promise<Uint8Array>;

  /** Block until {@link WaitOptions} hold (node appears, network idle, …) or time out. */
  waitFor(opts: WaitOptions): Promise<void>;

  /** Drain captured console messages, newest first, narrowed by {@link LogQuery}. */
  console(opts?: LogQuery): Promise<ConsoleEntry[]>;

  /** Drain captured network exchanges, newest first, narrowed by {@link LogQuery}. */
  network(opts?: LogQuery): Promise<NetworkEntry[]>;

  /** Release the target: stop a **managed** process; for **attach**, disconnect only — never stop it. */
  close(): Promise<void>;
}
