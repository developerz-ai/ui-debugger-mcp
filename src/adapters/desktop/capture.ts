/**
 * Desktop screenshots — compositor-aware capture to PNG bytes.
 *
 * There is no universal Linux screen-capture API: naive X11 grabbers return BLACK
 * on Wayland (`idea/desktop-control.md`). So detect the session and dispatch —
 * **grim** on wlroots/Wayland, **scrot** on X11. Both write a temp PNG we read and
 * delete, keeping one uniform path. GNOME/KDE D-Bus + portal routes are future work.
 *
 * The picker + arg builders are pure and unit-tested; {@link Screenshot} is the
 * thin runner that shells out and fails loud as an {@link AdapterError}.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AdapterError } from '../../errors.js';
import { desktopEnv, type Exec, errMessage, makeExec } from './proc.js';

/** Capture backends we dispatch to, chosen by the live session type. */
export type CaptureTool = 'grim' | 'scrot';

/**
 * Pick the capture tool from the environment: Wayland (`WAYLAND_DISPLAY`) → grim,
 * X11 (`DISPLAY`) → scrot. Throws loud when neither is set — there is nothing to capture.
 */
export function chooseCaptureTool(env: NodeJS.ProcessEnv): CaptureTool {
  if (env.WAYLAND_DISPLAY) return 'grim';
  if (env.DISPLAY) return 'scrot';
  throw new AdapterError('desktop: cannot screenshot — neither WAYLAND_DISPLAY nor DISPLAY is set');
}

/** Build the capture argv that writes a PNG to `file` (grim: positional · scrot: `--overwrite`). */
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

/** Screenshot surface the adapter calls — implemented by {@link Screenshot}, faked in tests. */
export interface ScreenCapture {
  capture(): Promise<Uint8Array>;
}

/** grim/scrot-backed {@link ScreenCapture}. Construct with a target `display` (or inject `exec`). */
export class Screenshot implements ScreenCapture {
  readonly #env: NodeJS.ProcessEnv;
  readonly #exec: Exec;

  constructor(init: { display?: string; exec?: Exec } = {}) {
    this.#env = desktopEnv(init.display);
    this.#exec = init.exec ?? makeExec(this.#env);
  }

  /** Capture the current frame as PNG bytes via a temp file (read then deleted). */
  async capture(): Promise<Uint8Array> {
    const tool = chooseCaptureTool(this.#env);
    const dir = await mkdtemp(join(tmpdir(), 'uidbg-shot-'));
    const file = join(dir, 'shot.png');
    try {
      await this.#exec(tool, captureArgs(tool, file));
      const buffer = await readFile(file);
      return new Uint8Array(buffer);
    } catch (error) {
      throw new AdapterError(`desktop.screenshot failed (${tool}): ${errMessage(error)}`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
