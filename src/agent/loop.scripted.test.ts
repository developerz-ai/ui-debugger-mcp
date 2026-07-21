/**
 * Scripted end-to-end runs of the debug loop against a mock model + a real belt —
 * the pure-helper tests live in `loop.test.ts`.
 */

import { expect, test } from 'bun:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Findings } from '../findings/schema.js';
import { createReportTool } from './belt/report.js';
import { type ActTrail, createActTrail } from './belt/trail.js';
import {
  type BeltTools,
  createDebugAgent,
  type LoopInbox,
  type ProgressWriter,
  runDebugLoop,
} from './loop.js';

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

/**
 * Minimal LanguageModelV3GenerateResult for one or more tool calls in the SAME
 * step — the shape `doGenerate` must return for the SDK loop to execute them. The
 * SDK runs a step's calls concurrently, so several here means a real race.
 */
function toolCallsResponse(...calls: Array<{ id: string; toolName: string; args: unknown }>) {
  return {
    content: calls.map((call) => ({
      type: 'tool-call' as const,
      toolCallId: call.id,
      toolName: call.toolName,
      input: JSON.stringify(call.args),
    })),
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

/** One tool call in a step — the common case. */
function toolCallResponse(id: string, toolName: string, args: unknown) {
  return toolCallsResponse({ id, toolName, args });
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
 * - act     → records its step on the shared trail, like the real `act` does
 * - look    → description (no step trail)
 * - report  → writes verdict via the provided writer and signals stop
 *
 * `act` takes a tick of real work between announcing itself and recording, so a
 * `report` in the SAME step genuinely races it (as it does in a live run).
 */
function realBelt(progress: ProgressWriter, trail: ActTrail = createActTrail()): BeltTools {
  return {
    observe: tool({
      description: 'observe',
      inputSchema: z.object({ kind: z.string() }),
      execute: async () => ({ kind: 'tree', count: 0, nodes: [] }),
    }),
    act: tool({
      description: 'act',
      inputSchema: z.object({ action: z.string(), target: z.string().optional() }),
      execute: async (input) => {
        const settle = trail.begin();
        const label = `did ${input.action}${input.target ? ` on ${input.target}` : ''}`;
        try {
          await new Promise((resolve) => setTimeout(resolve, 5));
          trail.record({ step: label, ok: true, screenshot: '001.png' });
          return { action: input.action, label, ok: true, screenshot: '001.png' };
        } finally {
          settle();
        }
      },
    }),
    look: tool({
      description: 'look',
      inputSchema: z.object({ question: z.string().optional() }),
      execute: async () => ({ description: 'looks fine', issues: [] }),
    }),
    report: createReportTool(progress, () => trail.settled()),
  };
}

test('scripted loop (observe→act→report) records running steps and finalizes findings', async () => {
  const { written, writer } = findingsTracker();
  const trail = createActTrail();
  const belt = realBelt(writer, trail);

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
    trail: trail.steps,
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

test('an act emitted in the SAME step as report still reaches the verdict', async () => {
  const { written, writer } = findingsTracker();
  const trail = createActTrail();
  const belt = realBelt(writer, trail);

  // The driver ignores "report is terminal" and fires both calls at once. The SDK
  // runs them concurrently, so `report` writes while the act is still in flight —
  // the verdict must still carry the last thing the run actually did.
  const model = new MockLanguageModelV3({
    doGenerate: async () =>
      toolCallsResponse(
        { id: 'c1', toolName: 'act', args: { action: 'click', target: 'Pay' } },
        { id: 'c2', toolName: 'report', args: { status: 'passed', summary: 'Checkout works.' } },
      ),
  });

  const agent = createDebugAgent({
    model,
    tools: belt,
    instructions: 'debug this app',
    inbox: fakeInbox(),
    progress: writer,
    trail: trail.steps,
    maxSteps: 10,
  });

  await runDebugLoop({ agent });

  const verdict = written.filter((f) => f.status !== 'running').at(-1);
  if (!verdict) throw new Error('expected a terminal findings write');
  expect(verdict.steps).toEqual([{ step: 'did click on Pay', ok: true, screenshot: '001.png' }]);
  // And no `running` snapshot raced the verdict onto disk after it.
  expect(written.at(-1)?.status).toBe('passed');
});

test('scripted loop streams look issues + console errors before any verdict', async () => {
  const { written, writer } = findingsTracker();
  const belt = realBelt(writer);
  // The two channels the running flush lifts: a console read with an error row,
  // then a look that flags a visual issue.
  belt.observe = tool({
    description: 'observe',
    inputSchema: z.object({ kind: z.string() }),
    execute: async () => ({
      kind: 'console',
      count: 1,
      entries: [
        { level: 'error', text: 'TypeError: cart is undefined', location: 'app.js:12:3' },
        { level: 'log', text: 'checkout mounted' },
      ],
    }),
  });
  belt.look = tool({
    description: 'look',
    inputSchema: z.object({ question: z.string().optional() }),
    execute: async () => ({
      description: 'the total overlaps the button',
      issues: [{ what: 'total overlaps the pay button', where: 'cart footer', severity: 'high' }],
      screenshot: '002-cart.png',
    }),
  });

  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse('c1', 'observe', { kind: 'console' });
      if (callCount === 2) return toolCallResponse('c2', 'look', { question: 'is it aligned?' });
      // Abort-like end: the driver never reports, so only the streamed flushes exist.
      return toolCallResponse('c3', 'report', { status: 'failed' });
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

  const running = written.filter((f) => f.status === 'running');
  const latest = running.at(-1);
  if (!latest) throw new Error('expected a running findings write');
  expect(latest.bugs).toEqual([
    { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
  ]);
  expect(latest.visual).toEqual([
    {
      issue: 'total overlaps the pay button',
      where: 'cart footer',
      severity: 'high',
      screenshot: '002-cart.png',
    },
  ]);
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
