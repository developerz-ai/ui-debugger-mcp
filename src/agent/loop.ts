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
 *   - **incremental findings** — `onStepFinish` snapshots the shared evidence
 *     trail (the belt's tools record each step, console error and look issue as
 *     it happens) and flushes it as `status: 'running'` findings, so
 *     `get_findings` streams findings before the verdict lands, and a run that
 *     crashes, aborts or hits the step cap keeps everything surfaced so far.
 *
 * Adapter-blind and model-blind like the belt: the loop never touches a protocol
 * or a provider. It is pure over two seams — {@link LoopInbox} (drain) and
 * {@link ProgressWriter} (flush) — so its logic unit-tests with no network. The
 * `report` step owns the terminal write, so the running flush steps aside for it
 * (never clobbers the verdict with a `running` snapshot). Abort propagates: an
 * aborted run rejects loud (wired to `end_session`), never a silent half-finish.
 */

import { type LanguageModel, type ModelMessage, stepCountIs, type Tool, ToolLoopAgent } from 'ai';
import type { Findings } from '../findings/schema.js';
import { EMPTY_EVIDENCE } from './belt/report.js';
import type { ActTrail, TrailEvidence } from './belt/trail.js';

/**
 * Safety cap on driver steps before the loop force-stops (paired with the
 * report-RESULT stop condition in {@link createDebugAgent}).
 *
 * Raised from 30 on measurement, not taste: the tool's own headline scenario —
 * register an account, log in, add two todos, toggle one, then exercise three
 * filters — spent all 30 steps and died one action short of reporting, which
 * costs the entire run (no verdict, no findings, full token spend). The observed
 * pace is ~3s/step, so 60 still finishes well inside the default 300s wall-clock
 * cap, which remains the real bound on what a run costs.
 */
export const DEFAULT_MAX_STEPS = 60;

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

/**
 * A tool-result part that may carry a self-look frame, narrowed to what the
 * prune reads: a `look` tool-result whose `content` output holds the frame.
 */
type FramePart = {
  type?: string;
  toolName?: string;
  output?: { type?: string; value?: unknown };
};

/** Where one live self-look frame sits in the transcript. */
type FrameSite = {
  /** Index of the message holding the frame. */
  messageIndex: number;
  /** Index of the tool-result part inside that message's content. */
  partIndex: number;
  /** Index of the `file-data` value inside that part's output value array. */
  valueIndex: number;
};

/** The content parts of a message as a plain array (empty for string content). */
function partsOf(message: ModelMessage): unknown[] {
  return Array.isArray(message.content) ? (message.content as unknown[]) : [];
}

/**
 * Every self-look frame in the transcript, in transcript order (message →
 * content part → output value).
 *
 * A frame is ONE `file-data` value part of a look tool-result. AI SDK 6 puts ALL
 * of a step's tool results into ONE `tool`-role message, so a step that called
 * `look` twice carries TWO frames inside a SINGLE message — counting messages
 * instead of frames let both survive and stacked the driver's images.
 */
function findFrames(messages: ModelMessage[]): FrameSite[] {
  const frames: FrameSite[] = [];
  messages.forEach((message, messageIndex) => {
    partsOf(message).forEach((part, partIndex) => {
      // A content array may hold a null/undefined part — skip it instead of
      // dereferencing it and killing the whole run inside `prepareStep`.
      if (typeof part !== 'object' || part === null) return;
      const p = part as FramePart;
      if (p.type !== 'tool-result' || p.toolName !== 'look') return;
      const output = p.output;
      if (output?.type !== 'content') return;
      const values = output.value;
      if (!Array.isArray(values)) return;
      (values as unknown[]).forEach((value, valueIndex) => {
        if ((value as { type?: string } | null | undefined)?.type === 'file-data') {
          frames.push({ messageIndex, partIndex, valueIndex });
        }
      });
    });
  });
  return frames;
}

/** Collapse the stale frames of ONE tool-result part to the stale-frame note. */
function collapseStaleFrames(part: unknown, staleValues: ReadonlySet<number>): unknown {
  const p = part as FramePart;
  const values = (p.output?.value ?? []) as unknown[];
  return {
    ...p,
    output: {
      ...p.output,
      value: values.map((value, valueIndex) =>
        staleValues.has(valueIndex) ? { type: 'text' as const, text: STALE_FRAME_NOTE } : value,
      ),
    },
  };
}

/**
 * Keep only the NEWEST self-look frame in the transcript. The SDK re-sends every
 * tool result on every step, so each `look` image would otherwise ride along for
 * the rest of the run — N looks × M steps of image tokens. Rebuilt per step in
 * `prepareStep` (overrides never persist), like the instruction fold.
 *
 * Counts FRAMES, not messages: AI SDK 6 collects ALL of a step's tool results
 * into ONE `tool`-role message, so a step that looked twice holds two frames in
 * a single message. The newest frame (last in transcript order) stays live and
 * every older one collapses to {@link STALE_FRAME_NOTE}; the rest of each
 * tool-result (its own text, a sibling `act` result) is left exactly as it was.
 * Returns the SAME array when the transcript holds at most ONE frame, keeping
 * the no-change fast path.
 */
export function pruneStaleFrames(messages: ModelMessage[]): ModelMessage[] {
  const frames = findFrames(messages);
  if (frames.length <= 1) return messages;
  // Every frame but the LAST is stale — group them by the part they live in.
  const staleByMessage = new Map<number, Map<number, Set<number>>>();
  for (const frame of frames.slice(0, -1)) {
    let parts = staleByMessage.get(frame.messageIndex);
    if (!parts) {
      parts = new Map<number, Set<number>>();
      staleByMessage.set(frame.messageIndex, parts);
    }
    let values = parts.get(frame.partIndex);
    if (!values) {
      values = new Set<number>();
      parts.set(frame.partIndex, values);
    }
    values.add(frame.valueIndex);
  }
  return messages.map((message, messageIndex) => {
    const staleParts = staleByMessage.get(messageIndex);
    if (!staleParts) return message;
    const content = partsOf(message).map((part, partIndex) => {
      const staleValues = staleParts.get(partIndex);
      return staleValues ? collapseStaleFrames(part, staleValues) : part;
    });
    return { ...message, content } as unknown as ModelMessage;
  });
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
 * Decide the running-findings write for a finished step. Steps aside for the
 * terminal `report` step (it owns the verdict, and already merged the trail — see
 * `belt/report.ts`); otherwise, when ANY evidence stream grew past what the last
 * flush already persisted, return the running findings to persist — a snapshot
 * COPY of the trail ({@link TrailEvidence}). `null` when the step surfaced
 * nothing new: no act recorded, every issue/error already streamed.
 *
 * Growth is read off the trail, not off the step's own tool results: the belt
 * records AT TOOL TIME — a FAILED act still lands on the trail (`belt/act.ts`
 * records `ok: false` then rethrows, and AI SDK 6 routes a rejected call to a
 * `tool-error` content part, never `toolResults`) — so the trail's growth is the
 * one signal that covers successes, failures and streamed findings alike.
 */
export function progressForStep(
  step: FinishedStep,
  evidence: TrailEvidence,
  flushed: TrailEvidence,
): Findings | null {
  // Gated on the report RESULT, not the report CALL. A `report` whose arguments
  // fail the Zod schema is never executed (AI SDK 6 marks it `invalid` and feeds
  // the driver a tool-error), yet it still appears in `toolCalls` — so a call-gated
  // early return dropped that step's acts, console errors and look issues in favour
  // of a verdict that was never written.
  if (step.toolResults.some((result) => result.toolName === 'report')) return null;
  // The arrays only ever grow (append + dedupe), so a length past the last flush
  // is exactly "this step surfaced something new".
  const grew =
    evidence.steps.length > flushed.steps.length ||
    evidence.bugs.length > flushed.bugs.length ||
    evidence.visual.length > flushed.visual.length;
  if (!grew) return null;
  return {
    status: 'running',
    steps: [...evidence.steps],
    bugs: [...evidence.bugs],
    visual: [...evidence.visual],
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
   * Shared evidence trail the belt's tools record into — `act` writes each step
   * as it finishes, `look` each flagged issue, `observe` each error-level console
   * row — the running flush snapshots it after every step, and the `report` tool
   * merges all three streams into the verdict. Pass the SAME trail the belt's
   * tools were built with so the write, the flushes and their counts agree.
   * Defaults to none: an unwired loop then has nothing to flush.
   */
  trail?: ActTrail;
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

/** Lead-in for the verdict note that carries mid-run messages the run never acted on. */
export const UNDELIVERED_NOTE =
  'Undelivered mid-run instruction(s) — they arrived after the driver’s last turn and were NOT acted on:';

/**
 * Fold still-pending inbox messages into the verdict's `summary`, so a caller
 * whose `send_message` landed after the final `prepareStep` learns it was never
 * folded into a turn. Non-object inputs (an invalid `report` call) pass through
 * untouched — the schema, not this, decides what a valid verdict is.
 */
export function appendUndelivered(input: unknown, pending: readonly string[]): unknown {
  if (pending.length === 0) return input;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;
  const record = input as Record<string, unknown>;
  const summary = typeof record.summary === 'string' ? record.summary : '';
  const note = `${UNDELIVERED_NOTE} ${pending.map((message) => `"${message}"`).join('; ')}`;
  return { ...record, summary: summary === '' ? note : `${summary}\n\n${note}` };
}

/**
 * Wrap the terminal `report` so the LAST inbox drain happens at verdict time.
 * `prepareStep` drains between steps only, so a message injected while the model
 * was producing the step that calls `report` is accepted by the session (the run
 * has not settled) and then folded into no turn at all — silently lost, with the
 * caller believing it was delivered. Draining here surfaces it in the verdict.
 */
function withUndeliveredInbox(report: Tool, inbox: LoopInbox): Tool {
  const original = report.execute;
  if (!original) return report;
  return {
    ...report,
    execute: (input, options) => original(appendUndelivered(input, inbox.drain()), options),
  };
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
    trail,
  } = options;
  let stepIndex = 0;
  // Run-long list of mid-run caller instructions: drained from the inbox once,
  // re-folded into EVERY step's prompt (the SDK never persists a prepareStep override).
  const standing: string[] = [];
  // What the running flush has already persisted. The trail's arrays only grow,
  // so growth past these lengths is exactly "this step surfaced something new".
  let flushed: TrailEvidence = EMPTY_EVIDENCE;
  return new ToolLoopAgent<never, BeltTools>({
    model,
    tools: { ...tools, report: withUndeliveredInbox(tools.report, inbox) },
    instructions,
    // Stop on the report RESULT, never on the report CALL. In AI SDK 6 a tool call
    // whose arguments fail Zod validation is NOT executed but IS pushed into
    // `toolCalls` as `{ invalid: true }` — so `hasToolCall('report')` ended the run
    // on a `report({status:"pass"})` that wrote nothing: full token spend, findings
    // stuck on the last `running` snapshot, no verdict. A result only exists when
    // `report` actually ran and wrote the verdict; anything else keeps the loop
    // going, and the driver gets the tool-error and retries.
    stopWhen: [
      stepCountIs(maxSteps),
      ({ steps }) => steps.at(-1)?.toolResults.some((r) => r.toolName === 'report') ?? false,
    ],
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
      // Stream whatever grew on the shared evidence trail this step (the belt's
      // tools already recorded it). The terminal `report` step writes its own
      // verdict — with that same trail merged in (see `createReportTool`) — so
      // the running flush steps aside for it (`progressForStep` returns null).
      const snapshot = progressForStep(step, trail ?? EMPTY_EVIDENCE, flushed);
      if (snapshot) {
        await progress.writeFindings(snapshot);
        flushed = {
          steps: snapshot.steps,
          bugs: snapshot.bugs,
          visual: snapshot.visual,
        };
      }
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
