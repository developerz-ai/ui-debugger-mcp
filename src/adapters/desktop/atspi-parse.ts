/**
 * AT-SPI2 wire-shape parsing — the pure, unit-tested half of the desktop read.
 *
 * Moved verbatim out of `atspi.ts` (which keeps the shared types and the
 * filter/shaping helpers): the AT-SPI role map, the fail-loud type guards, the
 * busctl `--json=short` reply parsers and the role/name query helpers.
 * `BusctlAtspi` (`atspi-busctl.ts`) is the integration-validated runner on top.
 */

import { AdapterError } from '../../errors.js';
import type { Bounds, Node } from '../contract.js';
import type { AtspiRef } from './atspi.js';

/** `AtspiStateType` bit indices we care about (full enum in at-spi2-core). */
const STATE_ENABLED = 8;
const STATE_SENSITIVE = 24;
const STATE_SHOWING = 25;
const STATE_VISIBLE = 30;

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

export function asString(value: unknown, ctx: string): string {
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
export function firstReturn(data: unknown, ctx: string): unknown {
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

// --- Query -------------------------------------------------------------------

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
