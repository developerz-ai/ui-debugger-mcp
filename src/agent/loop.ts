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
 *   - **incremental findings** — `onStepFinish` lifts each step's `act` results
 *     into a running step trail and flushes it as `status: 'running'` findings,
 *     so `get_findings` shows live progress before the verdict lands.
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
import type { Findings, Step } from '../findings/schema.js';

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

/** The slice of a finished step the running flush reads — `act` results carry the trail. */
export interface FinishedStep {
  /** Tools called this step; a `report` call marks the terminal step (verdict owned elsewhere). */
  toolCalls: ReadonlyArray<{ toolName: string; input?: unknown }>;
  /** Tool results this step; `act` outputs become step-trail entries. */
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
}

/** The `act` result fields lifted into the step trail: label, outcome, post-action frame. */
const ActStepSchema = z.object({ label: z.string(), ok: z.boolean(), screenshot: z.string() });

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
 * Lift a finished step's `act` results into ordered step-trail entries (each with
 * its frame). The outcome is the one `act` RECORDED, never assumed — an act that
 * threw produces no tool result at all and reaches the trail as `ok: false` at
 * failure time (see {@link FailedStepSink} in `belt/act.ts`).
 */
export function stepTrailFrom(
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>,
): Step[] {
  const steps: Step[] = [];
  for (const result of toolResults) {
    if (result.toolName !== 'act') continue;
    const parsed = ActStepSchema.safeParse(result.output);
    if (parsed.success) {
      steps.push({
        step: parsed.data.label,
        ok: parsed.data.ok,
        screenshot: parsed.data.screenshot,
      });
    }
  }
  return steps;
}

/**
 * Decide the running-findings write for a finished step. Steps aside for the
 * terminal `report` step (it owns the verdict) and for steps that produced no
 * `act` results; otherwise appends the fresh trail to `trail` (mutated in place)
 * and returns the `running` findings to persist.
 */
export function progressForStep(step: FinishedStep, trail: Step[]): Findings | null {
  if (step.toolCalls.some((call) => call.toolName === 'report')) return null;
  const fresh = stepTrailFrom(step.toolResults);
  if (fresh.length === 0) return null;
  trail.push(...fresh);
  return { status: 'running', steps: [...trail], bugs: [], visual: [] };
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
   * Shared act-trail the running flush appends to and the `report` tool overlays
   * as the verdict's authoritative `steps` — pass the SAME array to
   * {@link createReportTool}'s `getTrail` so the write and its counts agree.
   * Defaults to a fresh array (the report tool then keeps the driver's steps).
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
  const errors = step.toolResults
    .filter((r) => isErrorOutput(r.output))
    .map((r) => `${r.toolName}: ${errorText(r.output)}`);
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

/** Whether a tool result output looks like an error envelope (`{ error: ... }` / Error). */
function isErrorOutput(output: unknown): boolean {
  if (output instanceof Error) return true;
  return typeof output === 'object' && output !== null && 'error' in output;
}

/** Pull a short error string out of a tool result output. */
function errorText(output: unknown): string {
  if (output instanceof Error) return output.message;
  if (typeof output === 'object' && output !== null && 'error' in output) {
    const e = (output as { error: unknown }).error;
    return e instanceof Error ? e.message : String(e);
  }
  return String(output);
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
      // Append this step's `act` results to the shared trail and flush a running
      // snapshot. The terminal `report` step writes its own verdict — with this
      // same trail overlaid as `steps` (see `createReportTool`) — so the running
      // flush steps aside for it (`progressForStep` returns null on the report step).
      const running = progressForStep(step, trail);
      if (running) await progress.writeFindings(running);
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
