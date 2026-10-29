/**
 * Desktop screenshots — try X11, then Wayland when available. Environment hints
 * do not prove compositor protocol support: only a successful capture does.
 * Both routes write temporary PNGs; portal/D-Bus capture remains unimplemented.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError, ExecTimeoutError } from '../../errors.js';
import { desktopEnv, type Exec, errMessage, makeExec } from './proc.js';

/** One shared cap: fallback must not restart the capture budget. */
const CAPTURE_TIMEOUT_MS = 30_000;

export type CaptureTool = 'grim' | 'scrot';

function captureTools(env: NodeJS.ProcessEnv): CaptureTool[] {
  const tools: CaptureTool[] = [];
  if (env.DISPLAY) tools.push('scrot');
  if (env.WAYLAND_DISPLAY) tools.push('grim');
  return tools;
}

function captureFailure(env: NodeJS.ProcessEnv, failures: string[]): AdapterError {
  const hints = ['XDG_CURRENT_DESKTOP', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION']
    .filter((key) => env[key])
    .map((key) => `${key}=${env[key]}`)
    .join(', ');
  return new AdapterError(
    `desktop: screenshot capture infrastructure unavailable (not an application defect; ${hints || 'compositor/desktop unknown'}): ${failures.join('; ')}. ` +
      'grim requires a compositor supporting the Wayland screencopy protocol; portal/D-Bus capture is not implemented.',
  );
}

/** First route to try, not a claim that the display or backend is usable. */
export function chooseCaptureTool(env: NodeJS.ProcessEnv): CaptureTool {
  const tool = captureTools(env)[0];
  if (tool) return tool;
  throw captureFailure(env, [
    'scrot unavailable: DISPLAY is not set',
    'grim unavailable: WAYLAND_DISPLAY is not set',
  ]);
}

/** Build the capture argv that writes a PNG to `file`. */
export function captureArgs(tool: CaptureTool, file: string): string[] {
  switch (tool) {
    case 'grim':
      return [file];
    case 'scrot':
      return ['--overwrite', file];
    default: {
      const unreachable: never = tool;
      throw new AdapterError(`unknown capture tool: ${String(unreachable)}`);
    }
  }
}

/** Screenshot surface the adapter calls — implemented by Screenshot, faked in tests. */
export interface ScreenCapture {
  /** Capture PNG bytes within the absolute epoch-ms deadline (and the local 30s cap). */
  capture(deadline?: number): Promise<Uint8Array>;
}

/** grim/scrot-backed capture with injectable execution and clock for deterministic tests. */
export class Screenshot implements ScreenCapture {
  readonly #env: NodeJS.ProcessEnv;
  readonly #exec: Exec;
  readonly #now: () => number;

  constructor(init: { display?: string; exec?: Exec; now?: () => number } = {}) {
    this.#env = desktopEnv(init.display);
    this.#exec = init.exec ?? makeExec(this.#env, CAPTURE_TIMEOUT_MS);
    this.#now = init.now ?? Date.now;
  }

  async capture(deadline?: number): Promise<Uint8Array> {
    const end = Math.min(deadline ?? Infinity, this.#now() + CAPTURE_TIMEOUT_MS);
    const checkDeadline = () => {
      if (this.#now() >= end) {
        throw new ExecTimeoutError(`desktop: screenshot capture at/after its deadline (${end})`);
      }
    };
    const failures: string[] = [];
    if (!this.#env.DISPLAY) failures.push('scrot unavailable: DISPLAY is not set');
    if (!this.#env.WAYLAND_DISPLAY) failures.push('grim unavailable: WAYLAND_DISPLAY is not set');
    const tools = captureTools(this.#env);
    if (!tools.length) throw captureFailure(this.#env, failures);
    checkDeadline();
    const dir = await mkdtemp(join(tmpdir(), 'uidbg-shot-'));
    try {
      for (const tool of tools) {
        checkDeadline();
        // Separate files prevent a failed route's partial output becoming fallback evidence.
        const file = join(dir, `${tool}.png`);
        try {
          await this.#exec(tool, captureArgs(tool, file), { deadline: end });
          checkDeadline();
          const buffer = await readFile(file);
          checkDeadline();
          return new Uint8Array(buffer);
        } catch (error) {
          if (error instanceof ExecTimeoutError) throw error;
          checkDeadline();
          failures.push(`${tool} failed: ${errMessage(error)}`);
        }
      }
      throw captureFailure(this.#env, failures);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
