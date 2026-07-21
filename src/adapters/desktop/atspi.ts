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
import { desktopEnv, type Exec, makeExec } from './proc.js';

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

/** Tunables for one {@link AtspiSource.readTree} walk. */
export interface AtspiReadOptions {
  maxNodes?: number;
  maxDepth?: number;
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
export type BusctlExec = (args: string[]) => Promise<string>;

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
    this.#exec = init.exec ?? ((args) => exec('busctl', args));
  }

  async readTree(opts: AtspiReadOptions = {}): Promise<AtspiNode[]> {
    const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
    const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
    const out: AtspiNode[] = [];
    const seen = new Set<string>();
    // Start at the registry root's children (apps); the desktop root itself is not UI.
    let frontier = await this.#children({ dest: REGISTRY_DEST, path: ROOT_PATH });
    for (let depth = 0; frontier.length > 0 && depth < maxDepth; depth += 1) {
      const next: AtspiRef[] = [];
      for (const ref of frontier) {
        if (out.length >= maxNodes) return out;
        const key = `${ref.dest}${ref.path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(await this.#describe(ref));
        next.push(...(await this.#children(ref)));
      }
      frontier = next;
    }
    return out;
  }

  /** Resolve (and cache) the a11y peer-bus address via the session bus. */
  async #a11yAddress(): Promise<string> {
    if (this.#address) return this.#address;
    const data = busctlData(
      await this.#exec([
        '--user',
        '--json=short',
        'call',
        'org.a11y.Bus',
        '/org/a11y/bus',
        'org.a11y.Bus',
        'GetAddress',
      ]),
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
  ): Promise<unknown> {
    const address = await this.#a11yAddress();
    return busctlData(
      await this.#exec([
        `--address=${address}`,
        '--json=short',
        'call',
        ref.dest,
        ref.path,
        iface,
        member,
        ...extra,
      ]),
    );
  }

  async #children(ref: AtspiRef): Promise<AtspiRef[]> {
    return parseChildren(
      firstReturn(await this.#call(ref, A11Y_IFACE, 'GetChildren'), 'GetChildren'),
    );
  }

  /** Read the `Name` property as a plain scalar (`get-property` avoids a variant wrapper). */
  async #name(ref: AtspiRef): Promise<string> {
    const address = await this.#a11yAddress();
    const data = busctlData(
      await this.#exec([
        `--address=${address}`,
        '--json=short',
        'get-property',
        ref.dest,
        ref.path,
        A11Y_IFACE,
        'Name',
      ]),
    );
    return asString(data, 'Name');
  }

  /** Read a single node's role/name/state/extents into a normalized {@link AtspiNode}. */
  async #describe(ref: AtspiRef): Promise<AtspiNode> {
    const roleName = asString(
      firstReturn(await this.#call(ref, A11Y_IFACE, 'GetRoleName'), 'GetRoleName'),
      'GetRoleName',
    );
    const role = mapRole(roleName);
    const name = await this.#name(ref);
    const { enabled, visible } = stateFlags(
      parseStateWords(firstReturn(await this.#call(ref, A11Y_IFACE, 'GetState'), 'GetState')),
    );
    // Application roots + some toolkit filler nodes don't implement Component, so
    // busctl exits non-zero on GetExtents. Keep the node (killing the whole walk over
    // an unmeasurable filler helps nobody) but mark it `measured: false` — the zeros
    // below are a placeholder, never geometry. Role/name/state failures stay loud.
    // An expired per-call cap (`proc.ts`) is not "no Component":
    // swallowing it would spend the cap again on every remaining node of the walk.
    const extents = await this.#call(ref, COMPONENT_IFACE, 'GetExtents', [
      'u',
      String(COORD_SCREEN),
    ]).catch((error: unknown) => {
      if (error instanceof ExecTimeoutError) throw error;
      return null;
    });
    const bounds =
      extents === null ? UNMEASURED_BOUNDS : parseExtents(firstReturn(extents, 'GetExtents'));
    return { role, name, bounds, enabled, visible, measured: extents !== null };
  }
}
