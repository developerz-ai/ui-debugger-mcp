/**
 * `start_debug` — open a debug session for a configured target.
 *
 * Hands the small driver agent a goal (the "story"); it drives the UI
 * autonomously and reports findings. One run per project (cwd) at a time. Thin
 * handler: Zod-validate the raw shape, call {@link DebugApi.start}, shape the
 * `{ session_id }` result.
 */

import { z } from 'zod';
import type { DebugApi } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { toToolResult } from './result.js';

/** Build the `start_debug` outer tool bound to the debug service. */
export function startDebugTool(service: DebugApi): McpTool {
  return {
    name: 'start_debug',
    register(server) {
      server.registerTool(
        'start_debug',
        {
          title: 'Start a debug run',
          description:
            'Open a debug session: hand the small driver agent a goal for a configured target ' +
            '(e.g. "web"). It drives the UI autonomously and gathers findings (functional bugs + ' +
            'visual feedback). One run per project at a time. Returns { session_id }; then poll ' +
            'get_findings, steer with send_message, and close with end_session.',
          inputSchema: {
            target: z
              .string()
              .min(1)
              .describe(
                'Configured target name (a key in .ui-debugger-mcp.json targets, e.g. "web"). See describe.',
              ),
            goal: z
              .string()
              .min(1)
              .describe(
                'The story: what to accomplish, in plain language (e.g. "log in and add item 3 to the cart").',
              ),
            criteria: z
              .string()
              .optional()
              .describe(
                'Optional explicit pass/fail rules, one per line. Omit to let the agent judge.',
              ),
          },
        },
        async (args) => toToolResult(await service.start(args)),
      );
    },
  };
}
