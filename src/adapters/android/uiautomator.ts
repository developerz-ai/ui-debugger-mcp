/**
 * Android read state — the **view hierarchy** via `uiautomator dump` (`idea/adapters.md`).
 *
 * Android hands you a structured tree for free (unlike the Linux desktop): `uiautomator
 * dump` writes a flat XML of `<node>` elements, each carrying `class`, `text`,
 * `content-desc`, `resource-id`, the boolean state flags, and a `bounds="[x1,y1][x2,y2]"`
 * screen rectangle. We flatten every `<node>` and normalize it onto the contract
 * {@link Node} (role from the widget class, name from text/desc, bounds parsed to a rect),
 * then apply the shared SQL-like shaping (`query`/`filters`/`within`/`limit`).
 *
 * The dump is read robustly as **dump-to-file then `cat`** — uiautomator interleaves a
 * status line on `/dev/tty`, so a file round-trip keeps the XML clean. The stale file is
 * removed first and the dump's success line asserted (it exits 0 even when it fails), so
 * a read is always the live screen or a loud error — never last screen's hierarchy. Canvas/Compose
 * surfaces that expose no hierarchy fall back to vision (future). Fails loud — a missing
 * `<hierarchy>` or a malformed `bounds` throws {@link AdapterError}, never a silent guess.
 *
 * The parsers + filters here are pure and unit-tested; {@link AdbUiAutomator} is the
 * integration-validated runner over the {@link Adb} seam.
 */

import { AdapterError } from '../../errors.js';
import type { Bounds, Filters, FilterValue, Node, Query } from '../contract.js';
import type { Adb } from './adb.js';

/** Where `uiautomator dump` writes its XML; we `cat` it back to avoid `/dev/tty` interleaving. */
const DUMP_PATH = '/sdcard/window_dump.xml';

/**
 * The success line `uiautomator dump` prints once it has written the file:
 * `UI hierchary dumped to: /sdcard/window_dump.xml` — the AOSP typo is real, and some
 * builds spell it correctly, so match the stable half. This line, **not** the exit
 * code, is the success signal: a dump that gives up ("ERROR: could not get idle
 * state") still exits 0.
 */
const DUMP_MARKER = /dumped to:\s*\S+/i;

/** Default cap on a dump read so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/** A node plus the internal flags backing android filters + query (dropped from the public {@link Node}). */
export interface AndroidNode extends Node {
  clickable: boolean;
  scrollable: boolean;
  focusable: boolean;
  /** `resource-id` (e.g. `com.app:id/submit`) — matched by the `query` and `id_contains` filter. */
  resourceId: string;
}

/** The read seam the adapter depends on — implemented by {@link AdbUiAutomator}, faked in tests. */
export interface UiAutomatorSource {
  dump(): Promise<AndroidNode[]>;
}

/** Whitelisted `filters` keys for android nodes — anything else is rejected, not ignored. */
export const ANDROID_FILTER_KEYS = [
  'enabled_eq',
  'clickable_eq',
  'scrollable_eq',
  'role_in',
  'name_contains',
  'id_contains',
] as const;

// --- Role mapping -----------------------------------------------------------

/** Android widget class (last `.`-segment, lowercased) → contract role (ARIA-ish, target-agnostic). */
const ANDROID_ROLE_MAP: Record<string, string> = {
  button: 'button',
  imagebutton: 'button',
  materialbutton: 'button',
  appcompatbutton: 'button',
  edittext: 'textbox',
  appcompatedittext: 'textbox',
  textinputedittext: 'textbox',
  autocompletetextview: 'textbox',
  multiautocompletetextview: 'textbox',
  textview: 'label',
  appcompattextview: 'label',
  checkbox: 'checkbox',
  appcompatcheckbox: 'checkbox',
  checkedtextview: 'checkbox',
  radiobutton: 'radio',
  appcompatradiobutton: 'radio',
  switch: 'switch',
  switchcompat: 'switch',
  switchmaterial: 'switch',
  togglebutton: 'switch',
  spinner: 'combobox',
  appcompatspinner: 'combobox',
  seekbar: 'slider',
  appcompatseekbar: 'slider',
  ratingbar: 'slider',
  imageview: 'img',
  appcompatimageview: 'img',
  recyclerview: 'list',
  listview: 'list',
  gridview: 'list',
  viewpager: 'list',
  viewpager2: 'list',
  scrollview: 'scrollview',
  nestedscrollview: 'scrollview',
  horizontalscrollview: 'scrollview',
  webview: 'document',
  progressbar: 'progressbar',
  tablayout: 'tablist',
  tabitem: 'tab',
  toolbar: 'toolbar',
  bottomnavigationview: 'navigation',
  cardview: 'group',
  materialcardview: 'group',
  framelayout: 'group',
  linearlayout: 'group',
  relativelayout: 'group',
  constraintlayout: 'group',
  coordinatorlayout: 'group',
  viewgroup: 'group',
  view: 'generic',
};

/** Normalize an android widget class to a contract role; unknown classes pass through cleaned. */
export function mapAndroidRole(className: string): string {
  const segment = className.split('.').pop() ?? className;
  const key = segment.trim().toLowerCase();
  if (key === '') return 'generic';
  return ANDROID_ROLE_MAP[key] ?? key;
}

// --- XML parsing (pure, no DOM dep) -----------------------------------------

/** Decode the five XML entities and numeric character references (`&amp;` last so already-decoded `&` is not re-decoded). */
export function unescapeXml(value: string): string {
  return value
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Parse a `<node …>` opening tag's `key="value"` attributes (values XML-unescaped). */
export function parseAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)="([^"]*)"/g;
  let match = re.exec(tag);
  while (match !== null) {
    const key = match[1];
    const value = match[2];
    if (key !== undefined && value !== undefined) out[key] = unescapeXml(value);
    match = re.exec(tag);
  }
  return out;
}

/** Decode a uiautomator `bounds="[x1,y1][x2,y2]"` string → screen {@link Bounds}. */
export function parseBounds(raw: string): Bounds {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(raw);
  if (!match) throw new AdapterError(`uiautomator: malformed bounds ${JSON.stringify(raw)}`);
  const x1 = Number(match[1]);
  const y1 = Number(match[2]);
  const x2 = Number(match[3]);
  const y2 = Number(match[4]);
  if (![x1, y1, x2, y2].every(Number.isFinite)) {
    throw new AdapterError(`uiautomator: non-numeric bounds ${JSON.stringify(raw)}`);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

const isTrue = (value: string | undefined): boolean => value === 'true';

/** Build an {@link AndroidNode} from one node's parsed attributes (name = text → content-desc). */
export function toAndroidNode(attrs: Record<string, string>): AndroidNode {
  const text = attrs.text ?? '';
  const desc = attrs['content-desc'] ?? '';
  return {
    role: mapAndroidRole(attrs.class ?? ''),
    name: text !== '' ? text : desc,
    bounds: parseBounds(attrs.bounds ?? ''),
    enabled: isTrue(attrs.enabled),
    clickable: isTrue(attrs.clickable),
    scrollable: isTrue(attrs.scrollable),
    focusable: isTrue(attrs.focusable),
    resourceId: attrs['resource-id'] ?? '',
  };
}

/**
 * Flatten a `uiautomator dump` XML into {@link AndroidNode}s — every `<node>` opening
 * tag (container or self-closing), in document order. Throws if no `<hierarchy>` root.
 */
export function parseHierarchy(xml: string): AndroidNode[] {
  const start = xml.indexOf('<hierarchy');
  if (start === -1) throw new AdapterError('uiautomator: dump has no <hierarchy> root');
  const body = xml.slice(start);
  const out: AndroidNode[] = [];
  const re = /<node\b([^>]*?)\/?>/g;
  let match = re.exec(body);
  while (match !== null) {
    out.push(toAndroidNode(parseAttrs(match[1] ?? '')));
    match = re.exec(body);
  }
  return out;
}

// --- Query + filters --------------------------------------------------------

/** A parsed agent query: an optional role and/or a name/id substring. */
export interface ParsedQuery {
  role?: string;
  name?: string;
}

/** Parse an agent target (`button "Save"` or plain `Save` / a resource-id) into a {@link ParsedQuery}. */
export function parseAndroidQuery(raw: string): ParsedQuery {
  const q = raw.trim();
  const match = /^([a-zA-Z][\w-]*)\s+["'](.+)["']$/.exec(q);
  const role = match?.[1];
  const name = match?.[2];
  if (role && name) return { role: role.toLowerCase(), name };
  return { name: q };
}

/** True when a node satisfies a {@link ParsedQuery} (role exact; name matches text/desc OR resource-id). */
export function matchesAndroidNode(node: AndroidNode, parsed: ParsedQuery): boolean {
  if (parsed.role && node.role.toLowerCase() !== parsed.role) return false;
  if (parsed.name) {
    const needle = parsed.name.toLowerCase();
    const haystack = `${node.name} ${node.resourceId}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
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
 * Apply the whitelisted node `filters` in JS. Throws {@link AdapterError} on an unknown
 * key (no silent injection surface) or a wrong value type.
 */
export function applyAndroidFilters(nodes: AndroidNode[], filters?: Filters): AndroidNode[] {
  if (!filters) return nodes;
  let out = nodes;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'enabled_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.enabled === want);
        break;
      }
      case 'clickable_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.clickable === want);
        break;
      }
      case 'scrollable_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.scrollable === want);
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
      case 'id_contains': {
        const needle = expectString(key, value).toLowerCase();
        out = out.filter((n) => n.resourceId.toLowerCase().includes(needle));
        break;
      }
      default:
        throw new AdapterError(
          `unknown filter \`${key}\` for android adapter (allowed: ${ANDROID_FILTER_KEYS.join(', ')})`,
        );
    }
  }
  return out;
}

/** Drop the internal flags — the public contract returns plain {@link Node}s. */
export function toNode(node: AndroidNode): Node {
  const result: Node = {
    role: node.role,
    name: node.name,
    bounds: node.bounds,
    enabled: node.enabled,
  };
  if (node.resourceId !== '') result.testid = node.resourceId;
  return result;
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
 * Scope, query-match, filter and cap a dumped tree onto contract {@link Node}s — the
 * shared shaping `readState`/`find` apply after the adapter-side dump.
 */
export function shapeNodes(
  nodes: AndroidNode[],
  opts: Query,
  defaultLimit: number = DEFAULT_LIMIT,
  region?: Bounds,
): Node[] {
  let out = nodes;
  if (region) out = out.filter((n) => centerWithin(n, region));
  if (opts.query) {
    const parsed = parseAndroidQuery(opts.query);
    out = out.filter((n) => matchesAndroidNode(n, parsed));
  }
  out = applyAndroidFilters(out, opts.filters);
  const limit = opts.limit ?? defaultLimit;
  return out.slice(0, limit).map(toNode);
}

// --- ADB-backed reader ------------------------------------------------------

/**
 * {@link UiAutomatorSource} backed by the {@link Adb} seam. Dumps to a device file then
 * `cat`s it (clean XML, no `/dev/tty` interleaving) and parses with {@link parseHierarchy}.
 */
export class AdbUiAutomator implements UiAutomatorSource {
  readonly #adb: Adb;

  constructor(adb: Adb) {
    this.#adb = adb;
  }

  /**
   * Dump the live hierarchy — **never** a stale one. The old file is removed first and
   * the dump's own success line ({@link DUMP_MARKER}) is asserted, because a failed
   * `uiautomator dump` exits 0: without both, `cat` would hand back the previous
   * screen's XML and the agent would reason about a UI that is no longer there.
   */
  async dump(): Promise<AndroidNode[]> {
    await this.#adb.shell(['rm', '-f', DUMP_PATH]);
    const out = await this.#adb.shell(['uiautomator', 'dump', DUMP_PATH]);
    if (!DUMP_MARKER.test(out)) {
      const said = out.trim() === '' ? 'no output' : JSON.stringify(out.trim());
      throw new AdapterError(
        `uiautomator: dump did not write ${DUMP_PATH} (${said}) — the window may be ` +
          'mid-animation or busy; wait for it to settle and read again',
      );
    }
    const xml = await this.#adb.shell(['cat', DUMP_PATH]);
    return parseHierarchy(xml);
  }
}
