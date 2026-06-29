/**
 * `ui-debugger-mcp status` / `stop` — quick out-of-band run control.
 *
 * The live run lives in the server process's memory; these subcommands run in a
 * *separate* process, so they work off the `state.json` breadcrumb the server
 * drops (see {@link FileStatePort}) plus the session's `findings.json`:
 *
 *  - `status` — print which run is active, whether the server is still alive, the
 *    current verdict, and finding counts. Read-only.
 *  - `stop`   — signal the recorded server pid (SIGTERM) for a graceful teardown
 *    (the server ends the run, frees the profile, exits) and mark the state
 *    `stopped`. No live server → just mark it stopped.
 *
 * Neither needs the model API key — they resolve only the workspace dir.
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { loadWorkspaceDir } from '../config/load.js';
import { FindingsSchema } from '../findings/schema.js';
import { markStatus, readState, type StateFile } from '../session/state-file.js';
import { resolveProject, workspacePaths } from '../session/workspace.js';

/** Whether `pid` is a live process this user can see (`kill(pid, 0)`). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = the process exists but is owned by another user — still "alive".
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read + validate a session's `findings.json`; `null` when absent/malformed. */
async function readFindings(sessionDir: string) {
  try {
    const raw = await readFile(join(sessionDir, 'findings.json'), 'utf8');
    const parsed = FindingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Resolve `state.json` for the current project (no API key needed). */
function stateJsonPath(cwd = process.cwd()): { project: string; stateJson: string } {
  // A relative workspace is anchored at the project root (cwd), matching the server.
  const base = loadWorkspaceDir(cwd);
  const workspace = workspacePaths(cwd, isAbsolute(base) ? base : join(cwd, base));
  return { project: resolveProject(cwd), stateJson: workspace.stateJson };
}

/** `ui-debugger-mcp status` — print the active run's state + findings summary. */
export async function runStatus(cwd = process.cwd()): Promise<void> {
  const { project, stateJson } = stateJsonPath(cwd);
  const state = await readState(stateJson);
  if (!state) {
    console.log(`ui-debugger-mcp: no debug run recorded for '${project}'.`);
    return;
  }

  const alive = isAlive(state.pid);
  const findings = await readFindings(state.sessionDir);
  // Server up + nothing settled yet → trust findings' live status; else the recorded terminal.
  const verdict =
    alive && state.status === 'running' ? (findings?.status ?? 'running') : state.status;
  const counts = findings
    ? `${findings.bugs.length} bugs, ${findings.visual.length} visual, ${findings.steps.length} steps`
    : 'no findings yet';

  console.log(`ui-debugger-mcp — ${project}`);
  console.log(`  run:      ${state.sessionId}`);
  console.log(`  target:   ${state.target}`);
  console.log(`  goal:     ${truncate(state.goal, 72)}`);
  console.log(`  server:   pid ${state.pid} — ${alive ? 'running' : 'not running'}`);
  console.log(`  status:   ${verdict}`);
  console.log(`  findings: ${counts}`);
  console.log(`  started:  ${state.startedAt}`);
  console.log(`  session:  ${state.sessionDir}`);
}

/** `ui-debugger-mcp stop` — signal the server to tear the run down, mark state stopped. */
export async function runStop(cwd = process.cwd()): Promise<void> {
  const { project, stateJson } = stateJsonPath(cwd);
  const state = await readState(stateJson);
  if (!state) {
    console.log(`ui-debugger-mcp: no active debug run to stop for '${project}'.`);
    return;
  }

  if (isAlive(state.pid)) {
    signalStop(state);
    await markStatus(stateJson, 'stopped');
    console.log(`ui-debugger-mcp: stopping run '${state.sessionId}' (SIGTERM → pid ${state.pid}).`);
    return;
  }

  await markStatus(stateJson, 'stopped');
  console.log(
    `ui-debugger-mcp: server (pid ${state.pid}) is not running; marked run '${state.sessionId}' stopped.`,
  );
}

/** Send SIGTERM to the recorded server pid (best-effort — a dead pid is fine). */
function signalStop(state: StateFile): void {
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch {
    // Already gone between the liveness check and here — the mark-stopped still stands.
  }
}

/** Clamp a string to `max` chars with an ellipsis. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
