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
import { ownerAlive } from '../session/process-identity.js';
import { markStatus, readState } from '../session/state-file.js';
import { resolveProject, workspacePaths } from '../session/workspace.js';

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

  const { check, alive } = ownerAlive(state.pid, state.identity);
  const findings = await readFindings(state.sessionDir);
  // Server up + nothing settled yet → trust findings' live status; else the recorded terminal.
  const verdict =
    alive && state.status === 'running' ? (findings?.status ?? 'running') : state.status;
  const counts = findings
    ? `${findings.bugs.length} bugs, ${findings.visual.length} visual, ${findings.steps.length} steps`
    : 'no findings yet';
  // A recycled PID owns a different process now — say so rather than imply our server lives.
  const serverState =
    check === 'stale' ? 'not running (PID reused)' : alive ? 'running' : 'not running';

  console.log(`ui-debugger-mcp — ${project}`);
  console.log(`  run:      ${state.sessionId}`);
  console.log(`  target:   ${state.target}`);
  console.log(`  goal:     ${truncate(state.goal, 72)}`);
  console.log(`  server:   pid ${state.pid} — ${serverState}`);
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

  // A terminal state (`ended`/`stopped`) means the run is already down — the pid
  // may be the healthy, idle MCP server still serving the smart agent. Don't
  // signal it, and don't relabel the recorded terminal status.
  if (state.status !== 'running') {
    console.log(
      `ui-debugger-mcp: no active debug run to stop for '${project}' (last run '${state.sessionId}' ${state.status}).`,
    );
    return;
  }

  const { check, alive } = ownerAlive(state.pid, state.identity);

  // The recorded PID is alive but now owns an *unrelated* process (it was recycled
  // after our server died). Signaling it would kill an innocent process — don't.
  // Our server is provably gone, so mark the run stopped without ever signaling.
  if (check === 'stale') {
    await markStatus(stateJson, 'stopped');
    console.log(
      `ui-debugger-mcp: server (pid ${state.pid}) is gone — its PID was reused by an unrelated process; marked run '${state.sessionId}' stopped without signaling.`,
    );
    return;
  }

  if (alive) {
    const signaled = signalStop(state.pid);
    if (!signaled.ok) {
      // The signal failed for a reason other than the process already being gone
      // (e.g. EPERM). Teardown did NOT happen — don't lie by marking it stopped.
      console.error(
        `ui-debugger-mcp: failed to signal server (pid ${state.pid}): ${signaled.reason}. Run '${state.sessionId}' left as-is.`,
      );
      process.exitCode = 1;
      return;
    }
    await markStatus(stateJson, 'stopped');
    const how = signaled.gone ? `pid ${state.pid} already exited` : `SIGTERM → pid ${state.pid}`;
    console.log(`ui-debugger-mcp: stopping run '${state.sessionId}' (${how}).`);
    return;
  }

  await markStatus(stateJson, 'stopped');
  console.log(
    `ui-debugger-mcp: server (pid ${state.pid}) is not running; marked run '${state.sessionId}' stopped.`,
  );
}

/** Outcome of signalling the server: `ok` false means teardown was NOT initiated. */
type SignalResult = { ok: true; gone: boolean } | { ok: false; reason: string };

/**
 * SIGTERM the recorded server pid. Only the `ESRCH` race (the pid vanished between
 * the liveness check and here — teardown already happened) is treated as benign
 * (`gone`); any other failure surfaces so the caller never reports a false stop.
 */
function signalStop(pid: number): SignalResult {
  try {
    process.kill(pid, 'SIGTERM');
    return { ok: true, gone: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return { ok: true, gone: true };
    return { ok: false, reason: code ?? (err instanceof Error ? err.message : String(err)) };
  }
}

/** Clamp a string to `max` chars with an ellipsis. */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
