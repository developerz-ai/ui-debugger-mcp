/**
 * Scripted runs of the debug loop covering the inbox seam (mid-run message
 * folding) and abort-signal propagation — split out of `loop.scripted.test.ts`,
 * which focuses on findings persistence.
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
 * Minimal LanguageModelV3GenerateResult for one tool call in a step — the shape
 * `doGenerate` must return for the SDK loop to execute it.
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

/** A minimal real belt: observe → empty tree, act → records on the trail, look → no issues, report → writes verdict. */
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

test('prepareStep folds mid-run instructions AND the budget nudge together, nudge appended after the fold', async () => {
  // Isolated unit tests cover `budgetNudge` and `foldInstructionsIntoStep` alone
  // (see loop.test.ts); this drives them together through the real `prepareStep`
  // wired up by `createDebugAgent`, on a step where BOTH fire in the same turn —
  // `maxSteps: 3` keeps every step inside `BUDGET_WARN`'s window from the start.
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
        // Injected after step 1 starts — step 2's prepareStep drains it AND
        // budgetNudge fires for step 2 (remaining = 3 - 1 = 2 <= BUDGET_WARN).
        pending.push('check the mobile layout too');
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
    maxSteps: 3,
  });

  await runDebugLoop({ agent });
  expect(callCount).toBe(2);

  // Step 1 (stepNumber 0, remaining 3): budget nudge fires, but nothing was
  // injected into the inbox yet — no standing-instructions block.
  const call1 = seenPrompts[0] ?? [];
  expect(call1.some((t) => t.includes('Step budget almost spent'))).toBe(true);
  expect(call1.some((t) => t.includes('Mid-run instructions'))).toBe(false);

  // Step 2 (stepNumber 1, remaining 2): BOTH fire in the same turn.
  const call2 = seenPrompts[1] ?? [];
  const foldIndex = call2.findIndex((t) => t.includes('Mid-run instructions'));
  const nudgeIndex = call2.findIndex((t) => t.includes('Step budget almost spent'));
  expect(foldIndex).toBeGreaterThanOrEqual(0);
  expect(nudgeIndex).toBeGreaterThanOrEqual(0);
  expect(call2[foldIndex]).toContain('check the mobile layout too');
  // Ordering matches `createDebugAgent`'s `prepareStep`: the inbox fold builds
  // `base` first, the nudge is appended as one more message AFTER `base`.
  expect(foldIndex).toBeLessThan(nudgeIndex);
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
