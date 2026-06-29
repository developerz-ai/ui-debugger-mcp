/**
 * The five outer conversational tools, assembled over one {@link DebugApi}.
 *
 * Boot calls {@link outerTools} and hands the list to `startStdioServer`. The
 * server stays tool-blind; this is the single place the catalog is enumerated —
 * `start_debug`, `send_message`, `get_findings`, `describe`, `end_session`.
 */

import type { DebugApi } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { describeTool } from './describe.js';
import { endSessionTool } from './end-session.js';
import { getFindingsTool } from './get-findings.js';
import { sendMessageTool } from './send-message.js';
import { startDebugTool } from './start-debug.js';

/** Build all five outer tools bound to the debug service, in catalog order. */
export function outerTools(service: DebugApi): McpTool[] {
  return [
    startDebugTool(service),
    sendMessageTool(service),
    getFindingsTool(service),
    describeTool(service),
    endSessionTool(service),
  ];
}

export { describeTool, endSessionTool, getFindingsTool, sendMessageTool, startDebugTool };
