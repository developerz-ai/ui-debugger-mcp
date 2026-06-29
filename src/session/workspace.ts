/**
 * Workspace path resolver and directory bootstrapper.
 * Derives project name from cwd basename; builds and creates all required paths.
 */

import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';

// --- ID generator -----------------------------------------------------------
// Counter+injected-time avoids both Date.now-only collisions and non-determinism in tests.

let _counter = 0;

/** Reset internal counter — testing only. */
export function _resetCounter(): void {
  _counter = 0;
}

/**
 * Generate a session ID.
 * @param now  - injected epoch ms (e.g. Date.now() from the caller)
 * Returns `<now>-<0000-padded counter>`, e.g. `1751234567890-0001`.
 */
export function generateSessionId(now: number): string {
  _counter = (_counter + 1) % 10_000;
  return `${now}-${String(_counter).padStart(4, '0')}`;
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
 * Build workspace paths for a project.
 * @param cwd  - absolute path to the project root (session key)
 * @param base - override the workspace root (default: `<cwd>/tmp/ui-debugger-mcp`)
 */
export function workspacePaths(cwd: string, base?: string): WorkspacePaths {
  const root = join(base ?? join(cwd, 'tmp', 'ui-debugger-mcp'), resolveProject(cwd));
  return {
    root,
    chromeUserData: join(root, 'chrome-user-data'),
    sessions: join(root, 'sessions'),
    stateJson: join(root, 'state.json'),
  };
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
