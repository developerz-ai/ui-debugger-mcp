/**
 * Workspace path resolver and directory bootstrapper.
 * Derives project name from cwd basename; builds and creates all required paths.
 */

import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

// --- ID generator -----------------------------------------------------------
// Counter+injected-time avoids both Date.now-only collisions and non-determinism in tests.

let _counter = 0;

/** Reset internal counter — testing only. */
export function _resetCounter(): void {
  _counter = 0;
}

/** Zero-pad a number to `width` digits. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/**
 * Generate a session ID: `YYYY-MM-DD_HH-MM-SS-<0000-padded counter>`, e.g.
 * `2026-07-27_14-30-05-0001`.
 *
 * The id IS the session directory name, so a human listing
 * `sessions/` reads *when* each run happened instead of decoding an epoch. Local
 * time, deliberately — the reader is sitting at the machine that ran it.
 *
 * Fixed-width and zero-padded on purpose: byte order == chronological order, which
 * is what {@link pruneSessions} sorts by to decide which runs are the newest. (A
 * DST fall-back hour can invert one pair; the only consequence is which of two
 * same-hour runs is pruned first.)
 *
 * @param now - injected epoch ms (e.g. Date.now() from the caller)
 */
export function generateSessionId(now: number): string {
  _counter = (_counter + 1) % 10_000;
  const d = new Date(now);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
  return `${date}_${time}-${pad(_counter, 4)}`;
}

// --- Path types -------------------------------------------------------------

export interface WorkspacePaths {
  /** `<base>/<project>/` */
  root: string;
  /** `<root>/chrome-user-data/` */
  chromeUserData: string;
  /** `<root>/sessions/` */
  sessions: string;
  /** `<root>/state.json` */
  stateJson: string;
}

export interface SessionPaths {
  /** `<sessions>/<id>/` */
  root: string;
  /** `<root>/story.md` */
  storyMd: string;
  /** `<root>/screenshots/` */
  screenshots: string;
  /** `<root>/replay.mp4` — ordered screenshots stitched into a captioned video. */
  replayMp4: string;
  /** `<root>/findings.json` */
  findingsJson: string;
  /** `<root>/logs/` */
  logs: string;
}

// --- Path builders ----------------------------------------------------------

/** Derive the project slug from an absolute cwd path. */
export function resolveProject(cwd: string): string {
  return basename(cwd);
}

/**
 * The project's own directory inside the workspace base.
 *
 * A base that lives *under* the project root is already unique to this cwd — the
 * default `./tmp/ui-debugger-mcp` and any relative `workspace` resolve there — so
 * the plain project name stands and existing installs keep their chrome profile
 * and session history. A base pointed somewhere shared (an absolute `workspace`)
 * is NOT unique: `~/work/api` and `~/oss/api` would otherwise share one
 * `state.json`, one `chrome-user-data/` and one profile lock, so a live run in
 * either would falsely report the other busy. Those get a short, stable hash of
 * the full cwd appended.
 */
function projectDir(cwd: string, base: string): string {
  const name = resolveProject(cwd);
  const rel = relative(cwd, base);
  const nested = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (nested) return name;
  return `${name}-${createHash('sha256').update(cwd).digest('hex').slice(0, 8)}`;
}

/**
 * Build workspace paths for a project.
 * @param cwd  - absolute path to the project root (session key)
 * @param base - override the workspace root, absolute or relative to `cwd`
 *               (default: `<cwd>/tmp/ui-debugger-mcp`)
 */
export function workspacePaths(cwd: string, base?: string): WorkspacePaths {
  // A relative base is anchored at the project root — the same resolution the CLI
  // does before it reads `state.json`, so both processes land on one workspace.
  const resolvedBase =
    base === undefined ? join(cwd, 'tmp', 'ui-debugger-mcp') : resolve(cwd, base);
  const root = join(resolvedBase, projectDir(cwd, resolvedBase));
  return {
    root,
    chromeUserData: join(root, 'chrome-user-data'),
    sessions: join(root, 'sessions'),
    stateJson: join(root, 'state.json'),
  };
}

/**
 * Resolve the managed browser's persistent-profile dir for a run.
 *
 * A web target's `profile` names a dir under the workspace root (an absolute path
 * is honored as-is); unset falls back to the default `chrome-user-data/`. Attach
 * mode (`cdpUrl`) never uses this — that browser keeps its own profile.
 *
 * @param workspace - result of `workspacePaths()`
 * @param profile   - the web target's `profile` key, if set
 */
export function resolveProfileDir(workspace: WorkspacePaths, profile?: string): string {
  return profile ? resolve(workspace.root, profile) : workspace.chromeUserData;
}

/**
 * Build session-specific paths inside a workspace.
 * @param workspace - result of `workspacePaths()`
 * @param id        - session ID (from `generateSessionId()`)
 */
export function sessionPaths(workspace: WorkspacePaths, id: string): SessionPaths {
  const root = join(workspace.sessions, id);
  return {
    root,
    storyMd: join(root, 'story.md'),
    screenshots: join(root, 'screenshots'),
    replayMp4: join(root, 'replay.mp4'),
    findingsJson: join(root, 'findings.json'),
    logs: join(root, 'logs'),
  };
}

// --- Directory creation -----------------------------------------------------

/**
 * Ensure the project workspace directories exist.
 * Creates `chrome-user-data/` and `sessions/` (mkdir -p).
 */
export async function ensureWorkspace(paths: WorkspacePaths): Promise<void> {
  await mkdir(paths.chromeUserData, { recursive: true });
  await mkdir(paths.sessions, { recursive: true });
}

/**
 * Ensure a session's directories exist.
 * Creates `screenshots/` and `logs/` (mkdir -p).
 */
export async function ensureSession(paths: SessionPaths): Promise<void> {
  await mkdir(paths.screenshots, { recursive: true });
  await mkdir(paths.logs, { recursive: true });
}
