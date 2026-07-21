/**
 * `get_findings` — poll a run's status + structured findings + evidence.
 *
 * Reads the live snapshot the loop flushes incrementally. `wait` long-polls until
 * the run settles a verdict (or the timeout elapses); `fields` projects a subset
 * to keep the payload small. Thin handler: Zod-validate, call
 * {@link DebugApi.getFindings}.
 */

import { z } from 'zod';
import { FindingsSchema } from '../../findings/schema.js';
import type { DebugApi } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { toToolResult } from './result.js';

/** Selectable top-level findings keys, derived from the findings schema. */
const FindingsField = FindingsSchema.keyof();

/**
 * Declared output: the findings object with every key optional.
 *
 * A `fields` projection returns only the requested keys, so no key can be
 * promised — an all-required schema would make every sparse read fail output
 * validation. Types stay exact per key; only presence is loose.
 */
const FindingsOutputSchema = FindingsSchema.partial();

/** Build the `get_findings` outer tool bound to the debug service. */
export function getFindingsTool(service: DebugApi): McpTool {
  return {
    name: 'get_findings',
    register(server) {
      server.registerTool(
        'get_findings',
        {
          title: 'Get run findings',
          description:
            'Poll the run: status (running|passed|failed) plus structured findings — the step trail, ' +
            'functional bugs, visual/UX feedback, summary, and evidence paths (screenshots, logs). ' +
            'Pass wait (ms) to long-poll until the run settles; pass fields to return only some keys. ' +
            'A run that auto-ended (wall-clock timeout or client disconnect) stays readable under its ' +
            'id until end_session or the next start_debug.',
          inputSchema: {
            session_id: z.string().min(1).describe('The id returned by start_debug.'),
            wait: z
              .number()
              .int()
              .min(0)
              .max(120_000)
              .optional()
              .describe(
                'Long-poll up to this many ms for a terminal verdict before reading. Omit/0 to read now.',
              ),
            fields: z
              .array(FindingsField)
              .min(1)
              .optional()
              .describe(
                'Project a subset of findings keys (e.g. ["status","bugs"]). Omit for the whole object.',
              ),
          },
          outputSchema: FindingsOutputSchema,
        },
        async (args) => toToolResult(await service.getFindings(args)),
      );
    },
  };
}
