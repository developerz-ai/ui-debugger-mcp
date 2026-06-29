/**
 * Android shell-command builders — the pure argv shapes the adapter sends over the
 * {@link Adb} seam (`input tap/text/swipe/keyevent`, `am start`, `wm size`).
 *
 * Android needs no vision: actions are framework calls (`idea/desktop-control.md`).
 * Each builder returns the `string[]` handed to `adb shell …`, keeping the real logic
 * (text escaping, keycode mapping, swipe geometry) testable without spawning. The
 * adapter is the thin runner that pipes these to ADB.
 *
 * Coordinates come from a {@link Node}'s `bounds` (uiautomator) — same screen-pixel
 * space as `input tap`. Fails loud — an empty open target or an unknown key throws
 * {@link AdapterError}, never a silent no-op.
 */

import { AdapterError } from '../../errors.js';
import type { Bounds, ScrollDirection } from '../contract.js';

/** Default swipe distance (px) for one `scroll` step when no `amount` is given. */
const DEFAULT_SCROLL_AMOUNT = 600;

/** Default swipe duration (ms) — slow enough to register as a scroll, not a fling. */
const DEFAULT_SWIPE_MS = 300;

/** The integer screen-pixel center of a {@link Bounds} — where a tap/swipe lands. */
export function centerOf(bounds: Bounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

// --- launch -----------------------------------------------------------------

/**
 * Build the `open` launch command. A component (`pkg/.Activity`) starts that activity
 * directly (`am start -W`); a bare package launches its default activity via `monkey`.
 */
export function startArgs(target: string): string[] {
  const t = target.trim();
  if (t === '') {
    throw new AdapterError(
      'android open requires an activity component (pkg/.Activity) or a package',
    );
  }
  if (t.includes('/')) return ['am', 'start', '-W', '-n', t];
  return ['monkey', '-p', t, '-c', 'android.intent.category.LAUNCHER', '1'];
}

// --- tap / type / swipe -----------------------------------------------------

/** `input tap <x> <y>`. */
export function tapArgs(x: number, y: number): string[] {
  return ['input', 'tap', String(x), String(y)];
}

/**
 * Escape text for `input text` on the device shell: spaces → `%s` (literal space token),
 * and the shell-special chars get backslash-escaped so they reach the app verbatim.
 */
export function escapeInputText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') out += '%s';
    else if ('()<>|;&*\\~"\'`$'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/** `input text <escaped>` — types into the focused field. */
export function textArgs(text: string): string[] {
  return ['input', 'text', escapeInputText(text)];
}

/** `input swipe <x1> <y1> <x2> <y2> <ms>`. */
export function swipeArgs(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  durationMs: number = DEFAULT_SWIPE_MS,
): string[] {
  return ['input', 'swipe', String(x1), String(y1), String(x2), String(y2), String(durationMs)];
}

/**
 * Geometry for a `scroll` step: a finger swipe inside `area` (a region or the screen).
 * The finger moves **opposite** the requested {@link ScrollDirection} — e.g. `down`
 * (reveal lower content) swipes up. Distance is capped to 80% of the area's span.
 */
export function scrollSwipe(
  direction: ScrollDirection,
  area: Bounds,
  amount?: number,
): { x1: number; y1: number; x2: number; y2: number } {
  const { x: cx, y: cy } = centerOf(area);
  const horizontal = direction === 'left' || direction === 'right';
  const span = horizontal ? area.width : area.height;
  const distance = Math.min(amount ?? DEFAULT_SCROLL_AMOUNT, Math.round(span * 0.8));
  const half = Math.max(1, Math.round(distance / 2));
  switch (direction) {
    case 'down':
      return { x1: cx, y1: cy + half, x2: cx, y2: cy - half };
    case 'up':
      return { x1: cx, y1: cy - half, x2: cx, y2: cy + half };
    case 'left':
      return { x1: cx - half, y1: cy, x2: cx + half, y2: cy };
    case 'right':
      return { x1: cx + half, y1: cy, x2: cx - half, y2: cy };
    default: {
      const unreachable: never = direction;
      throw new AdapterError(`unknown scroll direction: ${JSON.stringify(unreachable)}`);
    }
  }
}

// --- keys -------------------------------------------------------------------

/** Contract key/modifier tokens → Android `KEYCODE_*` names (everything else maps below). */
const KEYCODE_ALIASES: Record<string, string> = {
  enter: 'KEYCODE_ENTER',
  return: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
  backspace: 'KEYCODE_DEL',
  delete: 'KEYCODE_FORWARD_DEL',
  del: 'KEYCODE_FORWARD_DEL',
  escape: 'KEYCODE_ESCAPE',
  esc: 'KEYCODE_ESCAPE',
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  menu: 'KEYCODE_MENU',
  search: 'KEYCODE_SEARCH',
  up: 'KEYCODE_DPAD_UP',
  arrowup: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  arrowdown: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  arrowleft: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  arrowright: 'KEYCODE_DPAD_RIGHT',
  pageup: 'KEYCODE_PAGE_UP',
  pagedown: 'KEYCODE_PAGE_DOWN',
  control: 'KEYCODE_CTRL_LEFT',
  ctrl: 'KEYCODE_CTRL_LEFT',
  alt: 'KEYCODE_ALT_LEFT',
  option: 'KEYCODE_ALT_LEFT',
  shift: 'KEYCODE_SHIFT_LEFT',
  meta: 'KEYCODE_META_LEFT',
  cmd: 'KEYCODE_META_LEFT',
  command: 'KEYCODE_META_LEFT',
  super: 'KEYCODE_META_LEFT',
  win: 'KEYCODE_META_LEFT',
};

/** Map one key token onto a `KEYCODE_*` name (alias · single letter/digit · verbatim KEYCODE_). */
export function keycodeFor(token: string): string {
  const lower = token.toLowerCase();
  const mapped = KEYCODE_ALIASES[lower];
  if (mapped) return mapped;
  if (/^[a-z]$/.test(lower)) return `KEYCODE_${lower.toUpperCase()}`;
  if (/^[0-9]$/.test(lower)) return `KEYCODE_${lower}`;
  if (/^keycode_[a-z0-9_]+$/i.test(token)) return token.toUpperCase();
  throw new AdapterError(`android: unknown key ${JSON.stringify(token)}`);
}

/**
 * Build the keyevent argv for a contract key/chord. A single key → `input keyevent
 * <KEYCODE>`; a chord (`Control+a`) → `input keycombination <KEYCODE…>` (Android 11+).
 */
export function keyArgs(key: string): string[] {
  const codes = key
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(keycodeFor);
  if (codes.length === 0) throw new AdapterError('pressKey requires a non-empty key');
  return codes.length === 1
    ? ['input', 'keyevent', ...codes]
    : ['input', 'keycombination', ...codes];
}

// --- screen -----------------------------------------------------------------

/**
 * Parse `wm size` output → a full-screen {@link Bounds}. Prefers an `Override size`
 * (the effective resolution) when present, else `Physical size`.
 *   `Physical size: 1080x2400` · `Override size: 720x1280`
 */
export function parseScreenSize(output: string): Bounds {
  const override = /Override size:\s*(\d+)x(\d+)/.exec(output);
  const match = override ?? /(\d+)x(\d+)/.exec(output);
  const width = Number(match?.[1]);
  const height = Number(match?.[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new AdapterError(`android: cannot parse screen size from ${JSON.stringify(output)}`);
  }
  return { x: 0, y: 0, width, height };
}
