/**
 * `end_session` — stop and tear down the active run.
 *
 * Aborts the loop, closes the target adapter (managed: stops Chrome; attach:
 * disconnects only), and frees the project's profile lock. Thin handler:
 * Zod-validate, call {@link DebugApi.end}, ack.
 */

import { z } from 'zod';
import type { DebugApi } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { AckSchema } from './output.js';
import { toToolResult } from './result.js';

/** Build the `end_session` outer tool bound to the debug service. */
export function endSessionTool(service: DebugApi): McpTool {
  return {
    name: 'end_session',
    register(server) {
      server.registerTool(
        'end_session',
        {
          title: 'End the debug run',
          description:
            'Close the active run: abort the loop, release the target (managed Chrome is stopped; an ' +
            'attached browser is only disconnected), and free the project lock so a new start_debug can ' +
            'run. The last get_findings snapshot remains on disk.',
          annotations: {
            idempotentHint: true,
          },
          inputSchema: {
            session_id: z.string().min(1).describe('The id returned by start_debug.'),
          },
          outputSchema: AckSchema,
        },
        async (args) => toToolResult(await service.end(args)),
      );
    },
  };
}
