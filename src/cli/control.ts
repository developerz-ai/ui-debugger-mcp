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
import { isAbsolute, join, resolve } from 'node:path';
import { loadWorkspaceDir } from '../config/load.js';
import { ConfigError } from '../errors.js';
import { FindingsSchema } from '../findings/schema.js';
import { readLivePointer } from '../session/live-pointer.js';
import { ownerAlive } from '../session/process-identity.js';
import { markStatus, readState, restoreRunning } from '../session/state-file.js';
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

/** The workspace the CURRENT config resolves to; `null` when the config is unreadable/invalid. */
function configWorkspace(cwd: string) {
  try {
    // A relative workspace is anchored at the project root (cwd), matching the server.
    const base = loadWorkspaceDir(cwd);
    return workspacePaths(cwd, isAbsolute(base) ? base : join(cwd, base));
  } catch (err) {
    if (err instanceof ConfigError) return null;
    throw err;
  }
}

/**
 * Resolve `state.json` for the current project (no API key needed).
 *
 * The server's workspace was fixed from the config at boot; the config may have
 * been edited since. The live pointer names the root the server really owns, so
 * it wins — even over an invalid config. A recorded pointer without its matching
 * breadcrumb is config drift, not evidence that no run exists: fail loud rather
 * than falling back to the current config's possibly unrelated workspace. No
 * pointer (legacy server, no run yet) → the config-resolved workspace, whose
 * ConfigError then surfaces loud. `drift` is set when live and config roots differ.
 */
async function resolveState(
  cwd: string,
): Promise<{ project: string; stateJson: string; drift?: string }> {
  const project = resolveProject(cwd);
  const config = configWorkspace(cwd);
  const liveRoot = await readLivePointer(cwd);
  if (liveRoot !== null) {
    const stateJson = join(liveRoot, 'state.json');
    if ((await readState(stateJson)) === null) {
      throw new ConfigError(
        `Config drift: recorded live workspace ${liveRoot} has no readable state breadcrumb at ${stateJson}. ` +
          'The config may have changed since the server started; restore the live workspace or restart the server.',
      );
    }
    if (config !== null && resolve(config.root) === resolve(liveRoot)) {
      return { project, stateJson };
    }
    const now = config === null ? 'is unreadable or invalid' : `resolves to ${config.root}`;
    const drift = `the live run's workspace is ${liveRoot}, but the config now ${now} — config edited since the server started`;
    return { project, stateJson, drift };
  }
  if (config === null) loadWorkspaceDir(cwd); // rethrows the ConfigError — fail loud
  return { project, stateJson: (config ?? workspacePaths(cwd)).stateJson };
}

/** `ui-debugger-mcp status` — print the active run's state + findings summary. */
export async function runStatus(cwd = process.cwd()): Promise<void> {
  const { project, stateJson, drift } = await resolveState(cwd);
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
  // If state says running but the server is dead (check not stale), report the mismatch.
  const serverState =
    check === 'stale'
      ? 'not running (PID reused)'
      : alive
        ? 'running'
        : state.status === 'running'
          ? 'unknown (server died)'
          : 'not running';

  console.log(`ui-debugger-mcp — ${project}`);
  console.log(`  run:      ${state.sessionId}`);
  console.log(`  target:   ${state.target}`);
  console.log(`  goal:     ${truncate(state.goal, 72)}`);
  console.log(`  server:   pid ${state.pid} — ${serverState}`);
  console.log(`  status:   ${verdict}`);
  console.log(`  findings: ${counts}`);
  console.log(`  started:  ${state.startedAt}`);
  console.log(`  session:  ${state.sessionDir}`);
  if (drift) console.log(`  drift:    ${drift}`);
}

/** Signal seam — `process.kill` in production, a stub under test. */
export type Kill = (pid: number, signal: NodeJS.Signals) => void;

/** `ui-debugger-mcp stop` — signal the server to tear the run down, mark state stopped. */
export async function runStop(
  cwd = process.cwd(),
  kill: Kill = (pid, signal) => {
    process.kill(pid, signal);
  },
): Promise<void> {
  const { project, stateJson } = await resolveState(cwd);
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
    // Record the terminal status BEFORE signaling. The server's SIGTERM handler
    // ends the run and calls `markStatus('ended')`, whose read-modify-write can
    // only preserve our `stopped` if it is already on disk when the signal lands.
    // Marking afterwards races that handler and can leave `ended` — or nothing.
    await markStatus(stateJson, 'stopped');
    const signaled = signalStop(state.pid, kill);
    if (!signaled.ok) {
      // The signal failed for a reason other than the process already being gone
      // (e.g. EPERM). Teardown did NOT happen — roll the mark back rather than
      // report a live run as stopped.
      await restoreRunning(stateJson);
      console.error(
        `ui-debugger-mcp: failed to signal server (pid ${state.pid}): ${signaled.reason}. Run '${state.sessionId}' left as-is.`,
      );
      process.exitCode = 1;
      return;
    }
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
function signalStop(pid: number, kill: Kill): SignalResult {
  try {
    kill(pid, 'SIGTERM');
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
