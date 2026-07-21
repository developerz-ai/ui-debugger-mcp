/**
 * Output schemas for the outer tools — the typed half of every tool result.
 *
 * {@link toToolResult} returns each service value BOTH as pretty text and as
 * `structuredContent`; the SDK validates that structured half against the
 * `outputSchema` a tool declares, and clients compile it to type the payload
 * they receive. Declaring them here keeps "Zod at every boundary" true on the
 * way *out* too: a service shape that drifts fails loud at the boundary instead
 * of reaching the caller unchecked.
 *
 * Each schema is pinned to its service interface with `satisfies`, so a rename
 * in `debug-service.ts` that this file misses fails typecheck.
 *
 * `get_findings` declares its own (the findings schema, projected) — see
 * `get-findings.ts`.
 */

import { z } from 'zod';
import type { Ack, DescribeResult, StartResult } from '../../services/debug-service.js';

/** `start_debug` output — the id every later call is keyed by. */
export const StartResultSchema = z.object({
  session_id: z
    .string()
    .min(1)
    .describe('Pass this to get_findings, send_message and end_session.'),
}) satisfies z.ZodType<StartResult>;

/** `send_message` / `end_session` output — a plain acknowledgement. */
export const AckSchema = z.object({
  ok: z
    .literal(true)
    .describe('The call was accepted; a failure arrives as an error result instead.'),
  session_id: z.string().min(1).describe('The run this ack is for.'),
}) satisfies z.ZodType<Ack>;

/** One configured target's public shape — secrets (api keys, profiles) stay out. */
const TargetInfoSchema = z.object({
  name: z.string().describe('Target name to pass to start_debug.'),
  adapter: z.enum(['browser', 'desktop', 'android']).describe('Which adapter drives this target.'),
  mode: z
    .enum(['managed', 'attach'])
    .describe('managed = the server launches and owns it; attach = it connects to a running one.'),
  operational: z.boolean().describe('Whether this adapter is wired and usable.'),
  url: z.string().optional().describe('Entry url (web targets only).'),
  headless: z.boolean().optional().describe('Headless flag (web targets only).'),
});

/** `describe` output — the target catalog plus the resolved models + workspace. */
export const DescribeResultSchema = z.object({
  targets: z.array(TargetInfoSchema).describe('Targets configured for this project.'),
  models: z
    .object({
      driver: z.string().describe('Fast guy — drives the target (text-only).'),
      vision: z.string().describe('Vision guy — judges screenshots.'),
      summary: z.string().describe('Compresses findings for the caller.'),
    })
    .describe('Resolved per-role model ids.'),
  workspace: z.string().describe('Per-project workspace path; evidence lands under it.'),
}) satisfies z.ZodType<DescribeResult>;
