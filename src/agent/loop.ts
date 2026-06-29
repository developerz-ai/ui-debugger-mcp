/**
 * The debug agent loop — the fast guy's run, as a conversation.
 *
 * A {@link ToolLoopAgent} drives the inner belt (`observe`/`act`/`look`/`report`)
 * with the `driver` model until the goal is met (`report`, the terminal verdict)
 * or a safety step cap trips. Two things make it a *conversation*, not a job:
 *
 *   - **inbox** — `prepareStep` drains the session inbox between steps and folds
 *     any mid-run messages (the smart agent's `send_message`) into the next turn,
 *     so the driver adapts without restarting.
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
  toolCalls: ReadonlyArray<{ toolName: string }>;
  /** Tool results this step; `act` outputs become step-trail entries. */
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>;
}

/** The `act` result fields lifted into the step trail: its label and the post-action frame. */
const ActStepSchema = z.object({ label: z.string(), screenshot: z.string() });

/**
 * `prepareStep`: fold any mid-run messages into the next model turn. Drains the
 * inbox; when non-empty, appends one user message so the driver adapts before its
 * next action. Returns `{}` (no override) when the inbox is empty.
 */
export function drainInboxIntoStep(
  inbox: LoopInbox,
  messages: ModelMessage[],
): { messages: ModelMessage[] } | Record<string, never> {
  const pending = inbox.drain();
  if (pending.length === 0) return {};
  const injected: ModelMessage = {
    role: 'user',
    content: `New instructions from the smart agent (mid-run):\n${pending
      .map((message) => `- ${message}`)
      .join('\n')}\nFold these in, then continue.`,
  };
  return { messages: [...messages, injected] };
}

/** Lift a finished step's `act` results into ordered step-trail entries (each with its frame). */
export function stepTrailFrom(
  toolResults: ReadonlyArray<{ toolName: string; output: unknown }>,
): Step[] {
  const steps: Step[] = [];
  for (const result of toolResults) {
    if (result.toolName !== 'act') continue;
    const parsed = ActStepSchema.safeParse(result.output);
    if (parsed.success) {
      steps.push({ step: parsed.data.label, ok: true, screenshot: parsed.data.screenshot });
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
  /** Step safety cap; defaults to {@link DEFAULT_MAX_STEPS}. */
  maxSteps?: number;
}

/**
 * Build the debug agent loop. The driver runs `observe`→`act`→`look` until it
 * calls `report` (terminal) or hits the step cap. Between steps `prepareStep`
 * folds in mid-run messages; after each step `onStepFinish` flushes the running
 * trail (skipping the `report` step, which writes the final verdict itself).
 */
export function createDebugAgent(options: DebugAgentOptions): ToolLoopAgent<never, BeltTools> {
  const { model, tools, instructions, inbox, progress, maxSteps = DEFAULT_MAX_STEPS } = options;
  const trail: Step[] = [];
  return new ToolLoopAgent<never, BeltTools>({
    model,
    tools,
    instructions,
    stopWhen: [stepCountIs(maxSteps), hasToolCall('report')],
    prepareStep: ({ messages }) => drainInboxIntoStep(inbox, messages),
    onStepFinish: async (step) => {
      const findings = progressForStep(step, trail);
      if (findings) await progress.writeFindings(findings);
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
