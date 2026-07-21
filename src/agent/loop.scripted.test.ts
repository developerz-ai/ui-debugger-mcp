/**
 * Scripted end-to-end runs of the debug loop against a mock model + a real belt,
 * focused on findings persistence — the happy path, the same-step act+report
 * race, streamed findings, and a crash/abort that never reaches `report`.
 *
 * The pure-helper tests live in `loop.test.ts`; the inbox-folding + abort-signal
 * scripted runs live in `loop.inbox.test.ts`.
 */

import { expect, test } from 'bun:test';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { AgentError } from '../errors.js';
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

/**
 * A hand-rolled `act` tool that fails the way the real one does (see
 * `belt/act.ts`'s `runAct`): record `ok: false` on the shared trail at act time,
 * THEN rethrow — so the driver sees the error while the trail keeps the truth.
 * The SDK routes the throw to a `tool-error` content part, never `toolResults`.
 */
function failingAct(trail: ActTrail) {
  return tool({
    description: 'act',
    inputSchema: z.object({ action: z.string(), target: z.string().optional() }),
    execute: async (input): Promise<{ action: string; label: string; ok: true }> => {
      const settle = trail.begin();
      const label = `${input.action}${input.target ? ` ${input.target}` : ''}`;
      try {
        throw new AgentError(`no element matched ${JSON.stringify(input.target)}`);
      } catch (error) {
        trail.record({ step: label, ok: false, note: (error as Error).message });
        throw error;
      } finally {
        settle();
      }
    },
  });
}

test('crash/abort: findings.json keeps look issues, console bugs and a failed act — nothing found is lost', async () => {
  const { written, writer } = findingsTracker();
  const trail = createActTrail();
  const belt = realBelt(writer, trail);
  belt.observe = tool({
    description: 'observe',
    inputSchema: z.object({ kind: z.string() }),
    execute: async () => ({
      kind: 'console',
      count: 1,
      entries: [{ level: 'error', text: 'TypeError: cart is undefined', location: 'app.js:12:3' }],
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
  belt.act = failingAct(trail);

  let callCount = 0;
  const model = new MockLanguageModelV3({
    doGenerate: async () => {
      callCount++;
      if (callCount === 1) return toolCallResponse('c1', 'observe', { kind: 'console' });
      if (callCount === 2) return toolCallResponse('c2', 'look', { question: 'is it aligned?' });
      if (callCount === 3)
        return toolCallResponse('c3', 'act', { action: 'click', target: '#save' });
      // The driver never reaches `report` — the step cap below stops the loop
      // right after the failed act, standing in for a genuine crash/abort.
      throw new Error('unreachable: maxSteps must stop the loop before a 4th call');
    },
  });

  const agent = createDebugAgent({
    model,
    tools: belt,
    instructions: 'debug this app',
    inbox: fakeInbox(),
    progress: writer,
    trail: trail.steps,
    maxSteps: 3,
  });

  await runDebugLoop({ agent });

  expect(callCount).toBe(3);
  // No terminal verdict was ever written — `report` was never called.
  expect(written.every((f) => f.status === 'running')).toBe(true);

  const last = written.at(-1);
  if (!last) throw new Error('expected at least one running findings write');
  expect(last.bugs).toEqual([
    { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
  ]);
  expect(last.visual).toEqual([
    {
      issue: 'total overlaps the pay button',
      where: 'cart footer',
      severity: 'high',
      screenshot: '002-cart.png',
    },
  ]);
  // The failed act's trail entry — truthful `ok: false` + note — survived, not
  // just the flushes that happened to also carry a bug/visual delta.
  expect(last.steps).toEqual([
    { step: 'click #save', ok: false, note: 'no element matched "#save"' },
  ]);
});

// Mid-run instruction folding + abort-signal propagation live in `loop.inbox.test.ts`.
