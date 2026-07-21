/**
 * Desktop input — synthesize pointer/keyboard/scroll via **xdotool** (X11/XWayland).
 *
 * The chosen, proven path for a container/Xvfb default (what Anthropic Computer
 * Use, OSWorld, et al. use — see `idea/desktop-control.md`). xdotool needs screen
 * coordinates, which the adapter feeds from AT-SPI `Component.GetExtents(SCREEN)`
 * (or a Node's `bounds`). Native-Wayland injection (libei/ydotool) is future work.
 *
 * The pure builders here (key-chord mapping, scroll-button mapping, arg arrays)
 * carry the real logic and are unit-tested without spawning; {@link Xdotool} is
 * the thin runner that shells out and fails loud as an {@link AdapterError}.
 */

import { AdapterError } from '../../errors.js';
import type { Bounds, Node, ScrollDirection } from '../contract.js';
import { desktopEnv, type Exec, errMessage, isEnoent, makeExec } from './proc.js';

const XDOTOOL = 'xdotool';

/** Poll interval (ms) while waiting for a target window to appear. */
const POLL_MS = 150;

/** Contract modifier tokens → xdotool keysym modifiers (chords split on `+`). */
const MOD_ALIASES: Record<string, string> = {
  control: 'ctrl',
  ctrl: 'ctrl',
  cmd: 'super',
  command: 'super',
  meta: 'super',
  super: 'super',
  win: 'super',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
};

/** Contract named keys → xdotool keysyms (everything else passes through verbatim). */
const KEY_ALIASES: Record<string, string> = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'BackSpace',
  delete: 'Delete',
  del: 'Delete',
  space: 'space',
  up: 'Up',
  down: 'Down',
  left: 'Left',
  right: 'Right',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  home: 'Home',
  end: 'End',
  pageup: 'Prior',
  pagedown: 'Next',
};

/** Map one chord token onto an xdotool keysym (modifier, named key, or verbatim keysym). */
function mapKeyToken(token: string): string {
  const lower = token.toLowerCase();
  return MOD_ALIASES[lower] ?? KEY_ALIASES[lower] ?? token;
}

/**
 * Map a contract key/chord (`'Enter'`, `'Control+a'`, `'Escape'`) onto an
 * xdotool keysym chord (`'Return'`, `'ctrl+a'`, `'Escape'`). Throws on an empty key.
 */
export function mapKeyChord(key: string): string {
  const parts = key
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    throw new AdapterError('pressKey requires a non-empty key');
  }
  return parts.map(mapKeyToken).join('+');
}

/** Map a {@link ScrollDirection} onto its X11 wheel button (4 up · 5 down · 6 left · 7 right). */
export function scrollButton(direction: ScrollDirection): number {
  switch (direction) {
    case 'up':
      return 4;
    case 'down':
      return 5;
    case 'left':
      return 6;
    case 'right':
      return 7;
    default: {
      const unreachable: never = direction;
      throw new AdapterError(`unknown scroll direction: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The integer screen-pixel center of a {@link Bounds} — where a click/scroll lands. */
export function centerOf(bounds: Bounds): { x: number; y: number } {
  return {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
}

/**
 * The on-screen rectangle of a {@link Node}, or a loud failure when it has none.
 *
 * AT-SPI nodes that expose no `Component` (app roots, toolkit fillers) carry
 * placeholder zero bounds (`atspi.ts` marks them `measured: false`), and a real
 * widget reports `0x0` until it is laid out. Either way the "center" is the screen
 * origin — clicking it would hit the top-left of the desktop and read as success.
 * (The android adapter applies the same rule in `tapPointOf`.)
 */
export function expectOnScreen(node: Node): Bounds {
  const { width, height } = node.bounds;
  if (width <= 0 || height <= 0) {
    const label = node.name === '' ? node.role : `${node.role} "${node.name}"`;
    throw new AdapterError(
      `desktop: ${label} has zero size (${width}x${height}) — it is not on screen ` +
        '(no AT-SPI Component, or not laid out yet); wait for it to render or scroll it ' +
        'into view, then re-read its bounds',
    );
  }
  return node.bounds;
}

/** Where a `click`/`type` lands on a {@link Node} — its center, zero-size guarded. */
export function clickPointOf(node: Node): { x: number; y: number } {
  return centerOf(expectOnScreen(node));
}

/** `mousemove --sync x y click <button>` — move then click in one synced invocation. */
export function clickArgs(x: number, y: number, button = 1): string[] {
  return ['mousemove', '--sync', String(x), String(y), 'click', String(button)];
}

/** `mousemove --sync x y` — park the cursor (used to scope a scroll to a region). */
export function moveArgs(x: number, y: number): string[] {
  return ['mousemove', '--sync', String(x), String(y)];
}

/** `type --clearmodifiers -- <text>` — `--` guards text that starts with a dash. */
export function typeArgs(text: string): string[] {
  return ['type', '--clearmodifiers', '--', text];
}

/** `key --clearmodifiers <chord>` — press a mapped key/chord on the focused element. */
export function keyArgs(chord: string): string[] {
  return ['key', '--clearmodifiers', mapKeyChord(chord)];
}

/** `click --repeat <n> <wheel-button>` — N wheel steps in one direction. */
export function scrollArgs(direction: ScrollDirection, repeat: number): string[] {
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new AdapterError('scroll `repeat` must be a positive integer');
  }
  return ['click', '--repeat', String(repeat), String(scrollButton(direction))];
}

/** WM properties used to find the window to drive (X11: WM_NAME / WM_CLASS). */
export interface WindowMatch {
  title?: string;
  class?: string;
}

/** `search --onlyvisible (--name|--class) <value>` — locate the window to activate. */
export function searchArgs(match: WindowMatch): string[] {
  if (match.title) return ['search', '--onlyvisible', '--name', match.title];
  if (match.class) return ['search', '--onlyvisible', '--class', match.class];
  throw new AdapterError('window match requires `title` or `class`');
}

/** Pointer/keyboard surface the adapter drives — implemented by {@link Xdotool}, faked in tests. */
export interface PointerInput {
  clickPoint(x: number, y: number): Promise<void>;
  move(x: number, y: number): Promise<void>;
  typeText(text: string): Promise<void>;
  key(chord: string): Promise<void>;
  scroll(direction: ScrollDirection, repeat: number): Promise<void>;
  activateWindow(match: WindowMatch, timeoutMs: number): Promise<void>;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** xdotool-backed {@link PointerInput}. Construct with a target `display` (or inject `exec` for tests). */
export class Xdotool implements PointerInput {
  readonly #exec: Exec;

  constructor(init: { display?: string; exec?: Exec } = {}) {
    this.#exec = init.exec ?? makeExec(desktopEnv(init.display));
  }

  clickPoint(x: number, y: number): Promise<void> {
    return this.#do(clickArgs(x, y));
  }

  move(x: number, y: number): Promise<void> {
    return this.#do(moveArgs(x, y));
  }

  typeText(text: string): Promise<void> {
    return this.#do(typeArgs(text));
  }

  key(chord: string): Promise<void> {
    return this.#do(keyArgs(chord));
  }

  scroll(direction: ScrollDirection, repeat: number): Promise<void> {
    return this.#do(scrollArgs(direction, repeat));
  }

  /** Poll `search` until the window exists, then `windowactivate --sync`; throw loud on timeout. */
  async activateWindow(match: WindowMatch, timeoutMs: number): Promise<void> {
    const args = searchArgs(match);
    const start = Date.now();
    for (;;) {
      // `search` exits non-zero with EMPTY stderr when nothing matches (→ rejects);
      // that means "not up yet", so keep polling. Anything on stderr is a real
      // failure (e.g. `Can't open display`) — fatal, loud. Missing xdotool too.
      const out = await this.#exec(XDOTOOL, args).catch((error: unknown) => {
        if (isEnoent(error)) {
          throw new AdapterError('desktop: `xdotool` not found on PATH (install xdotool)');
        }
        const stderr = (error as { stderr?: unknown }).stderr;
        const detail = typeof stderr === 'string' ? stderr.trim() : '';
        if (detail !== '') {
          throw new AdapterError(`xdotool search failed: ${detail}`);
        }
        return '';
      });
      const id = out
        .split('\n')
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      if (id) {
        await this.#do(['windowactivate', '--sync', id]);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        throw new AdapterError(
          `desktop: window not found within ${timeoutMs}ms (${JSON.stringify(match)})`,
        );
      }
      await delay(POLL_MS);
    }
  }

  /** Run one xdotool invocation, re-throwing any failure as a loud {@link AdapterError}. */
  async #do(args: string[]): Promise<void> {
    try {
      await this.#exec(XDOTOOL, args);
    } catch (error) {
      if (isEnoent(error)) {
        throw new AdapterError('desktop: `xdotool` not found on PATH (install xdotool)');
      }
      throw new AdapterError(`xdotool ${args[0] ?? ''} failed: ${errMessage(error)}`);
    }
  }
}
