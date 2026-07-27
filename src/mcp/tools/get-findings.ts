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
import { TRUNCATED_KEY, toToolResult } from './result.js';

/** Selectable top-level findings keys, derived from the findings schema. */
const FindingsField = FindingsSchema.keyof();

/**
 * Declared output: the findings object with every key optional, plus the
 * truncation counts a capped whole-object read carries.
 *
 * A `fields` projection returns only the requested keys, so no key can be
 * promised — an all-required schema would make every sparse read fail output
 * validation. Types stay exact per key; only presence is loose.
 *
 * `truncated` is declared rather than smuggled: it is the structural half of the
 * cap (the prose note is the other), and a caller can only act on what the output
 * schema tells it exists.
 */
const FindingsOutputSchema = FindingsSchema.partial().extend({
  [TRUNCATED_KEY]: z
    .record(z.string(), z.object({ returned: z.number().int(), total: z.number().int() }))
    .optional()
    .describe(
      'Present only on a capped whole-object read: per field, how many items came back vs how ' +
        'many the run has. Re-read with fields=[…] to get them all.',
    ),
});

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
          annotations: {
            readOnlyHint: true,
          },
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
                'Project a subset of findings keys (e.g. ["status","bugs"]). Omit for the whole ' +
                  'object, whose lists are capped at 20 items — a capped read says so in ' +
                  '`truncated` ({returned,total} per field); a projected read returns them in full.',
              ),
          },
          outputSchema: FindingsOutputSchema,
        },
        // Cap the lists only on a whole-object read: the steering note points back
        // at `fields=[...]`, so a projected read must come back complete or the
        // recovery path it names would be a lie.
        async (args) =>
          toToolResult(await service.getFindings(args), { capLists: args.fields === undefined }),
      );
    },
  };
}
