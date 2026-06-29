/**
 * Desktop adapter — drives a native Linux app behind the shared {@link Adapter}
 * contract, so the agent loop stays adapter-blind.
 *
 * Composition (split per SRP — see siblings):
 *   - read   → {@link AtspiSource} (AT-SPI2 a11y tree over D-Bus, `atspi.ts`)
 *   - input  → {@link PointerInput} (xdotool, X11/XWayland, `input.ts`)
 *   - capture→ {@link ScreenCapture} (scrot/grim per compositor, `capture.ts`)
 *
 * **Managed only**: the desktop target has no attach handle (unlike web `cdpUrl` /
 * android `adbSerial`), so `open` launches the configured command and `close` stops
 * it. Reads/clicks key off AT-SPI screen extents; vision fallback is future work.
 *
 * Desktop apps expose no console/network channels — those methods throw loud
 * ({@link AdapterError}), never a silent empty list. Every backend failure surfaces
 * as an {@link AdapterError}; our own loud errors pass through un-rewrapped.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import type { DesktopTarget } from '../../config/schema.js';
import { AdapterError, UiDebuggerError } from '../../errors.js';
import type {
  Adapter,
  Bounds,
  ConsoleEntry,
  NetworkEntry,
  Node,
  NodeRef,
  Query,
  ScrollOptions,
  WaitOptions,
} from '../contract.js';
import { type AtspiSource, BusctlAtspi, shapeNodes } from './atspi.js';
import { type ScreenCapture, Screenshot } from './capture.js';
import { centerOf, type PointerInput, type WindowMatch, Xdotool } from './input.js';
import { desktopEnv } from './proc.js';

/** Default cap on `readState` so the tree stays small (overridable via `limit`). */
const DEFAULT_LIMIT = 200;

/** `waitFor` defaults — poll the a11y tree for a query until it appears or times out. */
const DEFAULT_WAIT_MS = 5000;
const POLL_MS = 200;

/** How long `open` waits for the launched window to appear before failing loud. */
const WINDOW_WAIT_MS = 10_000;

/** Wheel-step calibration: pixels-per-click, and the default page-ish distance. */
const SCROLL_STEP_PX = 120;
const DEFAULT_SCROLL_AMOUNT = 360;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Map a pixel scroll `amount` onto a positive integer count of wheel clicks. */
export function scrollRepeat(amount?: number): number {
  return Math.max(1, Math.round((amount ?? DEFAULT_SCROLL_AMOUNT) / SCROLL_STEP_PX));
}

interface DesktopAdapterHandles {
  config: DesktopTarget;
  env: NodeJS.ProcessEnv;
  atspi: AtspiSource;
  input: PointerInput;
  capture: ScreenCapture;
}

export interface DesktopAdapterInit {
  /** Resolved desktop-target config (launch command, window match, display). */
  config: DesktopTarget;
  /** Override the AT-SPI read backend (defaults to {@link BusctlAtspi}); a seam for tests. */
  atspi?: AtspiSource;
  /** Override the input backend (defaults to {@link Xdotool}); a seam for tests. */
  input?: PointerInput;
  /** Override the capture backend (defaults to {@link Screenshot}); a seam for tests. */
  capture?: ScreenCapture;
}

/**
 * The desktop {@link Adapter}: an xdotool + AT-SPI2 + scrot/grim trio behind one
 * contract. Construct via {@link DesktopAdapter.create}.
 */
export class DesktopAdapter implements Adapter {
  readonly #config: DesktopTarget;
  readonly #env: NodeJS.ProcessEnv;
  readonly #atspi: AtspiSource;
  readonly #input: PointerInput;
  readonly #capture: ScreenCapture;
  #process: ChildProcess | null = null;

  private constructor(handles: DesktopAdapterHandles) {
    this.#config = handles.config;
    this.#env = handles.env;
    this.#atspi = handles.atspi;
    this.#input = handles.input;
    this.#capture = handles.capture;
  }

  /** Wire the adapter from config, binding each backend to the chosen X11 display. */
  static create(init: DesktopAdapterInit): DesktopAdapter {
    const display = init.config.display ?? undefined;
    return new DesktopAdapter({
      config: init.config,
      env: desktopEnv(display),
      atspi: init.atspi ?? new BusctlAtspi({ display }),
      input: init.input ?? new Xdotool({ display }),
      capture: init.capture ?? new Screenshot({ display }),
    });
  }

  /** Launch the managed app (once) and activate the target window. `target` is a title fallback. */
  async open(target: string): Promise<void> {
    await this.#run('open', async () => {
      if (!this.#process) {
        this.#process = spawn('/bin/sh', ['-c', this.#config.launch], {
          env: this.#env,
          detached: true,
          stdio: 'ignore',
        });
      }
      const match = this.#windowMatch(target);
      if (match) await this.#input.activateWindow(match, WINDOW_WAIT_MS);
    });
  }

  async find(opts: Query): Promise<Node | null> {
    return this.#run('find', async () => {
      const nodes = await this.readState({ ...opts, limit: 1 });
      return nodes[0] ?? null;
    });
  }

  async readState(opts: Query = {}): Promise<Node[]> {
    return this.#run('readState', async () => {
      const region = opts.within !== undefined ? await this.#regionBounds(opts.within) : undefined;
      const nodes = await this.#atspi.readTree();
      return shapeNodes(nodes, opts, DEFAULT_LIMIT, region);
    });
  }

  async click(target: NodeRef): Promise<void> {
    await this.#run('click', async () => {
      const { x, y } = centerOf((await this.#resolve(target)).bounds);
      await this.#input.clickPoint(x, y);
    });
  }

  async type(target: NodeRef, text: string): Promise<void> {
    // Contract: focus the target first, then type. Click its center to focus.
    await this.#run('type', async () => {
      const { x, y } = centerOf((await this.#resolve(target)).bounds);
      await this.#input.clickPoint(x, y);
      await this.#input.typeText(text);
    });
  }

  async pressKey(key: string): Promise<void> {
    if (key.trim() === '') {
      throw new AdapterError('pressKey requires a non-empty key');
    }
    await this.#run('pressKey', () => this.#input.key(key));
  }

  async scroll(opts: ScrollOptions): Promise<void> {
    await this.#run('scroll', async () => {
      // Scope: park the cursor over the region first so the wheel targets it.
      if (opts.within !== undefined) {
        const { x, y } = centerOf(await this.#regionBounds(opts.within));
        await this.#input.move(x, y);
      }
      await this.#input.scroll(opts.direction, scrollRepeat(opts.amount));
    });
  }

  async screenshot(): Promise<Uint8Array> {
    return this.#run('screenshot', () => this.#capture.capture());
  }

  async waitFor(opts: WaitOptions): Promise<void> {
    if (opts.networkIdle) {
      throw new AdapterError('desktop: `networkIdle` wait is unsupported (no network channel)');
    }
    const query = opts.query;
    if (!query) {
      throw new AdapterError('waitFor requires `query` (desktop has no networkIdle)');
    }
    const timeout = opts.timeout ?? DEFAULT_WAIT_MS;
    await this.#run('waitFor', async () => {
      const start = Date.now();
      for (;;) {
        if (await this.find({ query })) return;
        if (Date.now() - start >= timeout) {
          throw new AdapterError(`desktop: waitFor timed out after ${timeout}ms (${query})`);
        }
        await delay(POLL_MS);
      }
    });
  }

  /** Desktop apps expose no console channel — unsupported, surfaced loud. */
  async console(): Promise<ConsoleEntry[]> {
    throw new AdapterError('desktop target has no console channel (unsupported)');
  }

  /** Desktop apps expose no network channel — unsupported, surfaced loud. */
  async network(): Promise<NetworkEntry[]> {
    throw new AdapterError('desktop target has no network channel (unsupported)');
  }

  /** Managed teardown: SIGTERM the launched process group; an already-dead process is a no-op. */
  async close(): Promise<void> {
    const pid = this.#process?.pid;
    this.#process = null;
    if (pid === undefined) return;
    await this.#run('close', async () => {
      try {
        // Negative pid → the whole detached group (the shell + the app it spawned).
        process.kill(-pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    });
  }

  /** Resolve a {@link NodeRef} to a concrete {@link Node}, re-querying a selector. */
  async #resolve(target: NodeRef): Promise<Node> {
    if (typeof target !== 'string') return target;
    const node = await this.find({ query: target });
    if (!node) {
      throw new AdapterError(`desktop: no element matched query ${JSON.stringify(target)}`);
    }
    return node;
  }

  /** Resolve a scope `within` (a {@link Node} or a selector) to an on-screen rectangle. */
  async #regionBounds(within: NodeRef): Promise<Bounds> {
    if (typeof within !== 'string') return within.bounds;
    const node = await this.find({ query: within });
    if (!node) throw new AdapterError(`desktop: \`within\` target not found: ${within}`);
    return node.bounds;
  }

  /** Pick the window to drive: configured match wins, else a non-empty `open` title fallback. */
  #windowMatch(target: string): WindowMatch | null {
    const configured = this.#config.window;
    if (configured && (configured.title || configured.class)) return configured;
    if (target.trim() !== '') return { title: target };
    return null;
  }

  /** Run a backend call, re-throwing as a loud {@link AdapterError} (our own errors pass through). */
  async #run<T>(op: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof UiDebuggerError) throw error;
      throw new AdapterError(
        `desktop.${op} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
