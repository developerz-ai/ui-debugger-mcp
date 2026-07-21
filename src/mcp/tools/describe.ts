/**
 * `describe` — list this project's debug targets + resolved models/workspace.
 *
 * The smart agent's lazy catalog: what targets are configured (and which are
 * wired), so it knows valid `target` values for `start_debug` without reading the
 * config file. Pass `target` to narrow to one. Thin handler: Zod-validate, call
 * {@link DebugApi.describe}.
 */

import { z } from 'zod';
import type { DebugApi } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { DescribeResultSchema } from './output.js';
import { toToolResult } from './result.js';

/** Build the `describe` outer tool bound to the debug service. */
export function describeTool(service: DebugApi): McpTool {
  return {
    name: 'describe',
    register(server) {
      server.registerTool(
        'describe',
        {
          title: 'Describe debug targets',
          description:
            'List the configured targets for this project (name, adapter, managed|attach, whether wired, ' +
            'and web url/headless) plus the resolved per-role models and workspace. Call this first to pick ' +
            'a valid target for start_debug. Pass target to narrow to one.',
          annotations: {
            readOnlyHint: true,
          },
          inputSchema: {
            target: z
              .string()
              .min(1)
              .optional()
              .describe('Optional target name to narrow the catalog to a single entry.'),
          },
          outputSchema: DescribeResultSchema,
        },
        (args) => toToolResult(service.describe(args)),
      );
    },
  };
}
