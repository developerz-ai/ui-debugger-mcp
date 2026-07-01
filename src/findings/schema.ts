import { z } from 'zod';

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
  kind: z.enum(['console', 'network', 'flow']),
  detail: z.string(),
  evidence: z.string().optional(),
});

export const VisualIssueSchema = z.object({
  issue: z.string(),
  where: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  screenshot: z.string().optional(),
});

export const FindingsSchema = z.object({
  status: z.enum(['running', 'passed', 'failed']),
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
