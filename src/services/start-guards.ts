/**
 * The two start-time refusals — the checks that run BEFORE a browser is
 * launched, so a run never starts on terms its caller cannot honour.
 *
 * Split out of `debug-service.ts` to keep that file under the 500-LOC cap. Both
 * keep their message text verbatim: the messages ARE the contract — they name
 * the pid, the session and the exact command that unblocks the caller.
 */

import { CONFIG_FILENAME } from '../config/load.js';
import { ConfigError, SessionBusyError } from '../errors.js';
import type { StatePort } from '../session/state-file.js';

/**
 * Refuse to start on config this server can no longer honour.
 *
 * The message names the one action that works. Without it the caller edits the
 * file, sees the identical failure, and has no way to tell a bad fix from an
 * unread one — which is exactly how a real session burned two runs.
 */
export function assertConfigFresh(configChanged: () => boolean): void {
  if (!configChanged()) return;
  throw new ConfigError(
    `${CONFIG_FILENAME} changed on disk after this ui-debugger-mcp server started, so a run now ` +
      'would still use the OLD settings (models, targets, urls are read once at boot). ' +
      'Restart the MCP server to pick the new config up — in Claude Code, /mcp → reconnect ' +
      'ui-debugger, or restart the session.',
  );
}

/**
 * The other half of the one-run gate: another *live* server process holding a
 * run on this project. The manager only sees this process's memory, so without
 * this a second MCP client on the same cwd would launch a second run onto the
 * same profile/emulator and overwrite the live breadcrumb (leaving the CLI
 * pointing at the wrong pid). A dead or PID-recycled owner does not count — a
 * crashed server's stale `running` file must never wedge the project shut.
 *
 * This is the FRIENDLY early refusal, not the authority: it reads the
 * breadcrumb, so two servers starting in the same window can both pass it.
 * The authoritative admission is the workspace's exclusive ownership claim,
 * taken atomically by the breadcrumb write in the service's launch — a refused
 * claim surfaces as {@link SessionBusyError} from there.
 */
export async function assertNoForeignRun(state: StatePort, cwd: string): Promise<void> {
  const foreign = await state.foreignRun();
  if (foreign === null) return;
  throw new SessionBusyError(
    `Another ui-debugger-mcp server (pid ${foreign.pid}) already has a debug session ` +
      `('${foreign.sessionId}') active for '${cwd}'. One run per project at a time. ` +
      `Read what it is doing with get_findings({session_id:'${foreign.sessionId}'}) — a run ` +
      'that has already settled is just waiting to be closed by its own client. To take the ' +
      "project over, run 'ui-debugger-mcp stop' in this directory, then start again.",
  );
}
