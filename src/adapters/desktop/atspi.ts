/**
 * Desktop read state — the AT-SPI2 accessibility tree over D-Bus (`org.a11y.atspi`).
 *
 * AT-SPI2 is the one display-agnostic read path (same on X11 and Wayland). We reach
 * it via **busctl** (systemd, no extra deps), which speaks D-Bus and emits machine
 * JSON (`--json=short`). The walk is a two-bus hop (`idea/desktop-control.md`):
 *   1. session bus → `org.a11y.Bus.GetAddress` yields the a11y peer-bus address,
 *   2. a11y bus → from the registry root, recurse `Accessible.GetChildren`,
 *      reading `GetRoleName`, `Name`, `GetState`, and `Component.GetExtents(SCREEN)`
 *      per node, normalizing each onto the contract {@link Node}.
 *
 * One busctl process per call makes this spawn-heavy; the walk is bounded by
 * `maxNodes`/`maxDepth` to stay sane. Chromium/Electron need
 * `--force-renderer-accessibility`; canvas/games expose nothing → vision fallback
 * (future). Fails loud — a malformed reply or unreachable bus throws {@link AdapterError}.
 *
 * The wire-shape parsers (busctl JSON, extents, state bitfield, role map, filters)
 * are pure and unit-tested; {@link BusctlAtspi} is the integration-validated runner.
 */

import { AdapterError, ExecTimeoutError } from '../../errors.js';
import type { Bounds, Filters, FilterValue, Node, Query } from '../contract.js';
import { capToLimit } from '../limit.js';
import { desktopEnv, type Exec, type ExecOptions, makeExec } from './proc.js';

const A11Y_IFACE = 'org.a11y.atspi.Accessible';
const COMPONENT_IFACE = 'org.a11y.atspi.Component';
const REGISTRY_DEST = 'org.a11y.atspi.Registry';
const ROOT_PATH = '/org/a11y/atspi/accessible/root';

/** `ATSPI_COORD_TYPE_SCREEN` — extents relative to the screen, for clicks + vision. */
const COORD_SCREEN = 0;

/** Placeholder bounds for a node with no `Component` — paired with `measured: false`. */
const UNMEASURED_BOUNDS: Bounds = { x: 0, y: 0, width: 0, height: 0 };

/** Walk caps — keep the (spawn-heavy) tree read bounded. */
const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_DEPTH = 25;

/** `AtspiStateType` bit indices we care about (full enum in at-spi2-core). */
const STATE_ENABLED = 8;
const STATE_SENSITIVE = 24;
const STATE_SHOWING = 25;
const STATE_VISIBLE = 30;

/** A node plus the computed `visible` flag backing the `visible_eq` filter. */
export interface AtspiNode extends Node {
  visible: boolean;
  /**
   * False when the node exposes no `Component` (app roots, toolkit fillers): its
   * `bounds` are **unknown**, not a rect at the screen origin. Clicks on such a node
   * fail loud (`input.ts#expectOnScreen`) and region scoping skips it.
   */
  measured: boolean;
}

/** A D-Bus object reference on the a11y bus — `(unique-name, object-path)`. */
export interface AtspiRef {
  dest: string;
  path: string;
}

/** A window the scope named — the ref the walk starts from, and its name. */
interface ScopedWindow {
  ref: AtspiRef;
  name: string;
}

// --- Scope (which application/window a read is bound to) --------------------

/**
 * The window identity a desktop read is scoped to — the application/window
 * `open` selected.
 *
 * `title` is the window title (what WM_NAME says); `class` is the window class
 * (WM_CLASS — the application's own identity). Both are matched as literal,
 * case-insensitive substrings, never as regexes.
 */
export interface AtspiScope {
  /** Window title — matched as a literal, case-insensitive substring. */
  title?: string;
  /** Window class — matched as a literal, case-insensitive substring. */
  class?: string;
}

/**
 * True when `node` is the application or window the scope names.
 *
 * A `window` (AT-SPI `frame`/`window` → contract role `window`) matches on the
 * title; an `application` matches on the title OR the class — the class belongs
 * to the application, the title to the window inside it. Matching is a literal,
 * case-insensitive substring (the rule the xdotool window search uses), never a
 * regex.
 *
 * The role is normalized first, so a raw AT-SPI `frame` counts as a `window`.
 */
export function matchesScope(node: Pick<Node, 'role' | 'name'>, scope: AtspiScope): boolean {
  const role = mapRole(node.role);
  const name = node.name.toLowerCase();
  const title = scope.title?.toLowerCase() ?? '';
  if (role === 'window') return title !== '' && name.includes(title);
  if (role === 'application') {
    if (title !== '' && name.includes(title)) return true;
    const cls = scope.class?.toLowerCase() ?? '';
    return cls !== '' && name.includes(cls);
  }
  return false;
}

/** The scope spelled out for an error message — a window identity, never a secret. */
function describeScope(scope: AtspiScope): string {
  const parts: string[] = [];
  if (scope.title) parts.push(`title=${JSON.stringify(scope.title)}`);
  if (scope.class) parts.push(`class=${JSON.stringify(scope.class)}`);
  return parts.length > 0 ? parts.join(' ') : 'no title, no class';
}

/**
 * The ONE window the scope named — more than one is an ambiguity, not a scope.
 *
 * The walk starts from every root it is handed, so two candidate windows mean
 * a lookup resolves against whichever the bus listed first: the duplicate
 * label landing in the wrong application. An ambiguous scope fails loud
 * instead of guessing which one was meant.
 */
function oneWindow(windows: ScopedWindow[], scope: AtspiScope): ScopedWindow | null {
  if (windows.length > 1) {
    throw new AdapterError(
      `AT-SPI: the scope (${describeScope(scope)}) is ambiguous — ${windows.length} windows match it ` +
        `(${windows.map((w) => JSON.stringify(w.name)).join(', ')}); the scope must name exactly one`,
    );
  }
  return windows[0] ?? null;
}

/** Tunables for one {@link AtspiSource.readTree} walk. */
export interface AtspiReadOptions {
  maxNodes?: number;
  maxDepth?: number;
  /**
   * Prune the walk to nodes matching this role/name up front: a non-matching node
   * skips its `GetState`/`GetExtents` calls (2 of the ~4 busctl spawns per node) since
   * its full description would just be filtered out downstream anyway. The tree is
   * still walked in full (children are always fetched) — only the expensive per-node
   * describe calls are skipped. Combined with `maxNodes`, the walk also stops as soon
   * as enough *matches* are found, not merely enough nodes visited.
   */
  query?: ParsedQuery;
  /**
   * Wall-clock instant (epoch ms) the walk must not run past. Every busctl spawn of
   * this walk is capped by the time left until then, and a spawn that resolves after
   * it fails loud — a tree read past the deadline is not an answer, it is a stale
   * one. `maxNodes` bounds *matches*, not visits, and every visited node costs ~2
   * busctl spawns — without this a fruitless walk over a big tree runs for as long
   * as the tree is deep (`waitFor` passes its own deadline).
   */
  deadline?: number;
  /**
   * Restrict the walk to the application/window this scope names.
   *
   * Without it the walk starts at the a11y registry root and returns EVERY
   * application on the desktop — with two apps exposing the same "Save" the
   * read resolves to whichever came first, and the click lands in the wrong
   * app. With it the walk resolves the named application (or the window inside
   * it) FIRST and returns only that subtree; a scope matching nothing fails
   * loud instead of degrading to the whole desktop.
   */
  scope?: AtspiScope;
}

/** The read seam the adapter depends on — implemented by {@link BusctlAtspi}, faked in tests. */
export interface AtspiSource {
  readTree(opts?: AtspiReadOptions): Promise<AtspiNode[]>;
}

/** Whitelisted `filters` keys for desktop nodes — anything else is rejected, not ignored. */
export const DESKTOP_FILTER_KEYS = [
  'visible_eq',
  'enabled_eq',
  'role_in',
  'name_contains',
] as const;

// --- Role mapping -----------------------------------------------------------

/** AT-SPI `GetRoleName` strings → contract roles (ARIA-ish, target-agnostic). */
const ROLE_MAP: Record<string, string> = {
  'push button': 'button',
  'toggle button': 'button',
  button: 'button',
  link: 'link',
  entry: 'textbox',
  'password text': 'textbox',
  text: 'textbox',
  'check box': 'checkbox',
  'check menu item': 'menuitem',
  'radio button': 'radio',
  'radio menu item': 'menuitem',
  'combo box': 'combobox',
  slider: 'slider',
  'spin button': 'spinbutton',
  'page tab': 'tab',
  'page tab list': 'tablist',
  heading: 'heading',
  label: 'label',
  'menu item': 'menuitem',
  menu: 'menu',
  'list item': 'listitem',
  list: 'list',
  table: 'table',
  image: 'img',
  icon: 'img',
  frame: 'window',
  window: 'window',
  dialog: 'dialog',
  alert: 'alert',
  'tool bar': 'toolbar',
  'status bar': 'status',
  'document web': 'document',
  panel: 'group',
  filler: 'group',
  section: 'group',
};

/** Normalize an AT-SPI role name to a contract role; unknown roles pass through cleaned. */
export function mapRole(roleName: string): string {
  const key = roleName.trim().toLowerCase();
  return ROLE_MAP[key] ?? key.replace(/\s+/g, ' ');
}

// --- Type guards (fail loud, never coerce) ----------------------------------

function asArray(value: unknown, ctx: string): unknown[] {
  if (!Array.isArray(value)) throw new AdapterError(`AT-SPI: expected an array for ${ctx}`);
  return value;
}

function asString(value: unknown, ctx: string): string {
  if (typeof value !== 'string') throw new AdapterError(`AT-SPI: expected a string for ${ctx}`);
  return value;
}

function asNumber(value: unknown, ctx: string): number {
  if (typeof value !== 'number') throw new AdapterError(`AT-SPI: expected a number for ${ctx}`);
  return value;
}

// --- busctl JSON parsing ----------------------------------------------------

/** Parse a busctl `--json=short` reply, returning its `data` field (loud on malformed JSON). */
export function busctlData(stdout: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new AdapterError(`AT-SPI: busctl returned non-JSON: ${stdout.slice(0, 120)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || !('data' in parsed)) {
    throw new AdapterError('AT-SPI: busctl reply missing `data`');
  }
  return (parsed as { data: unknown }).data;
}

/** First return value of a method `call` (busctl wraps returns in a `data` array). */
function firstReturn(data: unknown, ctx: string): unknown {
  const arr = asArray(data, ctx);
  if (arr.length === 0) throw new AdapterError(`AT-SPI: empty reply for ${ctx}`);
  return arr[0];
}

/** Decode `Component.GetExtents` `(iiii)` → screen {@link Bounds}. */
export function parseExtents(value: unknown): Bounds {
  const a = asArray(value, 'extents');
  if (a.length < 4) throw new AdapterError('AT-SPI: extents needs 4 ints');
  return {
    x: asNumber(a[0], 'extents.x'),
    y: asNumber(a[1], 'extents.y'),
    width: asNumber(a[2], 'extents.width'),
    height: asNumber(a[3], 'extents.height'),
  };
}

/** Decode `Accessible.GetState` `au` → the two 32-bit state words `[low, high]`. */
export function parseStateWords(value: unknown): [number, number] {
  const a = asArray(value, 'state');
  if (a.length < 2) throw new AdapterError('AT-SPI: state needs 2 words');
  return [asNumber(a[0], 'state[0]'), asNumber(a[1], 'state[1]')];
}

/** True when `bit` is set in the split 64-bit AT-SPI state field. */
export function hasState(words: [number, number], bit: number): boolean {
  const word = bit < 32 ? words[0] : words[1];
  return ((word >>> (bit % 32)) & 1) === 1;
}

/** Derive the contract `enabled` + internal `visible` flags from a state field. */
export function stateFlags(words: [number, number]): { enabled: boolean; visible: boolean } {
  return {
    enabled: hasState(words, STATE_ENABLED) && hasState(words, STATE_SENSITIVE),
    visible: hasState(words, STATE_SHOWING) && hasState(words, STATE_VISIBLE),
  };
}

/** Decode `Accessible.GetChildren` `a(so)` → child {@link AtspiRef}s. */
export function parseChildren(value: unknown): AtspiRef[] {
  return asArray(value, 'children').map((entry) => {
    const pair = asArray(entry, 'childRef');
    if (pair.length < 2) throw new AdapterError('AT-SPI: child ref needs (dest, path)');
    return { dest: asString(pair[0], 'childRef.dest'), path: asString(pair[1], 'childRef.path') };
  });
}

// --- Query + filters --------------------------------------------------------

/** A parsed agent query: an optional role and/or a name substring. */
export interface ParsedQuery {
  role?: string;
  name?: string;
}

/** Parse an agent target (`button "Save"` or plain `Save`) into a {@link ParsedQuery}. */
export function parseRoleNameQuery(raw: string): ParsedQuery {
  const q = raw.trim();
  const match = /^([a-zA-Z][\w-]*)\s+["'](.+)["']$/.exec(q);
  const role = match?.[1];
  const name = match?.[2];
  if (role && name) return { role: role.toLowerCase(), name };
  return { name: q };
}

/** True when a node satisfies a {@link ParsedQuery} (role exact, name case-insensitive substring). */
export function matchesQuery(node: Node, parsed: ParsedQuery): boolean {
  if (parsed.role && node.role.toLowerCase() !== parsed.role) return false;
  if (parsed.name && !node.name.toLowerCase().includes(parsed.name.toLowerCase())) return false;
  return true;
}

function expectBoolean(key: string, value: FilterValue): boolean {
  if (typeof value !== 'boolean') throw new AdapterError(`filter \`${key}\` expects a boolean`);
  return value;
}

function expectString(key: string, value: FilterValue): string {
  if (typeof value !== 'string') throw new AdapterError(`filter \`${key}\` expects a string`);
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
export function applyDesktopFilters(nodes: AtspiNode[], filters?: Filters): AtspiNode[] {
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
          `unknown filter \`${key}\` for desktop adapter (allowed: ${DESKTOP_FILTER_KEYS.join(', ')})`,
        );
    }
  }
  return out;
}

/** Drop the internal `visible` flag — the public contract returns plain {@link Node}s. */
export function toNode(node: AtspiNode): Node {
  return { role: node.role, name: node.name, bounds: node.bounds, enabled: node.enabled };
}

/** True when a node's center sits inside `region` — used to scope a read by `within`. */
export function centerWithin(node: Node, region: Bounds): boolean {
  const cx = node.bounds.x + node.bounds.width / 2;
  const cy = node.bounds.y + node.bounds.height / 2;
  return (
    cx >= region.x &&
    cx <= region.x + region.width &&
    cy >= region.y &&
    cy <= region.y + region.height
  );
}

/**
 * Scope, filter, query-match and cap a read tree onto contract {@link Node}s —
 * the shared shaping `readState`/`find` apply after the (adapter-side) walk.
 */
export function shapeNodes(
  nodes: AtspiNode[],
  opts: Query,
  defaultLimit: number,
  region?: Bounds,
): Node[] {
  let out = nodes;
  // Unmeasured nodes have no position: their placeholder center (0,0) would falsely
  // land inside any region touching the screen origin.
  if (region) out = out.filter((n) => n.measured && centerWithin(n, region));
  if (opts.query) {
    const parsed = parseRoleNameQuery(opts.query);
    out = out.filter((n) => matchesQuery(n, parsed));
  }
  out = applyDesktopFilters(out, opts.filters);
  return capToLimit(out, opts.limit ?? defaultLimit).map(toNode);
}

// --- busctl-backed reader ---------------------------------------------------

/** A busctl invocation (args only — the `busctl` binary is fixed). Injected for tests. */
export type BusctlExec = (args: string[], opts?: ExecOptions) => Promise<string>;

/**
 * {@link AtspiSource} backed by `busctl`. Walks the a11y tree breadth-first from the
 * registry root, bounded by `maxNodes`/`maxDepth`. Resolves the a11y bus address once
 * and caches it. Every reply is validated by the pure parsers above; failures throw loud.
 */
export class BusctlAtspi implements AtspiSource {
  readonly #exec: BusctlExec;
  #address: string | null = null;

  constructor(init: { display?: string; exec?: BusctlExec } = {}) {
    const exec: Exec = makeExec(desktopEnv(init.display));
    this.#exec = init.exec ?? ((args, opts) => exec('busctl', args, opts));
  }

  async readTree(opts: AtspiReadOptions = {}): Promise<AtspiNode[]> {
    const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const query = opts.query;
    const deadline = opts.deadline;
    const out: AtspiNode[] = [];
    const seen = new Set<string>();
    // Start at the registry root's children (apps); the desktop root itself is not UI.
    // A scoped read resolves the application/window it is bound to FIRST: the
    // registry spans EVERY application on the desktop, so an unscoped walk
    // resolves a label like "Save" against whichever app answered first and
    // the click lands in the wrong window.
    let frontier: AtspiRef[];
    if (opts.scope) {
      // The scoped walk resolves its own root and reports why it could not:
      // an exhausted deadline and a scope that matches nothing are different
      // failures, and the caller must not read one as the other.
      frontier = await this.#scopeRoots(opts.scope, deadline, maxDepth);
    } else {
      // Already out of time: spend no spawn at all — there is nothing left to read.
      if (deadline !== undefined && Date.now() >= deadline) return out;
      frontier = await this.#children({ dest: REGISTRY_DEST, path: ROOT_PATH }, deadline);
    }
    for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth += 1) {
      const next: AtspiRef[] = [];
      for (const ref of frontier) {
        // With a query, `out` holds only matches — so this also stops the walk as
        // soon as enough matches are found, not merely enough nodes visited.
        if (out.length >= maxNodes) return out;
        // Out of time: stop before spending another pair of spawns on this node.
        if (deadline !== undefined && Date.now() >= deadline) return out;
        const key = `${ref.dest}${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { role, name } = await this.#roleAndName(ref, deadline);
        // A query-pruned non-match: skip the State/Extents calls (they'd just be
        // filtered out downstream) but keep walking its children for deeper matches.
        if (
          !query ||
          matchesQuery({ role, name, bounds: UNMEASURED_BOUNDS, enabled: false }, query)
        ) {
          out.push(await this.#describeRest(ref, role, name, deadline));
        }
        next.push(...(await this.#children(ref, deadline)));
      }
      frontier = next;
    }
    return out;
  }

  /**
   * Resolve the scope to the ONE tree root the walk starts from.
   *
   * The registry root's children ARE the applications on the desktop, so the
   * scope is resolved against them first — an unscoped walk starts there and
   * therefore sees EVERY application, which is how a duplicate label ("Save"
   * in two apps) resolves to the wrong one.
   *
   * The scope resolves to exactly ONE root, never a set: the walk starts from
   * every root it is handed, so two of them put two applications' subtrees in
   * the result and the lookup resolves against whichever the bus listed
   * first — the duplicate-label hole this scope exists to close. A scope that
   * names two applications, or two windows, is ambiguous: it fails loud
   * instead of guessing which one was meant.
   *
   * Resolution order: a `class` names the application outright — the title
   * then only picks the window inside it, and other applications whose NAMES
   * carry the title are irrelevant. Without a class, matching WINDOWS come
   * first: a window actually titled "Doc" beats an application merely named
   * "Doc Editor"; only when no window carries the title is an application
   * carrying it taken as the scope.
   *
   * The top level is matched as an application whatever role the toolkit
   * reports for it (real trees say `application`, some say `frame`), so the
   * match must not depend on that role string.
   *
   * A scope that matches nothing resolves to no root at all: the caller then
   * fails loud instead of reading a tree that belongs to another application.
   */
  async #scopeRoots(
    scope: AtspiScope,
    deadline: number | undefined,
    maxDepth: number,
  ): Promise<AtspiRef[]> {
    // Out of time before the search even starts: no root can be resolved, and
    // the caller must not read that as "the scope matched nothing".
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new AdapterError(
        'AT-SPI: the scoped walk ran out of time before it reached the scoped window',
      );
    }
    const apps = await this.#children({ dest: REGISTRY_DEST, path: ROOT_PATH }, deadline);
    // Which applications does the scope name? The class is the application's
    // OWN identity, so it decides the application; the title names the WINDOW
    // inside it. An application matched by class is the one the scope is
    // bound to — the title then picks the window within it.
    const byTitle: AtspiRef[] = [];
    const byClass: AtspiRef[] = [];
    for (const ref of apps) {
      const { name } = await this.#roleAndName(ref, deadline);
      if (matchesScope({ role: 'application', name }, { class: scope.class })) {
        byClass.push(ref);
      } else if (matchesScope({ role: 'application', name }, { title: scope.title })) {
        byTitle.push(ref);
      }
    }
    // The class is the application's OWN identity: once it names an
    // application, the scope is bound to THAT application and the title only
    // picks the window inside it. Other applications whose NAMES carry the
    // title are irrelevant — they must not trip an application-title
    // ambiguity, and the read must never be handed to them.
    if (byClass.length > 0) {
      const window = oneWindow(await this.#windowsUnder(byClass, scope, deadline, maxDepth), scope);
      if (window) return [window.ref];
      if (byClass.length > 1) {
        throw new AdapterError(
          `AT-SPI: the scope (${describeScope(scope)}) is ambiguous — ${byClass.length} applications ` +
            'carry that class; the scope must name exactly one',
        );
      }
      // The class matched exactly one application but the title matched no
      // window in it. Returning the whole application would let find/click
      // resolve labels in ANOTHER window of that app — the one thing a scoped
      // read must never do. Fail loud instead.
      if (scope.title) {
        throw new AdapterError(
          `AT-SPI: the scope (${describeScope(scope)}) matched the application but no window in it ` +
            'carries that title; the scope must name a window that exists',
        );
      }
      return byClass; // exactly one application, and no title to narrow it by
    }
    // No class: matching WINDOWS come first. An application whose NAME merely
    // carries the title must not win while the window actually titled so
    // lives in another application — that hands find/click to the wrong app.
    // Only when NO window carries the title is an application named by it
    // taken as the scope, and two of those is an ambiguity, not a choice.
    if (scope.title) {
      const window = oneWindow(await this.#windowsUnder(apps, scope, deadline, maxDepth), scope);
      if (window) return [window.ref];
      if (byTitle.length > 1) {
        throw new AdapterError(
          `AT-SPI: the scope (${describeScope(scope)}) is ambiguous — ${byTitle.length} applications ` +
            'carry that title; the scope must name exactly one',
        );
      }
      if (byTitle.length === 1) return byTitle;
    }
    // Nothing matched. A deadline that expired on the way here is a timeout,
    // not a miss: reporting it as "no match" would send the caller looking for
    // a window that is simply out of reach in the time it had.
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new AdapterError(
        'AT-SPI: the scoped walk ran out of time before it reached the scoped window',
      );
    }
    throw new AdapterError(
      `AT-SPI: no application or window matched the scope (${describeScope(scope)})`,
    );
  }

  /**
   * The windows inside these applications whose name carries the scoped title.
   *
   * A walk that gave up mid-search (deadline spent) is a failure, not a
   * partial answer: acting on the hits found so far would read a window the
   * scope never actually named.
   */
  async #windowsUnder(
    apps: AtspiRef[],
    scope: AtspiScope,
    deadline: number | undefined,
    maxDepth: number,
  ): Promise<ScopedWindow[]> {
    const windows: ScopedWindow[] = [];
    for (const app of apps) {
      windows.push(...(await this.#windowsIn(app, scope, deadline, maxDepth)));
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new AdapterError(
          'AT-SPI: the scoped walk ran out of time before it reached the scoped window',
        );
      }
    }
    return windows;
  }

  /**
   * The windows inside `app` whose name carries the scoped title.
   *
   * Only container roles are descended into: a window's children are its
   * widgets, and a widget's subtree never holds another toplevel. That keeps
   * the scoped search from walking an entire application just to find its
   * frame.
   */
  async #windowsIn(
    app: AtspiRef,
    scope: AtspiScope,
    deadline: number | undefined,
    maxDepth: number,
  ): Promise<ScopedWindow[]> {
    const title = scope.title?.toLowerCase() ?? '';
    if (title === '') return [];
    const hits: ScopedWindow[] = [];
    const seen = new Set<string>();
    let frontier = await this.#children(app, deadline);
    for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth += 1) {
      const next: AtspiRef[] = [];
      for (const ref of frontier) {
        if (deadline !== undefined && Date.now() >= deadline) return hits;
        const key = `${ref.dest}${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const { role, name } = await this.#roleAndName(ref, deadline);
        if (role === 'window') {
          if (name.toLowerCase().includes(title)) hits.push({ ref, name });
          continue; // a window's children are its widgets, never another toplevel
        }
        if (role !== 'application' && role !== 'dialog') continue;
        next.push(...(await this.#children(ref, deadline)));
      }
      frontier = next;
    }
    return hits;
  }

  /**
   * One busctl spawn, bounded by the walk's deadline.
   *
   * The subprocess is capped by the time left until the deadline, so a wedged bus
   * cannot hold the walk (and the `waitFor` that asked for it) past its timeout. A
   * reply that arrives after the deadline is a failure, not a partial tree: the
   * caller must not read a stale tree as the answer.
   */
  async #spawn(args: string[], deadline: number | undefined): Promise<string> {
    const out = await this.#exec(args, deadline === undefined ? undefined : { deadline });
    if (deadline !== undefined && Date.now() >= deadline) {
      throw new ExecTimeoutError(
        `desktop: \`busctl\` resolved after the walk deadline (${deadline}) had passed`,
      );
    }
    return out;
  }

  /** Resolve (and cache) the a11y peer-bus address via the session bus. */
  async #a11yAddress(deadline?: number): Promise<string> {
    if (this.#address) return this.#address;
    const data = busctlData(
      await this.#spawn(
        [
          '--user',
          '--json=short',
          'call',
          'org.a11y.Bus',
          '/org/a11y/bus',
          'org.a11y.Bus',
          'GetAddress',
        ],
        deadline,
      ),
    );
    const address = asString(firstReturn(data, 'GetAddress'), 'a11y bus address');
    if (address === '') throw new AdapterError('AT-SPI: empty a11y bus address');
    this.#address = address;
    return address;
  }

  /** Call a method on the a11y bus, returning the parsed `data` array of return values. */
  async #call(
    ref: AtspiRef,
    iface: string,
    member: string,
    extra: string[] = [],
    deadline?: number,
  ): Promise<unknown> {
    const address = await this.#a11yAddress(deadline);
    return busctlData(
      await this.#spawn(
        [
          `--address=${address}`,
          '--json=short',
          'call',
          ref.dest,
          ref.path,
          iface,
          member,
          ...extra,
        ],
        deadline,
      ),
    );
  }

  async #children(ref: AtspiRef, deadline?: number): Promise<AtspiRef[]> {
    return parseChildren(
      firstReturn(await this.#call(ref, A11Y_IFACE, 'GetChildren', [], deadline), 'GetChildren'),
    );
  }

  /** Read the `Name` property as a plain scalar (`get-property` avoids a variant wrapper). */
  async #name(ref: AtspiRef, deadline?: number): Promise<string> {
    const address = await this.#a11yAddress(deadline);
    const data = busctlData(
      await this.#spawn(
        [
          `--address=${address}`,
          '--json=short',
          'get-property',
          ref.dest,
          ref.path,
          A11Y_IFACE,
          'Name',
        ],
        deadline,
      ),
    );
    return asString(data, 'Name');
  }

  /** Read just role + name — cheap enough to spend on every node for query pruning. */
  async #roleAndName(ref: AtspiRef, deadline?: number): Promise<{ role: string; name: string }> {
    const roleName = asString(
      firstReturn(await this.#call(ref, A11Y_IFACE, 'GetRoleName', [], deadline), 'GetRoleName'),
      'GetRoleName',
    );
    return { role: mapRole(roleName), name: await this.#name(ref, deadline) };
  }

  /** Finish describing a node (state + extents) once its role/name are known to matter. */
  async #describeRest(
    ref: AtspiRef,
    role: string,
    name: string,
    deadline?: number,
  ): Promise<AtspiNode> {
    const { enabled, visible } = stateFlags(
      parseStateWords(
        firstReturn(await this.#call(ref, A11Y_IFACE, 'GetState', [], deadline), 'GetState'),
      ),
    );
    // Application roots + some toolkit filler nodes don't implement Component, so
    // busctl exits non-zero on GetExtents. Keep the node (killing the whole walk over
    // an unmeasurable filler helps nobody) but mark it `measured: false` — the zeros
    // below are a placeholder, never geometry. Role/name/state failures stay loud.
    // An expired per-call cap (`proc.ts`) is not "no Component":
    // swallowing it would spend the cap again on every remaining node of the walk.
    const extents = await this.#call(
      ref,
      COMPONENT_IFACE,
      'GetExtents',
      ['u', String(COORD_SCREEN)],
      deadline,
    ).catch((error: unknown) => {
      if (error instanceof ExecTimeoutError) throw error;
      return null;
    });
    const bounds =
      extents === null ? UNMEASURED_BOUNDS : parseExtents(firstReturn(extents, 'GetExtents'));
    return { role, name, bounds, enabled, visible, measured: extents !== null };
  }
}
