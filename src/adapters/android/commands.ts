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
import type { Bounds, Node, ScrollDirection } from '../contract.js';

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

/**
 * Where a `click`/`type` tap lands on a {@link Node} — its center, zero-size guarded.
 *
 * uiautomator reports detached, collapsed or not-yet-laid-out views as `[0,0][0,0]`,
 * whose "center" is the screen origin: the tap would land on the status bar / back
 * gesture and the run would read as a successful click on the wrong thing. Fail loud
 * instead (the desktop adapter applies the same rule to bounds-less AT-SPI nodes).
 */
export function tapPointOf(node: Node): { x: number; y: number } {
  const { width, height } = node.bounds;
  if (width <= 0 || height <= 0) {
    const label = node.name === '' ? node.role : `${node.role} "${node.name}"`;
    throw new AdapterError(
      `android: ${label} has zero size (${width}x${height}) — it is not visible on screen; ` +
        'wait for it to render or scroll it into view, then re-read its bounds',
    );
  }
  return centerOf(node.bounds);
}

// --- launch -----------------------------------------------------------------

/**
 * A launch target: a package (`com.example`) or a component (`com.example/.MainActivity`).
 * Agent-supplied, and adb joins argv into one **device-shell** string — so anything
 * outside package/class syntax (`;`, spaces, `$(…)`) would run as a shell command.
 */
const LAUNCH_TARGET = /^[\w.]+(\/[\w.$]+)?$/;

/**
 * Build the `open` launch command. A component (`pkg/.Activity`) starts that activity
 * directly (`am start -W`); a bare package launches its default activity via `monkey`.
 * Rejects anything that isn't {@link LAUNCH_TARGET} — never escapes-and-hopes.
 */
export function startArgs(target: string): string[] {
  const t = target.trim();
  if (t === '') {
    throw new AdapterError(
      'android open requires an activity component (pkg/.Activity) or a package',
    );
  }
  if (!LAUNCH_TARGET.test(t)) {
    throw new AdapterError(
      `android open target ${JSON.stringify(target)} is not a package or component — expected pkg.name or pkg.name/.Activity`,
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
 * Chars mksh treats specially — backslash-escaped so they reach the app verbatim.
 * `#` starts a comment and `{`/`}` brace-expand, so they need it too: an unescaped
 * leading `#` silently types nothing. `?[]` glob, `!` is history, `^`/`=` are legacy
 * pipe/assignment forms — escaping them costs nothing and closes the guesswork.
 */
const SHELL_SPECIAL = '()<>|;&*\\~"\'`$#{}?[]!^=';

/**
 * Escape text for `input text` on the device shell: spaces → `%s` (the tool's own
 * space token), {@link SHELL_SPECIAL} chars backslash-escaped.
 *
 * Control chars (< 0x20) are **rejected**, not escaped: adb joins argv into one
 * device-shell string, where a raw `\n` ends the `input text` command and runs the
 * rest as a shell command. They can't be typed anyway — the adapter turns line
 * breaks into `KEYCODE_ENTER` presses; other control chars belong to `pressKey`.
 */
export function escapeInputText(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20) {
      throw new AdapterError(
        `android type: control character ${JSON.stringify(ch)} cannot be typed — use pressKey (e.g. 'enter', 'tab')`,
      );
    }
    if (ch === ' ') out += '%s';
    else if (SHELL_SPECIAL.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}

/**
 * Split `type` text on its line breaks (`\n`, `\r\n`, `\r`). The adapter types each
 * line and presses `KEYCODE_ENTER` between them, so a newline behaves like a real
 * keyboard instead of reaching the device shell. Line breaks are the one control
 * char with an obvious keyboard meaning; the rest throw in {@link escapeInputText}.
 */
export function splitTextLines(text: string): string[] {
  return text.split(/\r\n|[\n\r]/);
}

/**
 * Split raw text into chunks safe for consecutive `input text` calls: the on-device
 * tool replaces every literal `%s` with a space (its own space token), so a `%s` in
 * user text would be silently mangled. Breaking the text between the `%` and the `s`
 * keeps each chunk substitution-free; sequential calls append into the focused field.
 */
export function splitTextForInput(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  for (let cut = text.indexOf('%s', start); cut !== -1; cut = text.indexOf('%s', start)) {
    chunks.push(text.slice(start, cut + 1)); // keep the '%', break before the 's'
    start = cut + 1;
  }
  chunks.push(text.slice(start));
  return chunks.filter((chunk) => chunk !== '');
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
  f1: 'KEYCODE_F1',
  f2: 'KEYCODE_F2',
  f3: 'KEYCODE_F3',
  f4: 'KEYCODE_F4',
  f5: 'KEYCODE_F5',
  f6: 'KEYCODE_F6',
  f7: 'KEYCODE_F7',
  f8: 'KEYCODE_F8',
  f9: 'KEYCODE_F9',
  f10: 'KEYCODE_F10',
  f11: 'KEYCODE_F11',
  f12: 'KEYCODE_F12',
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
