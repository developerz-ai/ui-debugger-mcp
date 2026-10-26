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
 * The wire-shape parsers (busctl JSON, extents, state bitfield, role map, query)
 * live in `atspi-parse.ts` (pure, unit-tested); {@link BusctlAtspi} lives in
 * `atspi-busctl.ts` (integration-validated runner). Both are re-exported below —
 * `./atspi.js` keeps its exact public surface.
 */

import { AdapterError } from '../../errors.js';
import type { Bounds, Filters, FilterValue, Node, Query } from '../contract.js';
import { capToLimit } from '../limit.js';
import { mapRole, matchesQuery, type ParsedQuery, parseRoleNameQuery } from './atspi-parse.js';

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
export interface ScopedWindow {
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
export function describeScope(scope: AtspiScope): string {
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
export function oneWindow(windows: ScopedWindow[], scope: AtspiScope): ScopedWindow | null {
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

// --- Filters ----------------------------------------------------------------

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

// --- Re-exports: the split halves, surfaced under `./atspi.js` as before -----

export type { BusctlExec } from './atspi-busctl.js';
export { BusctlAtspi } from './atspi-busctl.js';
export type { ParsedQuery } from './atspi-parse.js';
export {
  busctlData,
  hasState,
  mapRole,
  matchesQuery,
  parseChildren,
  parseExtents,
  parseRoleNameQuery,
  parseStateWords,
  stateFlags,
} from './atspi-parse.js';
