import { expect, test } from 'bun:test';
import { type ModelMessage, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Findings, Step } from '../findings/schema.js';
import { createReportTool } from './belt/report.js';
import {
  type BeltTools,
  BUDGET_WARN,
  budgetNudge,
  createDebugAgent,
  DEFAULT_MAX_STEPS,
  foldInstructionsIntoStep,
  KICKOFF_PROMPT,
  type LoopInbox,
  type ProgressWriter,
  progressForStep,
  pruneStaleFrames,
  runDebugLoop,
  STALE_FRAME_NOTE,
  stepTrailFrom,
} from './loop.js';

test('budgetNudge stays silent while there is ample budget', () => {
  expect(budgetNudge(0, 30)).toBeNull();
  expect(budgetNudge(30 - BUDGET_WARN - 1, 30)).toBeNull();
});

test('budgetNudge warns as the cap nears, and hard-stops on the last step', () => {
  expect(budgetNudge(30 - BUDGET_WARN, 30)).toContain('budget almost spent');
  const last = budgetNudge(29, 30);
  expect(last).toContain('final step');
  expect(last).toContain('report');
});

/** A belt of four no-op tools — enough to construct the agent without driving it. */
function fakeBelt(): BeltTools {
  const stub = () =>
    tool({ description: 'stub', inputSchema: z.object({}), execute: async () => ({}) });
  return { observe: stub(), act: stub(), look: stub(), report: stub() };
}

/** An inbox that hands back `items` once, then drains empty. */
function fakeInbox(...items: string[]): LoopInbox {
  let pending = items;
  return {
    drain: () => {
      const out = pending;
      pending = [];
      return out;
    },
  };
}

const actResult = (label: string, screenshot: string, ok = true) => ({
  toolName: 'act',
  output: { action: 'click', label, ok, screenshot },
});

test('foldInstructionsIntoStep returns no override when nothing was ever injected', () => {
  expect(foldInstructionsIntoStep(fakeInbox(), [], [])).toEqual({});
});

test('foldInstructionsIntoStep appends one standing-instructions message, preserving prior messages', () => {
  const prior: ModelMessage[] = [{ role: 'user', content: 'go' }];
  const standing: string[] = [];
  const out = foldInstructionsIntoStep(
    fakeInbox('check mobile view', 'skip login'),
    standing,
    prior,
  );
  if (!('messages' in out)) throw new Error('expected a messages override');
  expect(out.messages).toHaveLength(2);
  expect(out.messages[0]).toEqual({ role: 'user', content: 'go' });
  const injected = out.messages.at(-1);
  expect(injected?.role).toBe('user');
  const content = injected?.content;
  expect(typeof content).toBe('string');
  if (typeof content === 'string') {
    expect(content).toContain('Mid-run instructions');
    expect(content).toContain('check mobile view');
    expect(content).toContain('skip login');
  }
  expect(standing).toEqual(['check mobile view', 'skip login']);
});

test('foldInstructionsIntoStep re-appends standing instructions after the inbox drained empty', () => {
  const standing = ['check mobile view'];
  // A later step: inbox already empty, base messages fresh from the SDK (no prior injection).
  const out = foldInstructionsIntoStep(fakeInbox(), standing, [{ role: 'user', content: 'go' }]);
  if (!('messages' in out)) throw new Error('expected a messages override');
  expect(out.messages).toHaveLength(2);
  const content = out.messages.at(-1)?.content;
  expect(typeof content === 'string' && content.includes('check mobile view')).toBe(true);
  // One rebuilt block from the persistent list — never accumulated duplicates.
  expect(standing).toEqual(['check mobile view']);
});

test('stepTrailFrom lifts act results into steps and ignores everything else', () => {
  const steps = stepTrailFrom([
    { toolName: 'observe', output: { kind: 'tree' } },
    actResult('click button "Save"', '001-save.png'),
    { toolName: 'look', output: { description: 'fine', issues: [] } },
    { toolName: 'act', output: { malformed: true } },
  ]);
  expect(steps).toEqual([{ step: 'click button "Save"', ok: true, screenshot: '001-save.png' }]);
});

test('stepTrailFrom carries the recorded ok flag — never hardcodes success', () => {
  const steps = stepTrailFrom([actResult('click button "Pay"', '002-pay.png', false)]);
  expect(steps).toEqual([{ step: 'click button "Pay"', ok: false, screenshot: '002-pay.png' }]);
});

test('progressForStep steps aside for the terminal report step (verdict owned by report)', () => {
  const trail: Step[] = [];
  const out = progressForStep(
    { toolCalls: [{ toolName: 'report' }], toolResults: [actResult('click x', '1.png')] },
    trail,
  );
  expect(out).toBeNull();
  expect(trail).toHaveLength(0);
});

test('progressForStep skips steps that produced no act results', () => {
  const out = progressForStep(
    { toolCalls: [{ toolName: 'observe' }], toolResults: [{ toolName: 'observe', output: {} }] },
    [],
  );
  expect(out).toBeNull();
});

test('progressForStep flushes a running trail and accumulates across steps', () => {
  const trail: Step[] = [];
  const first = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [actResult('typed email', '1.png')] },
    trail,
  );
  expect(first).toEqual({
    status: 'running',
    steps: [{ step: 'typed email', ok: true, screenshot: '1.png' }],
    bugs: [],
    visual: [],
  });
  const second = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [actResult('clicked Submit', '2.png')] },
    trail,
  );
  expect(second?.steps).toHaveLength(2);
  expect(trail).toHaveLength(2);
});

test('createDebugAgent builds an agent driving the four-tool belt', () => {
  const agent = createDebugAgent({
    model: new MockLanguageModelV3(),
    tools: fakeBelt(),
    instructions: 'system prompt',
    inbox: fakeInbox(),
    progress: { writeFindings: async () => 'findings.json' },
  });
  expect(Object.keys(agent.tools).sort()).toEqual(['act', 'look', 'observe', 'report']);
});

test('loop constants are sane', () => {
  expect(DEFAULT_MAX_STEPS).toBeGreaterThan(0);
  expect(KICKOFF_PROMPT).toContain('report');
});

// ---------------------------------------------------------------------------
// Integration: scripted loop runs through observe→act→report
// ---------------------------------------------------------------------------

/**
 * Minimal LanguageModelV3GenerateResult for one tool call — the shape
 * `doGenerate` must return for the SDK loop to execute that tool.
 */
function toolCallResponse(id: string, toolName: string, args: unknown) {
  return {
    content: [
      { type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(args) },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1 as number | undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1 as number | undefined, reasoning: undefined },
    },
    warnings: [] as [],
  };
}

/** A findings tracker shared by the progress seam and the report tool. */
function findingsTracker() {
  const written: Findings[] = [];
  const writer = {
    writeFindings: async (f: Findings): Promise<string> => {
      written.push(f);
      return 'findings.json';
    },
  };
  return { written, writer };
}

/**
 * Build a minimal real belt for integration tests:
 * - observe → empty tree (no step trail)
 * - act     → { action, label, ok, screenshot } so step trail picks it up
 * - look    → description (no step trail)
 * - report  → writes verdict via the provided writer and signals stop
 */
function realBelt(progress: ProgressWriter): BeltTools {
  return {
    observe: tool({
      description: 'observe',
      inputSchema: z.object({ kind: z.string() }),
      execute: async () => ({ kind: 'tree', count: 0, nodes: [] }),
    }),
    act: tool({
      description: 'act',
      inputSchema: z.object({ action: z.string(), target: z.string().optional() }),
      execute: async (input) => ({
        action: input.action,
        label: `did ${input.action}${input.target ? ` on ${input.target}` : ''}`,
        ok: true,
        screenshot: '001.png',
      }),
    }),
    look: tool({
      description: 'look',
      inputSchema: z.object({ question: z.string().optional() }),
      execute: async () => ({ description: 'looks fine', issues: [] }),
    }),
    report: createReportTool(progress),
  };
}

test('scripted loop (observe→act→report) records running steps and finalizes findings', async () => {
  const { written, writer } = findingsTracker();
  const belt = realBelt(writer);

  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse('c1', 'observe', { kind: 'tree' });
      if (callCount === 2)
        return toolCallResponse('c2', 'act', { action: 'click', target: 'Save' });
      return toolCallResponse('c3', 'report', { status: 'passed', summary: 'All checks pass.' });
    },
  });

  const agent = createDebugAgent({
    model,
    tools: belt,
    instructions: 'debug this app',
    inbox: fakeInbox(),
    progress: writer,
    maxSteps: 10,
  });

  await runDebugLoop({ agent });

  // Running findings: the act step triggers a trail flush
  const running = written.filter((f) => f.status === 'running');
  expect(running.length).toBeGreaterThanOrEqual(1);
  const firstRunning = running[0];
  if (!firstRunning) throw new Error('expected at least one running findings write');
  expect(firstRunning.steps[0]?.step).toBe('did click on Save');
  expect(firstRunning.steps[0]?.screenshot).toBe('001.png');

  // Terminal findings: the report tool writes the verdict
  const terminal = written.filter((f) => f.status !== 'running');
  expect(terminal.length).toBeGreaterThanOrEqual(1);
  const verdict = terminal.at(-1);
  if (!verdict) throw new Error('expected a terminal findings write');
  expect(verdict.status).toBe('passed');
  expect(verdict.summary).toBe('All checks pass.');

  // All three steps ran: observe, act, report
  expect(callCount).toBe(3);
});

test('mid-run injected message folds into the next model turn', async () => {
  const { writer } = findingsTracker();
  const belt = realBelt(writer);

  // Mutable inbox: empty for step 1's prepareStep, then filled from inside
  // doGenerate call 1 so step 2's prepareStep drains it.
  const pending: string[] = [];
  const inbox: LoopInbox = {
    drain() {
      const out = [...pending];
      pending.length = 0;
      return out;
    },
  };

  // Capture the raw prompt messages for each doGenerate call so we can
  // assert the injected message is present in call 2 but not call 1.
  const seenPrompts: string[][] = [];

  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      callCount++;

      // Collect all text across user messages for this call.
      const texts: string[] = [];
      for (const msg of opts.prompt) {
        if (msg.role === 'user') {
          for (const part of msg.content) {
            if (part.type === 'text') texts.push(part.text);
          }
        }
      }
      seenPrompts.push(texts);

      if (callCount === 1) {
        // Inject mid-run message AFTER step 1 starts — prepareStep for step 2
        // will drain it before doGenerate call 2.
        pending.push('check mobile view');
        return toolCallResponse('c1', 'observe', { kind: 'tree' });
      }
      return toolCallResponse('c2', 'report', { status: 'passed' });
    },
  });

  const agent = createDebugAgent({
    model,
    tools: belt,
    instructions: 'debug',
    inbox,
    progress: writer,
    maxSteps: 10,
  });

  await runDebugLoop({ agent });

  expect(callCount).toBe(2);

  // Call 1 must NOT contain the injected message (it was injected after call 1 started)
  const call1Text = seenPrompts[0]?.join('\n') ?? '';
  expect(call1Text).not.toContain('check mobile view');

  // Call 2 MUST contain the injected message (prepareStep drained it before call 2)
  const call2Text = seenPrompts[1]?.join('\n') ?? '';
  expect(call2Text).toContain('Mid-run instructions');
  expect(call2Text).toContain('check mobile view');
});

test('mid-run instructions persist into EVERY later step, without duplicating', async () => {
  const { writer } = findingsTracker();
  const belt = realBelt(writer);

  const pending: string[] = [];
  const inbox: LoopInbox = {
    drain() {
      const out = [...pending];
      pending.length = 0;
      return out;
    },
  };

  const seenPrompts: string[][] = [];
  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async (opts) => {
      callCount++;
      const texts: string[] = [];
      for (const msg of opts.prompt) {
        if (msg.role === 'user') {
          for (const part of msg.content) {
            if (part.type === 'text') texts.push(part.text);
          }
        }
      }
      seenPrompts.push(texts);

      if (callCount === 1) {
        // Injected after step 1 starts; the inbox drains it once, before call 2.
        pending.push('also verify the footer links');
        return toolCallResponse('c1', 'observe', { kind: 'tree' });
      }
      if (callCount < 4) return toolCallResponse(`c${callCount}`, 'observe', { kind: 'tree' });
      return toolCallResponse('c4', 'report', { status: 'passed' });
    },
  });

  const agent = createDebugAgent({
    model,
    tools: belt,
    instructions: 'debug',
    inbox,
    progress: writer,
    maxSteps: 10,
  });

  await runDebugLoop({ agent });
  expect(callCount).toBe(4);

  // Step 1: injected after the call started — absent.
  expect(seenPrompts[0]?.join('\n')).not.toContain('verify the footer links');

  // Steps 2, 3 AND 4: the instruction is still in effect — the inbox drained empty
  // after step 2, but the standing list re-folds it into every subsequent prompt.
  for (const call of [1, 2, 3]) {
    const text = seenPrompts[call]?.join('\n') ?? '';
    expect(text).toContain('Mid-run instructions');
    expect(text).toContain('also verify the footer links');
    // Exactly one occurrence: one rebuilt block per step, never accumulation.
    expect(text.split('also verify the footer links').length - 1).toBe(1);
  }
});

test('abort signal propagates: loop rejects when the model throws AbortError', async () => {
  const { writer } = findingsTracker();
  const belt = realBelt(writer);

  let callCount = 0;
  const controller = new AbortController();

  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      if (callCount === 1) {
        // First call succeeds; abort fires so next call is never reached cleanly
        controller.abort();
        return toolCallResponse('c1', 'observe', { kind: 'tree' });
      }
      // Simulate what happens when the signal is aborted: the network call throws
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    },
  });

  const agent = createDebugAgent({
    model,
    tools: belt,
    instructions: 'debug',
    inbox: fakeInbox(),
    progress: writer,
    maxSteps: 10,
  });

  await expect(runDebugLoop({ agent, abortSignal: controller.signal })).rejects.toThrow();
});

// --- pruneStaleFrames --------------------------------------------------------

/** A tool message carrying one self-look frame (content output with file-data). */
function lookFrameMessage(id: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: id,
        toolName: 'look',
        output: {
          type: 'content',
          value: [
            { type: 'text', text: 'screenshot saved: s.png' },
            { type: 'file-data', data: 'AAAA', mediaType: 'image/png' },
          ],
        },
      },
    ],
  } as unknown as ModelMessage;
}

test('pruneStaleFrames keeps only the newest look frame; older ones collapse to a note', () => {
  const user: ModelMessage = { role: 'user', content: 'go' };
  const messages = [user, lookFrameMessage('a'), lookFrameMessage('b')];
  const pruned = pruneStaleFrames(messages);

  const partsOf = (m: ModelMessage) =>
    (m.content as Array<{ output: { value: Array<{ type: string; text?: string }> } }>)[0]?.output
      .value;
  // older frame stripped to the stale note
  expect(partsOf(pruned[1] as ModelMessage)?.map((v) => v.type)).toEqual(['text', 'text']);
  expect(partsOf(pruned[1] as ModelMessage)?.[1]?.text).toBe(STALE_FRAME_NOTE);
  // newest frame untouched
  expect(partsOf(pruned[2] as ModelMessage)?.map((v) => v.type)).toEqual(['text', 'file-data']);
  // untouched messages pass through by reference
  expect(pruned[0]).toBe(user);
});

test('pruneStaleFrames returns the SAME array when there is at most one frame', () => {
  const single = [{ role: 'user', content: 'go' } as ModelMessage, lookFrameMessage('only')];
  expect(pruneStaleFrames(single)).toBe(single);
  const none = [{ role: 'user', content: 'go' } as ModelMessage];
  expect(pruneStaleFrames(none)).toBe(none);
});

test('pruneStaleFrames ignores non-look tool results and non-content outputs', () => {
  const actResult = {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'x',
        toolName: 'act',
        output: { type: 'json', value: { label: 'click', screenshot: 's.png' } },
      },
    ],
  } as unknown as ModelMessage;
  const messages = [actResult, lookFrameMessage('a'), lookFrameMessage('b')];
  const pruned = pruneStaleFrames(messages);
  expect(pruned[0]).toBe(actResult);
});
