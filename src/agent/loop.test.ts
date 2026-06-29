import { expect, test } from 'bun:test';
import { type ModelMessage, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Findings, Step } from '../findings/schema.js';
import { createReportTool } from './belt/report.js';
import {
  type BeltTools,
  createDebugAgent,
  DEFAULT_MAX_STEPS,
  drainInboxIntoStep,
  KICKOFF_PROMPT,
  type LoopInbox,
  type ProgressWriter,
  progressForStep,
  runDebugLoop,
  stepTrailFrom,
} from './loop.js';

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

const actResult = (label: string, screenshot: string) => ({
  toolName: 'act',
  output: { action: 'click', label, screenshot },
});

test('drainInboxIntoStep returns no override when the inbox is empty', () => {
  expect(drainInboxIntoStep(fakeInbox(), [])).toEqual({});
});

test('drainInboxIntoStep appends one mid-run user message, preserving prior messages', () => {
  const prior: ModelMessage[] = [{ role: 'user', content: 'go' }];
  const out = drainInboxIntoStep(fakeInbox('check mobile view', 'skip login'), prior);
  if (!('messages' in out)) throw new Error('expected a messages override');
  expect(out.messages).toHaveLength(2);
  expect(out.messages[0]).toEqual({ role: 'user', content: 'go' });
  const injected = out.messages.at(-1);
  expect(injected?.role).toBe('user');
  const content = injected?.content;
  expect(typeof content).toBe('string');
  if (typeof content === 'string') {
    expect(content).toContain('mid-run');
    expect(content).toContain('check mobile view');
    expect(content).toContain('skip login');
  }
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
 * - act     → { action, label, screenshot } so step trail picks it up
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
  expect(call2Text).toContain('mid-run');
  expect(call2Text).toContain('check mobile view');
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
