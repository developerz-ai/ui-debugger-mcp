import { expect, test } from 'bun:test';
import { type ModelMessage, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import {
  type BeltTools,
  BUDGET_WARN,
  budgetNudge,
  consoleBugsFrom,
  createDebugAgent,
  DEFAULT_MAX_STEPS,
  describeStep,
  foldInstructionsIntoStep,
  KICKOFF_PROMPT,
  type LoopInbox,
  progressForStep,
  pruneStaleFrames,
  type RunTrail,
  STALE_FRAME_NOTE,
  visualFrom,
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

/**
 * What the `act` tool does to the shared trail before the step finishes: record the
 * step, then hand back the matching tool result (see `belt/act.ts`).
 */
const acted = (running: RunTrail, label: string, screenshot: string, ok = true) => {
  running.steps.push({ step: label, ok, screenshot });
  return actResult(label, screenshot, ok);
};

/** A vision-guy `look` result carrying flagged issues plus the frame they were judged on. */
const lookResult = (
  screenshot: string,
  ...issues: Array<{ what: string; where: string; severity: 'low' | 'medium' | 'high' }>
) => ({
  toolName: 'look',
  output: { description: 'seen', issues, screenshot },
});

/** An `observe` console read — the channel the running flush lifts error rows from. */
const consoleResult = (...entries: Array<{ level: string; text: string; location?: string }>) => ({
  toolName: 'observe',
  output: { kind: 'console', count: entries.length, entries },
});

/** Fresh run-long accumulators for the running flush. */
const runTrail = (): RunTrail => ({ steps: [], bugs: [], visual: [] });

/**
 * A `tool-error` content part — AI SDK 6's shape for a rejected tool call (never
 * `toolResults`; see `describeStep` and `progressForStep`'s `acted` check below).
 */
const toolErrorPart = (toolName: string, error: unknown) => ({
  type: 'tool-error',
  toolName,
  error,
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

test('visualFrom lifts vision-guy issues with their frame, and ignores a self-look result', () => {
  const issues = visualFrom([
    lookResult('003-cart.png', {
      what: 'total is cut off',
      where: 'cart footer',
      severity: 'high',
    }),
    // self-look: the multimodal driver judged the frame itself — no issues[] to lift
    { toolName: 'look', output: { screenshot: '004.png', bytes: 12, prompt: 'q', frame: 'AAAA' } },
    { toolName: 'act', output: { label: 'click', ok: true, screenshot: '005.png' } },
  ]);
  expect(issues).toEqual([
    {
      issue: 'total is cut off',
      where: 'cart footer',
      severity: 'high',
      screenshot: '003-cart.png',
    },
  ]);
});

test('consoleBugsFrom lifts error rows only, keeping the source location as evidence', () => {
  const bugs = consoleBugsFrom([
    consoleResult(
      { level: 'error', text: 'TypeError: x is undefined', location: 'app.js:12:3' },
      { level: 'warn', text: 'deprecated api' },
      { level: 'error', text: 'failed to fetch' },
    ),
    { toolName: 'observe', output: { kind: 'tree', count: 0, nodes: [] } },
  ]);
  expect(bugs).toEqual([
    { kind: 'console', detail: 'TypeError: x is undefined', evidence: 'app.js:12:3' },
    { kind: 'console', detail: 'failed to fetch' },
  ]);
});

test('progressForStep steps aside for the terminal report step (verdict owned by report)', () => {
  const running = runTrail();
  const out = progressForStep(
    { toolCalls: [{ toolName: 'report' }], toolResults: [acted(running, 'click x', '1.png')] },
    running,
  );
  // No running write to clobber the verdict — but the act itself is NOT lost: `act`
  // recorded it on the shared trail, and `report` merged that trail into `steps`.
  expect(out).toBeNull();
  expect(running.steps).toEqual([{ step: 'click x', ok: true, screenshot: '1.png' }]);
});

test('progressForStep skips steps that surfaced nothing new', () => {
  const out = progressForStep(
    { toolCalls: [{ toolName: 'observe' }], toolResults: [{ toolName: 'observe', output: {} }] },
    runTrail(),
  );
  expect(out).toBeNull();
});

test('progressForStep flushes a running trail and accumulates across steps', () => {
  const running = runTrail();
  const first = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [acted(running, 'typed email', '1.png')] },
    running,
  );
  expect(first).toEqual({
    status: 'running',
    steps: [{ step: 'typed email', ok: true, screenshot: '1.png' }],
    bugs: [],
    visual: [],
  });
  const second = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [acted(running, 'clicked Submit', '2.png')] },
    running,
  );
  expect(second?.steps).toHaveLength(2);
  expect(running.steps).toHaveLength(2);
});

test('progressForStep streams look issues + console errors — an act-less step still flushes', () => {
  const running = runTrail();
  const out = progressForStep(
    {
      toolCalls: [{ toolName: 'observe' }, { toolName: 'look' }],
      toolResults: [
        consoleResult({ level: 'error', text: 'boom', location: 'app.js:1:1' }),
        lookResult('006.png', { what: 'button overlaps', where: 'header', severity: 'medium' }),
      ],
    },
    running,
  );
  expect(out).toEqual({
    status: 'running',
    steps: [],
    bugs: [{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }],
    visual: [
      { issue: 'button overlaps', where: 'header', severity: 'medium', screenshot: '006.png' },
    ],
  });
  expect(running.bugs).toHaveLength(1);
  expect(running.visual).toHaveLength(1);
});

test('progressForStep dedupes re-read console rows and re-flagged visual issues by message', () => {
  const running = runTrail();
  const step = () => ({
    toolCalls: [{ toolName: 'observe' }, { toolName: 'look' }],
    toolResults: [
      consoleResult({ level: 'error', text: 'boom' }, { level: 'error', text: 'boom' }),
      lookResult('007.png', { what: 'Button  Overlaps', where: 'Header', severity: 'medium' }),
    ],
  });
  const first = progressForStep(step(), running);
  expect(first?.bugs).toHaveLength(1);
  expect(first?.visual).toHaveLength(1);
  // The console channel is a ring buffer, and looks repeat on the same screen:
  // a second identical read adds nothing new, so there is nothing to flush.
  expect(progressForStep(step(), running)).toBeNull();
  expect(running.bugs).toHaveLength(1);
  expect(running.visual).toHaveLength(1);
});

test('progressForStep keeps streamed findings when a later step only acts', () => {
  const running = runTrail();
  progressForStep(
    {
      toolCalls: [{ toolName: 'look' }],
      toolResults: [lookResult('008.png', { what: 'clipped', where: 'nav', severity: 'low' })],
    },
    running,
  );
  const next = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [acted(running, 'clicked Pay', '9.png')] },
    running,
  );
  expect(next?.visual).toHaveLength(1);
  expect(next?.steps).toEqual([{ step: 'clicked Pay', ok: true, screenshot: '9.png' }]);
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

test('describeStep surfaces a tool-error content part (AI SDK 6 shape), not toolResults', () => {
  const line = describeStep(
    {
      toolCalls: [{ toolName: 'act', input: { act: 'click #save' } }],
      toolResults: [], // AI SDK 6 never puts a failed call's error here
      content: [
        { type: 'tool-call', toolName: 'act' },
        toolErrorPart('act', new Error('element not found')),
      ],
    },
    3,
  );
  expect(line).toBe('step 3: act({"act":"click #save"}) — ERROR act: element not found');
});

test('progressForStep flushes a FAILED act too — a rejected tool call never reaches toolResults', () => {
  const running = runTrail();
  // What `runAct` does on a throw (see `belt/act.ts`): the trail gets the
  // `ok: false` entry AT ACT TIME, before the step content — carrying only a
  // `tool-error` part — ever reaches `onStepFinish`.
  running.steps.push({ step: 'click #save', ok: false, note: 'AgentError: no element matched' });
  const out = progressForStep(
    {
      toolCalls: [{ toolName: 'act', input: { action: 'click', target: '#save' } }],
      toolResults: [], // the failed call's result is not here — only in `content`
      content: [toolErrorPart('act', new Error('no element matched'))],
    },
    running,
  );
  // Gating on toolResults (the pre-fix check) would see no `act` result and no
  // new bugs/visual, and return null — silently losing the one step a crashed
  // run most needs: the failure itself. Gating on toolCalls catches it.
  expect(out).toEqual({
    status: 'running',
    steps: [{ step: 'click #save', ok: false, note: 'AgentError: no element matched' }],
    bugs: [],
    visual: [],
  });
});

test('describeStep stays clean when the step has no content (or no errors in it)', () => {
  expect(describeStep({ toolCalls: [{ toolName: 'observe' }], toolResults: [] }, 1)).toBe(
    'step 1: observe',
  );
  expect(
    describeStep(
      {
        toolCalls: [{ toolName: 'observe' }],
        toolResults: [{ toolName: 'observe', output: { kind: 'console', entries: [] } }],
        content: [{ type: 'tool-result', toolName: 'observe' }],
      },
      2,
    ),
  ).toBe('step 2: observe');
});
