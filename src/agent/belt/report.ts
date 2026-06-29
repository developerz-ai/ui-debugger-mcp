/**
 * `report` — the driver's terminal verdict (inner belt).
 *
 * The loop's full stop. The driver calls `report` exactly once, when the goal is
 * met (or the step limit is hit), to hand the smart agent a structured verdict:
 *   `{ status, steps[], bugs[], visual[], summary? }`.
 * It Zod-validates that shape, writes the final `findings.json` through the store,
 * and returns `stop: true` — the signal the agent loop ends on (`get_findings`
 * then surfaces exactly this object to the smart agent; no prose parsing).
 *
 * `status` is the TERMINAL verdict only — `passed` | `failed`. `running` is the
 * live in-flight state the session overlays before a verdict exists; emitting it
 * here would be a contradiction (a run that is both concluded and not), so the
 * input schema rejects it. The other fields reuse the canonical findings
 * sub-schemas (`StepSchema` · `BugSchema` · `VisualIssueSchema`) so the verdict
 * the driver emits is byte-for-byte the verdict the store persists.
 *
 * Store-only seam: it touches just `writeFindings` via the {@link FindingsWriter}
 * slice — adapter-blind like the rest of the belt. Fails loud: an invalid verdict
 * surfaces the store's `FindingsError`; we never write a half-formed findings file
 * or silently fall back.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Findings } from '../../findings/schema.js';
import { BugSchema, StepSchema, VisualIssueSchema } from '../../findings/schema.js';

/** Terminal verdicts `report` may emit — `running` is excluded (it isn't terminal). */
const TERMINAL_STATUSES = ['passed', 'failed'] as const;

/**
 * `report` input — the findings shape with a terminal `status`. Reuses the
 * canonical findings sub-schemas so the emitted verdict matches what the store
 * persists; arrays default to `[]` so a clean pass needs only `{ status }`.
 */
export const ReportInputSchema = z.object({
  status: z
    .enum(TERMINAL_STATUSES)
    .describe(
      'terminal verdict: passed (goal met, no blockers) | failed (blocking bug/visual issue)',
    ),
  steps: z
    .array(StepSchema)
    .default([])
    .describe('ordered step trail: what you did and whether each was ok'),
  bugs: z
    .array(BugSchema)
    .default([])
    .describe('functional bugs found: { kind: console|network|flow, detail, evidence? }'),
  visual: z
    .array(VisualIssueSchema)
    .default([])
    .describe('visual issues from look: { issue, where, severity, screenshot? }'),
  summary: z
    .string()
    .optional()
    .describe(
      'one-paragraph, actionable verdict for the smart agent: what broke, where, what to fix',
    ),
});

export type ReportInput = z.infer<typeof ReportInputSchema>;

/** Structured `report` result — confirms the written verdict and signals the loop to stop. */
export interface ReportResult {
  /** The terminal verdict written (mirrors the input discriminant). */
  status: ReportInput['status'];
  /** Path to the written `findings.json` (an evidence pointer, never the inlined blob). */
  findings: string;
  /** How many of each were recorded, so the verdict reads without re-opening the file. */
  counts: { steps: number; bugs: number; visual: number };
  /** Terminal signal: the agent loop ends after this call. `report` is the full stop. */
  stop: true;
}

/**
 * The slice of the findings store `report` writes through. {@link FindingsStore}
 * satisfies it structurally, so the real store drops in; tests pass a fake.
 */
export interface FindingsWriter {
  /** Validate + write the final `findings.json` (overwrites); returns its path. */
  writeFindings(findings: Findings): Promise<string>;
}

/**
 * Write the terminal verdict and report the stop. Pure over the
 * {@link FindingsWriter} seam, so it unit-tests against a fake with no disk.
 */
export async function runReport(writer: FindingsWriter, input: ReportInput): Promise<ReportResult> {
  const findings: Findings = {
    status: input.status,
    steps: input.steps,
    bugs: input.bugs,
    visual: input.visual,
    ...(input.summary !== undefined && { summary: input.summary }),
  };
  const path = await writer.writeFindings(findings);
  return {
    status: input.status,
    findings: path,
    counts: { steps: input.steps.length, bugs: input.bugs.length, visual: input.visual.length },
    stop: true,
  };
}

/** Build the `report` tool bound to one findings store, for the debug agent's belt. */
export function createReportTool(writer: FindingsWriter) {
  return tool({
    description:
      'Emit the final structured findings and END the run. Call exactly once, when the goal is met or you hit the step limit. Validates and writes findings.json: status (passed|failed) plus steps/bugs/visual/summary. This is terminal — the loop stops after report, so do not act again. Make summary actionable for the smart agent: what broke, where, what to fix.',
    inputSchema: ReportInputSchema,
    execute: (input) => runReport(writer, input),
  });
}
