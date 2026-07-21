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
import type { Findings, Step } from '../../findings/schema.js';
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
  /** Counts derived from the written {@link Findings}, so the verdict reads without re-opening the file. */
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
 * Build the canonical findings record from a validated report input. The base
 * verdict shape; {@link terminalFindings} merges the loop's recorded act-trail
 * into its `steps`, so both the persisted write and the returned counts agree.
 */
export function reportFindings(input: ReportInput): Findings {
  return {
    status: input.status,
    steps: input.steps,
    bugs: input.bugs,
    visual: input.visual,
    ...(input.summary !== undefined && { summary: input.summary }),
  };
}

/** Pairing key for a reported step and a recorded one — case- and whitespace-insensitive. */
function stepKey(step: Step): string {
  return step.step.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Fuse one reported step with the trail entry it restates: the driver's version
 * wins field by field (its `ok`, its `note`), the recorded one fills what the
 * driver left out — above all the evidence frame it never sees a path for.
 */
function fuseStep(recorded: Step, reported: Step): Step {
  const skipped = reported.skipped ?? recorded.skipped;
  const note = reported.note ?? recorded.note;
  const screenshot = reported.screenshot ?? recorded.screenshot;
  return {
    step: reported.step,
    ok: reported.ok,
    ...(skipped !== undefined && { skipped }),
    ...(note !== undefined && { note }),
    ...(screenshot !== undefined && { screenshot }),
  };
}

/**
 * Merge the driver's reported steps with the loop's recorded act-`trail`. Nothing
 * is discarded: the driver's `ok: false` steps and notes (the prompt mandates
 * them) survive alongside the mechanical trail and its evidence frames.
 *
 * The trail is the spine — it is the true chronology, recorded at act time — and
 * each entry the driver restated verbatim (models commonly echo the `act` result
 * label) is fused in place, driver fields winning, trail filling the gaps. Steps
 * the driver reported that no trail entry matches — assertions, observations, acts
 * from a step that also called `report` — follow in reported order, since nothing
 * places them in the chronology. Both inputs keep their relative order, and equal
 * labels pair up first-come-first-served, so repeating an action pairs each
 * occurrence with a distinct trail entry.
 */
export function mergeSteps(reported: readonly Step[], trail: readonly Step[]): Step[] {
  if (trail.length === 0) return [...reported];
  if (reported.length === 0) return [...trail];
  const pending = new Map<string, Array<{ index: number; step: Step }>>();
  reported.forEach((step, index) => {
    const queue = pending.get(stepKey(step));
    if (queue) queue.push({ index, step });
    else pending.set(stepKey(step), [{ index, step }]);
  });
  const fused = new Set<number>();
  const merged = trail.map((recorded) => {
    const hit = pending.get(stepKey(recorded))?.shift();
    if (!hit) return recorded;
    fused.add(hit.index);
    return fuseStep(recorded, hit.step);
  });
  for (const [index, step] of reported.entries()) {
    if (!fused.has(index)) merged.push(step);
  }
  return merged;
}

/**
 * The authoritative terminal {@link Findings}: the report input with the loop's
 * recorded act-`trail` merged into its `steps` (see {@link mergeSteps}) — never a
 * wholesale replacement, which silently dropped every step the driver reported.
 * The single source of truth for the terminal write AND the counts, so they never
 * drift (a `0`-step result returned over a trail-filled file).
 */
export function terminalFindings(input: ReportInput, trail: readonly Step[] = []): Findings {
  const findings = reportFindings(input);
  return { ...findings, steps: mergeSteps(input.steps, trail) };
}

/**
 * Write the terminal verdict and report the stop. Both the persisted findings and
 * the returned counts derive from one {@link terminalFindings} object — the loop's
 * `trail` merged with the driver's reported steps. Pure over the
 * {@link FindingsWriter} seam, so it unit-tests against a fake with no disk.
 */
export async function runReport(
  writer: FindingsWriter,
  input: ReportInput,
  trail: readonly Step[] = [],
): Promise<ReportResult> {
  const findings = terminalFindings(input, trail);
  const path = await writer.writeFindings(findings);
  return {
    status: input.status,
    findings: path,
    counts: {
      steps: findings.steps.length,
      bugs: findings.bugs.length,
      visual: findings.visual.length,
    },
    stop: true,
  };
}

/**
 * Build the `report` tool bound to one findings store, for the debug agent's belt.
 * `getTrail` (when wired by the loop) supplies the recorded act-trail so the
 * written verdict and its counts both reflect the steps actually taken.
 */
export function createReportTool(writer: FindingsWriter, getTrail?: () => readonly Step[]) {
  return tool({
    description:
      'Emit the final structured findings and END the run. Call exactly once, when the goal is met or you hit the step limit. Validates and writes findings.json: status (passed|failed) plus steps/bugs/visual/summary. This is terminal — the loop stops after report, so do not act again. Make summary actionable for the smart agent: what broke, where, what to fix.',
    inputSchema: ReportInputSchema,
    execute: (input) => runReport(writer, input, getTrail?.() ?? []),
  });
}
