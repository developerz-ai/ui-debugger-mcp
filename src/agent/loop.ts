/**
 * The debug agent loop — the fast guy's run, as a conversation.
 *
 * A {@link ToolLoopAgent} drives the inner belt (`observe`/`act`/`look`/`report`)
 * with the `driver` model until the goal is met (`report`, the terminal verdict)
 * or a safety step cap trips. Two things make it a *conversation*, not a job:
 *
 *   - **inbox** — `prepareStep` drains the session inbox between steps and folds
 *     any mid-run messages (the smart agent's `send_message`) into a standing
 *     instruction block re-appended to EVERY turn (the SDK rebuilds each step's
 *     prompt from scratch), so the driver adapts without restarting or forgetting.
 *   - **incremental findings** — `onStepFinish` snapshots the shared act trail
 *     (`act` records each step as it happens) plus `look`'s visual issues and
 *     error-level console rows, and flushes them as `status: 'running'` findings,
 *     so `get_findings` streams findings before the verdict lands, and a run that
 *     crashes, aborts or hits the step cap keeps everything surfaced so far.
 *
 * Adapter-blind and model-blind like the belt: the loop never touches a protocol
 * or a provider. It is pure over two seams — {@link LoopInbox} (drain) and
 * {@link ProgressWriter} (flush) — so its logic unit-tests with no network. The
 * `report` step owns the terminal write, so the running flush steps aside for it
 * (never clobbers the verdict with a `running` snapshot). Abort propagates: an
 * aborted run rejects loud (wired to `end_session`), never a silent half-finish.
 */

import {
  hasToolCall,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  type Tool,
  ToolLoopAgent,
} from 'ai';
import { z } from 'zod';
import type { Bug, Findings, Step, VisualIssue } from '../findings/schema.js';

/** Safety cap on driver steps before the loop force-stops (paired with `hasToolCall('report')`). */
export const DEFAULT_MAX_STEPS = 30;

/** Kickoff turn — the story lives in `instructions`; this nudges the driver to start the loop. */
export const KICKOFF_PROMPT =
  'Begin. Work toward the goal with observe/act/look, then call report exactly once with your verdict.';

/** The driver's inner belt — the four fat tools the loop drives (see `idea/mcp-tools.md`). */
export type BeltTools = {
  observe: Tool;
  act: Tool;
  look: Tool;
  report: Tool;
};

/** Inbox seam: the mid-run messages the smart agent injected, returned and cleared between steps. */
export interface LoopInbox {
  /** Return all pending messages and clear them; `[]` when nothing is queued. */
  drain(): readonly string[];
}

/** Progress seam: persist the running step trail so `get_findings` shows live progress before `report`. */
export interface ProgressWriter {
  /** Validate + write the current (running) findings; returns the path written. */
  writeFindings(findings: Findings): Promise<string>;
}

/** The slice of a finished step the running flush reads — `look`/`observe` outputs + what ran. */
export interface FinishedStep {
  /** Tools called this step; a `report` call marks the terminal step (verdict owned elsewhere). */
  toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>;
  /** Tool results this step; `look`/`observe` outputs become streamed findings. */
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
  /**
   * Raw step content, AI SDK 6 shape — a *rejected* tool call lands here as a
   * `tool-error` part, never in {@link toolResults} (that array only ever holds
   * successful `tool-result` parts). Optional so hand-built test fixtures that
   * never fail a tool call can omit it; `describeStep` treats an absent array as
   * "no errors" rather than throwing.
   */
  content?: ReadonlyArray<{ type: string; toolName?: string; error?: unknown }>;
}

/**
 * The `look` result fields lifted into streamed visual findings: the vision guy's
 * `issues[]` and the frame it judged (see `belt/look.ts`). A SELF-look result (a
 * multimodal driver judging the frame with its own eyes) carries no `issues`, so
 * it contributes nothing here — those issues reach findings via `report`.
 */
const LookVisualSchema = z.object({
  screenshot: z.string().optional(),
  issues: z
    .array(
      z.object({
        what: z.string(),
        where: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
      }),
    )
    .default([]),
});

/** The `observe` console rows lifted into streamed bugs (see `belt/observe.ts`). */
const ConsoleObserveSchema = z.object({
  kind: z.literal('console'),
  entries: z
    .array(z.object({ level: z.string(), text: z.string(), location: z.string().optional() }))
    .default([]),
});

/**
 * `prepareStep`: fold mid-run messages into the next model turn. Drains the inbox
 * into `standing` — the run-long list of caller instructions — then, while any
 * exist, appends ONE user message rebuilt from the whole list.
 *
 * Rebuilt on EVERY step, not just the drain step: the SDK composes each step's
 * prompt fresh from `[...initialMessages, ...responseMessages]` and never persists
 * a `prepareStep` messages override, so an instruction injected once would reach
 * the driver for exactly one step and then vanish. Because the base `messages`
 * arrive without the previous step's injection, re-appending the single rebuilt
 * block never accumulates duplicates. Returns `{}` when no instructions exist.
 */
export function foldInstructionsIntoStep(
  inbox: LoopInbox,
  standing: string[],
  messages: ModelMessage[],
): { messages: ModelMessage[] } | Record<string, never> {
  standing.push(...inbox.drain());
  if (standing.length === 0) return {};
  const injected: ModelMessage = {
    role: 'user',
    content: `Mid-run instructions from the caller (still in effect):\n${standing
      .map((message) => `- ${message}`)
      .join('\n')}\nFold these in, then continue.`,
  };
  return { messages: [...messages, injected] };
}

/** What a pruned frame collapses to — tells the driver how to get a fresh one. */
export const STALE_FRAME_NOTE = '[stale frame removed — call look again for a fresh screenshot]';

/** Whether a tool-result part carries a self-look frame (`content` output with `file-data`). */
function isLookFrame(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false;
  const p = part as {
    type?: string;
    toolName?: string;
    output?: { type?: string; value?: unknown };
  };
  return (
    p.type === 'tool-result' &&
    p.toolName === 'look' &&
    p.output?.type === 'content' &&
    Array.isArray(p.output.value) &&
    p.output.value.some((v) => (v as { type?: string })?.type === 'file-data')
  );
}

/** Collapse every `file-data` part of a look tool-result to the stale-frame note. */
function stripFrame(message: ModelMessage): ModelMessage {
  if (!Array.isArray(message.content)) return message;
  const content = message.content.map((part) => {
    if (!isLookFrame(part)) return part;
    const p = part as { output: { value: Array<{ type?: string }> } };
    return {
      ...part,
      output: {
        ...p.output,
        value: p.output.value.map((v) =>
          v?.type === 'file-data' ? { type: 'text' as const, text: STALE_FRAME_NOTE } : v,
        ),
      },
    };
  });
  return { ...message, content } as ModelMessage;
}

/**
 * Keep only the NEWEST self-look frame in the transcript. The SDK re-sends every
 * tool result on every step, so each `look` image would otherwise ride along for
 * the rest of the run — N looks × M steps of image tokens. Rebuilt per step in
 * `prepareStep` (overrides never persist), like the instruction fold. Returns the
 * SAME array when there is at most one frame, preserving the no-change fast path.
 */
export function pruneStaleFrames(messages: ModelMessage[]): ModelMessage[] {
  const frameIndexes: number[] = [];
  messages.forEach((message, index) => {
    if (
      message.role === 'tool' &&
      Array.isArray(message.content) &&
      message.content.some(isLookFrame)
    ) {
      frameIndexes.push(index);
    }
  });
  if (frameIndexes.length <= 1) return messages;
  const stale = new Set(frameIndexes.slice(0, -1));
  return messages.map((message, index) => (stale.has(index) ? stripFrame(message) : message));
}

/** Steps left at or below which the driver is nudged to wrap up and `report`. */
export const BUDGET_WARN = 6;

/**
 * A step-budget reminder folded into the turn as the run nears its cap — so the
 * driver converges on `report` instead of churning to the hard `stepCountIs` stop
 * (which leaves an empty, verdict-less `failed` run). `null` while there is ample
 * budget. `stepNumber` is the 0-based index of the step about to run.
 */
export function budgetNudge(stepNumber: number, maxSteps: number): string | null {
  const remaining = maxSteps - stepNumber;
  if (remaining > BUDGET_WARN) return null;
  if (remaining <= 1) {
    return 'This is your final step. Call `report` NOW with every bug and visual issue you have found so far — do not act again.';
  }
  return `Step budget almost spent: ~${remaining} of ${maxSteps} steps left. Finish exploring and call \`report\` soon with all findings; an unreported run is wasted.`;
}

/**
 * Lift a finished step's `look` results into visual findings — each issue the
 * vision guy flagged, carrying the frame it was judged on as evidence.
 */
export function visualFrom(toolResults: FinishedStep['toolResults']): VisualIssue[] {
  const issues: VisualIssue[] = [];
  for (const result of toolResults) {
    if (result.toolName !== 'look') continue;
    const parsed = LookVisualSchema.safeParse(result.output);
    if (!parsed.success) continue;
    const { screenshot } = parsed.data;
    for (const issue of parsed.data.issues) {
      issues.push({
        issue: issue.what,
        where: issue.where,
        severity: issue.severity,
        ...(screenshot !== undefined && { screenshot }),
      });
    }
  }
  return issues;
}

/**
 * Lift a finished step's `observe` console reads into bugs — ERROR rows only
 * (warn/log/info are working noise, not findings). The console channel is a ring
 * buffer read non-destructively, so a re-read returns rows already lifted;
 * {@link progressForStep} dedupes by message before they land.
 */
export function consoleBugsFrom(toolResults: FinishedStep['toolResults']): Bug[] {
  const bugs: Bug[] = [];
  for (const result of toolResults) {
    if (result.toolName !== 'observe') continue;
    const parsed = ConsoleObserveSchema.safeParse(result.output);
    if (!parsed.success) continue;
    for (const entry of parsed.data.entries) {
      if (entry.level !== 'error') continue;
      bugs.push({
        kind: 'console',
        detail: entry.text,
        ...(entry.location !== undefined && { evidence: entry.location }),
      });
    }
  }
  return bugs;
}

/** Dedupe key for a streamed finding — its message, case- and whitespace-insensitive. */
function messageKey(...parts: string[]): string {
  return parts.join(' @ ').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Append the `fresh` entries whose key is not already present; returns how many landed. */
function appendNew<T>(into: T[], fresh: readonly T[], key: (item: T) => string): number {
  const seen = new Set(into.map(key));
  let added = 0;
  for (const item of fresh) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    into.push(item);
    added += 1;
  }
  return added;
}

/**
 * The run-long accumulators the running flush reads: the shared act-`steps` trail
 * (the SAME array the `act` and `report` tools hold) plus the findings streamed off
 * the belt — `look`'s visual issues and error-level console rows. Streaming those
 * is what keeps a crashed, aborted or step-capped run's findings file complete;
 * before, they lived only in model context until `report`.
 */
export interface RunTrail {
  /** Ordered act trail, written by `act` as each act finishes (shared with `report`). */
  steps: Step[];
  /** Console bugs seen so far, deduped by message. */
  bugs: Bug[];
  /** Visual issues seen so far, deduped by issue + location. */
  visual: VisualIssue[];
}

/**
 * Decide the running-findings write for a finished step. Steps aside for the
 * terminal `report` step (it owns the verdict, and already merged the trail — see
 * `belt/report.ts`); otherwise appends this step's NEW `look` issues and console
 * errors to `running` (mutated in place) and returns the `running` findings to
 * persist — act steps are already on `running.steps`, recorded by `act` itself.
 * `null` when the step surfaced nothing new — no act, and every issue/error
 * already streamed.
 */
export function progressForStep(step: FinishedStep, running: RunTrail): Findings | null {
  if (step.toolCalls.some((call) => call.toolName === 'report')) return null;
  // Checked against `toolCalls`, NOT `toolResults`: a FAILED act still lands on
  // `running.steps` (`act` records `ok: false` at act time, then rethrows — see
  // `belt/act.ts`), but AI SDK 6 routes a rejected tool call to a `tool-error`
  // content part, never `toolResults` (see `describeStep` above). Gating on
  // `toolResults` would miss every failed act — exactly the step a crashed run
  // most needs preserved — unless the same step happened to also add a bug or
  // visual issue.
  const acted = step.toolCalls.some((call) => call.toolName === 'act');
  const bugs = appendNew(running.bugs, consoleBugsFrom(step.toolResults), (bug) =>
    messageKey(bug.detail),
  );
  const visual = appendNew(running.visual, visualFrom(step.toolResults), (issue) =>
    messageKey(issue.issue, issue.where),
  );
  if (!acted && bugs === 0 && visual === 0) return null;
  return {
    status: 'running',
    steps: [...running.steps],
    bugs: [...running.bugs],
    visual: [...running.visual],
  };
}

/** Everything the loop needs to run one debug session. */
export interface DebugAgentOptions {
  /** fast guy — the blind text driver running the high-frequency click loop. */
  model: LanguageModel;
  /** The inner belt the driver drives: `observe`/`act`/`look`/`report`. */
  tools: BeltTools;
  /** Composed system prompt (base + target addendum + story + criteria). */
  instructions: string;
  /** Mid-run message inbox, drained in `prepareStep`. */
  inbox: LoopInbox;
  /** Where the running step trail is flushed after each step. */
  progress: ProgressWriter;
  /** Optional sink for a human-readable step trail (`logs/agent.log`). */
  log?: AgentLog;
  /**
   * Shared act-trail the `act` tool writes, the running flush snapshots and the
   * `report` tool merges into the verdict's `steps` — pass the SAME array the
   * belt's act trail holds so the write and its counts agree. Defaults to a fresh
   * array (an unwired loop then flushes no steps).
   */
  trail?: Step[];
  /** Step safety cap; defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
}

/** Agent-log seam: one line per step (tool calls + any tool error), best-effort. */
export type AgentLog = (line: string) => void;

/** Summarize a finished step for `logs/agent.log`: the tools it called (+ input) + any error text. */
export function describeStep(step: FinishedStep, index: number): string {
  const calls =
    step.toolCalls
      .map((c) => (c.input !== undefined ? `${c.toolName}(${compactArg(c.input)})` : c.toolName))
      .join(', ') || '(no tool call)';
  const errors = (step.content ?? [])
    .filter((part) => part.type === 'tool-error')
    .map((part) => `${part.toolName ?? 'tool'}: ${errorText(part.error)}`);
  const tail = errors.length > 0 ? ` — ERROR ${errors.join('; ')}` : '';
  return `step ${index}: ${calls}${tail}`;
}

/** Compact one-line JSON of a tool-call input for the step log (truncated, never throws). */
function compactArg(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 159)}…` : s;
  } catch {
    return String(input);
  }
}

/** Pull a short error string out of a `tool-error` part's `error` field. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the debug agent loop. The driver runs `observe`→`act`→`look` until it
 * calls `report` (terminal) or hits the step cap. Between steps `prepareStep`
 * folds in mid-run messages; after each step `onStepFinish` flushes the running
 * trail (skipping the `report` step, which writes the final verdict itself).
 */
export function createDebugAgent(options: DebugAgentOptions): ToolLoopAgent<never, BeltTools> {
  const {
    model,
    tools,
    instructions,
    inbox,
    progress,
    log,
    maxSteps = DEFAULT_MAX_STEPS,
    trail = [],
  } = options;
  let stepIndex = 0;
  // Run-long list of mid-run caller instructions: drained from the inbox once,
  // re-folded into EVERY step's prompt (the SDK never persists a prepareStep override).
  const standing: string[] = [];
  // The running flush's accumulators. `steps` IS the shared act trail (same array
  // the `act` and `report` tools hold — `act` writes it at act time); bugs/visual
  // accumulate here only — they are streamed evidence, and the driver owns the
  // terminal verdict's own arrays.
  const running: RunTrail = { steps: trail, bugs: [], visual: [] };
  return new ToolLoopAgent<never, BeltTools>({
    model,
    tools,
    instructions,
    stopWhen: [stepCountIs(maxSteps), hasToolCall('report')],
    prepareStep: ({ messages, stepNumber }) => {
      // Self-look frame hygiene first: only the newest screenshot stays live.
      const pruned = pruneStaleFrames(messages);
      const withInbox = foldInstructionsIntoStep(inbox, standing, pruned);
      const base = 'messages' in withInbox ? withInbox.messages : pruned;
      const nudge = budgetNudge(stepNumber, maxSteps);
      if (nudge) return { messages: [...base, { role: 'user', content: nudge }] };
      if (base === messages) return {};
      return { messages: base };
    },
    onStepFinish: async (step) => {
      stepIndex += 1;
      log?.(describeStep(step, stepIndex));
      // Stream this step's new `look` issues + console errors and flush a running
      // snapshot of the shared trail (`act` already recorded its own steps there).
      // The terminal `report` step writes its own verdict — with that same trail
      // merged into `steps` (see `createReportTool`) — so the running flush steps
      // aside for it (`progressForStep` returns null on the report step).
      const snapshot = progressForStep(step, running);
      if (snapshot) await progress.writeFindings(snapshot);
    },
  });
}

/** How to run a built loop to its verdict. */
export interface RunDebugLoopOptions {
  /** The agent from {@link createDebugAgent}. */
  agent: ToolLoopAgent<never, BeltTools>;
  /** Aborts the in-flight model/tool calls — wired to `end_session`. */
  abortSignal?: AbortSignal;
  /** Override the kickoff turn (defaults to {@link KICKOFF_PROMPT}). */
  prompt?: string;
}

/**
 * Run the loop to its verdict. Resolves with the agent's generate result once the
 * driver reports (or the step cap trips); rejects if aborted (fail loud — the
 * session decides what an aborted run means).
 */
export function runDebugLoop(options: RunDebugLoopOptions) {
  const { agent, abortSignal, prompt = KICKOFF_PROMPT } = options;
  return agent.generate({ prompt, ...(abortSignal ? { abortSignal } : {}) });
}
