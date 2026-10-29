import { z } from 'zod';

/**
 * The findings lifecycle: `running` while a run is in flight, `passed`/`failed`
 * once the driver reports. Canonical list — every reader of a findings status
 * enumerates from here, never a local copy (consumers: `report`
 * (`src/agent/belt/report.ts`), the MCP findings output (`src/mcp/tools/output.ts`)).
 */
export const FINDINGS_STATUSES = ['running', 'passed', 'failed'] as const;
export type FindingsStatus = (typeof FINDINGS_STATUSES)[number];

/**
 * The statuses that END a run — the subset of {@link FINDINGS_STATUSES} the
 * driver's `report` tool (`src/agent/belt/report.ts`) may emit and
 * `session.verdict()` (`src/session/session.ts`) resolves to. `running` is the
 * in-flight state the session overlays before a verdict exists; it is not
 * terminal.
 */
export const TERMINAL_STATUSES = ['passed', 'failed'] as const satisfies readonly FindingsStatus[];
export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

/**
 * Severity scale of a visual issue, judged by user impact. Shared by the
 * findings schema and `look`'s vision seam (`src/agent/belt/look.ts` — both its
 * `LookIssueSchema` and the vision system prompt enumerate from here), so the
 * vision guy's reply and the persisted findings can never drift apart.
 */
export const VISUAL_SEVERITIES = ['low', 'medium', 'high'] as const;

/**
 * Kinds of functional bug the driver's `report` (`src/agent/belt/report.ts`)
 * accepts and the findings store persists, surfaced verbatim through the MCP
 * findings output: a console error, a failing network exchange, or a broken
 * user flow.
 */
export const BUG_KINDS = ['console', 'network', 'flow'] as const;

export const StepSchema = z.object({
  step: z.string(),
  ok: z.boolean(),
  /** True for a deliberately skipped optional step (e.g. replay video when
   * ffmpeg is absent). A skip is NOT a failure — `ok` stays true so a clean run
   * never reads as broken; `note` explains why the step was skipped. */
  skipped: z.boolean().optional(),
  note: z.string().optional(),
  screenshot: z.string().optional(),
});

export const BugSchema = z.object({
  kind: z.enum(BUG_KINDS),
  detail: z.string(),
  evidence: z.string().optional(),
});

export const VisualIssueSchema = z.object({
  issue: z.string(),
  where: z.string(),
  severity: z.enum(VISUAL_SEVERITIES),
  screenshot: z.string().optional(),
});

export const FindingsSchema = z.object({
  status: z.enum(FINDINGS_STATUSES),
  steps: z.array(StepSchema).default([]),
  bugs: z.array(BugSchema).default([]),
  visual: z.array(VisualIssueSchema).default([]),
  summary: z.string().optional(),
  evidence: z.string().optional(),
});

export type Step = z.infer<typeof StepSchema>;
export type Bug = z.infer<typeof BugSchema>;
export type VisualIssue = z.infer<typeof VisualIssueSchema>;
export type Findings = z.infer<typeof FindingsSchema>;

/**
 * The findings fields that hold an evidence pointer: `screenshot` on a step and
 * a visual issue, `evidence` on a bug and on the findings object itself. The
 * MCP result layer (`src/mcp/tools/result.ts`) derives its `EVIDENCE_KEYS` from
 * this, so evidence handling follows the schema instead of a copied list.
 */
export const EVIDENCE_FIELD_NAMES = ['screenshot', 'evidence'] as const satisfies readonly (
  | keyof Step
  | keyof Bug
  | keyof VisualIssue
  | keyof Findings
)[];
