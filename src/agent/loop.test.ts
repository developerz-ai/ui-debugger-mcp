import { expect, test } from 'bun:test';
import { type ModelMessage, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import type { Step } from '../findings/schema.js';
import {
  type BeltTools,
  createDebugAgent,
  DEFAULT_MAX_STEPS,
  drainInboxIntoStep,
  KICKOFF_PROMPT,
  type LoopInbox,
  progressForStep,
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
