/**
 * `send_message` — talk to the running driver mid-run.
 *
 * Injects an instruction the loop folds in before its next step (add work,
 * redirect, answer a question). Thin handler: Zod-validate, call
 * {@link DebugApi.send}, ack.
 */

import { z } from 'zod';
import type { DebugApi } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { AckSchema } from './output.js';
import { toToolResult } from './result.js';

/** Build the `send_message` outer tool bound to the debug service. */
export function sendMessageTool(service: DebugApi): McpTool {
  return {
    name: 'send_message',
    register(server) {
      server.registerTool(
        'send_message',
        {
          title: 'Message the running run',
          description:
            'Talk to the small driver agent mid-run: add work, redirect it, or answer a question. ' +
            'The message is folded into the conversation before the next step — the run keeps going, ' +
            'no restart. Use get_findings to see the effect.',
          annotations: {
            destructiveHint: false,
          },
          inputSchema: {
            session_id: z.string().min(1).describe('The id returned by start_debug.'),
            message: z
              .string()
              .min(1)
              .describe(
                'The instruction for the driver, in plain language (e.g. "skip checkout, the bug is the login form").',
              ),
          },
          outputSchema: AckSchema,
        },
        (args) => toToolResult(service.send(args)),
      );
    },
  };
}
