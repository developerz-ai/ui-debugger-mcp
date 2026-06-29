/**
 * Subprocess + environment plumbing shared by the desktop adapter's CLI tools
 * (`xdotool`, `scrot`/`grim`, `busctl`).
 *
 * The desktop adapter drives the target by shelling out — there is no in-process
 * SDK like CDP. Every tool runs on a chosen X11 `DISPLAY` (e.g. `:99` for an Xvfb
 * container), so {@link desktopEnv} threads that through. {@link makeExec} is the
 * one I/O seam: production binds the real `execFile`, tests inject a fake to drive
 * the pure orchestration without spawning anything.
 *
 * Fails loud — a non-zero exit rejects through `execFile`, and callers re-wrap it
 * as an {@link AdapterError}; never a silent fallback.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

/** 16 MiB stdout cap — busctl JSON is small; the screenshots route through a file. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** Run a CLI tool, resolve its stdout, reject (loud) on a non-zero exit or a missing binary. */
export type Exec = (cmd: string, args: string[]) => Promise<string>;

/** A child env with `DISPLAY` overridden when a target display is configured (else inherit). */
export function desktopEnv(display?: string): NodeJS.ProcessEnv {
  return display ? { ...process.env, DISPLAY: display } : { ...process.env };
}

/** The real {@link Exec}: `execFile` bound to a fixed child env. */
export function makeExec(env: NodeJS.ProcessEnv): Exec {
  return async (cmd, args) => {
    const { stdout } = await pExecFile(cmd, args, { env, maxBuffer: MAX_BUFFER });
    return stdout;
  };
}

/** True when an error is a "binary not found on PATH" (`ENOENT`) — for a clear, loud message. */
export function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** Compact message extractor for wrapping a thrown subprocess error. */
export function errMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
