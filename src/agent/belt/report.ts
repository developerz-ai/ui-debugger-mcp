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
 * The write MERGES, never replaces: the run's streamed evidence — act steps,
 * console errors, look issues the belt recorded as they happened — is carried
 * into the verdict even when the driver's own arrays omit it. Omission cannot
 * erase evidence; only `dismissStreamed: true` (a deliberate ruling-out) drops
 * unrestated streamed entries.
 *
 * Store-only seam: it touches just `writeFindings` via the {@link FindingsWriter}
 * slice — adapter-blind like the rest of the belt. Fails loud: an invalid verdict
 * surfaces the store's `FindingsError`; we never write a half-formed findings file
 * or silently fall back.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Bug, Findings, Step, VisualIssue } from '../../findings/schema.js';
import {
  BUG_KINDS,
  BugSchema,
  StepSchema,
  TERMINAL_STATUSES,
  VisualIssueSchema,
} from '../../findings/schema.js';
import { evidenceKey, type TrailEvidence } from './trail.js';

/** The empty evidence set — what a run with no wired trail streams. */
export const EMPTY_EVIDENCE: TrailEvidence = { steps: [], bugs: [], visual: [] };

/**
 * `report` input — the findings shape with a terminal `status`. Reuses the
 * canonical findings sub-schemas so the emitted verdict matches what the store
 * persists; arrays default to `[]` so a clean pass needs only `{ status }`.
 */
export const ReportInputSchema = z.object({
  /**
   * Terminal verdicts `report` may emit — `running` is excluded: it is the
   * in-flight state the session overlays before a verdict exists, and a run
   * that is both concluded and not is a contradiction, so the input schema
   * rejects it.
   */
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
    .describe(`functional bugs found: { kind: ${BUG_KINDS.join('|')}, detail, evidence? }`),
  visual: z
    .array(VisualIssueSchema)
    .default([])
    .describe('visual issues from look: { issue, where, severity, screenshot? }'),
  dismissStreamed: z
    .boolean()
    .default(false)
    .describe(
      'findings you already surfaced (look issues, console errors) that you did not list above are carried into the verdict; set true ONLY to dismiss them deliberately',
    ),
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
  /**
   * Streamed evidence the driver never restated but the verdict carries — `0`
   * when `dismissStreamed` was set (then nothing unrestated was included).
   */
  carried: { bugs: number; visual: number };
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
 * Fuse one reported bug with the streamed console error it restates: the
 * driver's wording wins, the streamed row fills the evidence location the
 * driver never saw.
 */
function fuseBug(streamed: Bug, reported: Bug): Bug {
  const evidence = reported.evidence ?? streamed.evidence;
  return {
    kind: reported.kind,
    detail: reported.detail,
    ...(evidence !== undefined && { evidence }),
  };
}

/**
 * Fuse one reported visual issue with the streamed look issue it restates: the
 * driver's wording wins, the streamed entry fills the screenshot path the
 * driver never has at hand.
 */
function fuseVisual(streamed: VisualIssue, reported: VisualIssue): VisualIssue {
  const screenshot = reported.screenshot ?? streamed.screenshot;
  return {
    issue: reported.issue,
    where: reported.where,
    severity: reported.severity,
    ...(screenshot !== undefined && { screenshot }),
  };
}

/**
 * Merge reported findings with the streamed ones, streamed order as the spine —
 * the same discipline as {@link mergeSteps}, for the bugs/visual streams. A
 * restatement (matched by normalized key) fuses in place, driver fields winning
 * and streamed evidence filling the gaps; reported entries that restate nothing
 * append in reported order. Unrestated streamed entries are carried (`keep:
 * true`) or dropped (`keep: false` — a deliberate `dismissStreamed`); `carried`
 * counts what was included, so it is always 0 under `keep: false`.
 */
function mergeStreamed<T>(
  reported: readonly T[],
  streamed: readonly T[],
  keyOf: (item: T) => string,
  fuse: (streamed: T, reported: T) => T,
  keep: boolean,
): { merged: T[]; carried: number } {
  const pending = new Map<string, Array<{ index: number; item: T }>>();
  reported.forEach((item, index) => {
    const queue = pending.get(keyOf(item));
    if (queue) queue.push({ index, item });
    else pending.set(keyOf(item), [{ index, item }]);
  });
  const fused = new Set<number>();
  const merged: T[] = [];
  let carried = 0;
  for (const entry of streamed) {
    const hit = pending.get(keyOf(entry))?.shift();
    if (hit) {
      fused.add(hit.index);
      merged.push(fuse(entry, hit.item));
    } else if (keep) {
      carried += 1;
      merged.push(entry);
    }
  }
  for (const [index, item] of reported.entries()) {
    if (!fused.has(index)) merged.push(item);
  }
  return { merged, carried };
}

/**
 * Everything the terminal write needs, derived in ONE pass: the merged evidence
 * streams and the carried counts. The single source of truth for the persisted
 * findings AND the returned counts, so they never drift.
 */
function mergeEvidence(input: ReportInput, evidence: TrailEvidence) {
  const steps = mergeSteps(input.steps, evidence.steps);
  const bugMerge = mergeStreamed(
    input.bugs,
    evidence.bugs,
    (bug) => evidenceKey(bug.detail),
    fuseBug,
    !input.dismissStreamed,
  );
  const visualMerge = mergeStreamed(
    input.visual,
    evidence.visual,
    (issue) => evidenceKey(issue.issue, issue.where),
    fuseVisual,
    !input.dismissStreamed,
  );
  return {
    steps,
    bugs: bugMerge.merged,
    visual: visualMerge.merged,
    // Already 0 across the board under `dismissStreamed` — nothing unrestated was kept.
    carried: { bugs: bugMerge.carried, visual: visualMerge.carried },
  };
}

/**
 * Write the terminal verdict and report the stop. Both the persisted findings
 * and the returned counts/carried derive from ONE {@link mergeEvidence} pass —
 * the run's streamed evidence merged with the driver's verdict. Pure over the
 * {@link FindingsWriter} seam, so it unit-tests against a fake with no disk.
 */
export async function runReport(
  writer: FindingsWriter,
  input: ReportInput,
  evidence: TrailEvidence = EMPTY_EVIDENCE,
): Promise<ReportResult> {
  const { steps, bugs, visual, carried } = mergeEvidence(input, evidence);
  const findings: Findings = {
    status: input.status,
    steps,
    bugs,
    visual,
    ...(input.summary !== undefined && { summary: input.summary }),
  };
  const path = await writer.writeFindings(findings);
  return {
    status: input.status,
    findings: path,
    counts: {
      steps: findings.steps.length,
      bugs: findings.bugs.length,
      visual: findings.visual.length,
    },
    carried,
    stop: true,
  };
}

/**
 * Build the `report` tool bound to one findings store, for the debug agent's belt.
 * `getTrail` (when wired by the loop) supplies the run's streamed evidence so the
 * written verdict carries the console errors and look issues the belt recorded,
 * not just what the driver chose to list.
 *
 * It may be async — and the wired one is. `report` executes CONCURRENTLY with the
 * other tool calls of its own step, so when the driver emits `look` + `report`
 * together the look is still running here; the wired read is the evidence trail's
 * `settled()`, which waits for it (see `belt/trail.ts`). Waiting is safe: the
 * step's own `Promise.all` already awaits that call.
 */
export function createReportTool(
  writer: FindingsWriter,
  getTrail?: () => TrailEvidence | Promise<TrailEvidence>,
) {
  return tool({
    description:
      'Emit the final structured findings and END the run. Call exactly once, when the goal is met or you hit the step limit. Validates and writes findings.json: status (passed|failed) plus steps/bugs/visual/summary. Console errors you surfaced earlier are carried in even if you forget to list them; look issues too when a separate vision model judges the looks. Dismissal is deliberate (dismissStreamed). This is terminal — the loop stops after report, so do not act again. Make summary actionable for the smart agent: what broke, where, what to fix.',
    inputSchema: ReportInputSchema,
    execute: async (input) => runReport(writer, input, (await getTrail?.()) ?? EMPTY_EVIDENCE),
  });
}
