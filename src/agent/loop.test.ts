import { expect, test } from 'bun:test';
import { type ModelMessage, tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { createActTrail, type TrailEvidence } from './belt/trail.js';
import {
  type BeltTools,
  BUDGET_WARN,
  budgetNudge,
  createDebugAgent,
  DEFAULT_MAX_STEPS,
  describeStep,
  foldInstructionsIntoStep,
  KICKOFF_PROMPT,
  type LoopInbox,
  progressForStep,
  pruneStaleFrames,
  STALE_FRAME_NOTE,
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

/**
 * What the `act` tool does to the shared trail before the step finishes: record
 * the step AT ACT TIME (see `belt/act.ts`), then hand back the matching tool
 * result.
 */
const acted = (
  evidence: ReturnType<typeof createActTrail>,
  label: string,
  screenshot: string,
  ok = true,
) => {
  evidence.record({ step: label, ok, screenshot });
  return {
    toolName: 'act',
    output: { action: 'click', label, ok, screenshot },
  };
};

/**
 * What the `look` tool does to the shared trail: record each flagged issue with
 * its frame (see `belt/look.ts`).
 */
const looked = (
  evidence: ReturnType<typeof createActTrail>,
  screenshot: string,
  ...issues: Array<{ what: string; where: string; severity: 'low' | 'medium' | 'high' }>
) => {
  for (const issue of issues) {
    evidence.recordVisual({
      issue: issue.what,
      where: issue.where,
      severity: issue.severity,
      screenshot,
    });
  }
  return { toolName: 'look', output: { description: 'seen', issues, screenshot } };
};

/** What the `observe` tool does with a console read: record each error row (see `belt/observe.ts`). */
const consoleRead = (
  evidence: ReturnType<typeof createActTrail>,
  ...entries: Array<{ level: string; text: string; location?: string }>
) => {
  for (const entry of entries) {
    if (entry.level !== 'error') continue;
    evidence.recordBug({
      kind: 'console',
      detail: entry.text,
      ...(entry.location !== undefined && { evidence: entry.location }),
    });
  }
  return {
    toolName: 'observe',
    output: { kind: 'console', count: entries.length, entries },
  };
};

/** Fresh flushed bookkeeping — what the loop starts a run with. */
const noneFlushed = (): TrailEvidence => ({ steps: [], bugs: [], visual: [] });

/**
 * A `tool-error` content part — AI SDK 6's shape for a rejected tool call (never
 * `toolResults`; see `describeStep`).
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

// --- progressForStep: flush on trail growth ----------------------------------

test('progressForStep flushes when the step trail grew past flushed', () => {
  const trail = createActTrail();
  const out = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [acted(trail, 'typed email', '1.png')] },
    trail,
    noneFlushed(),
  );
  expect(out).toEqual({
    status: 'running',
    steps: [{ step: 'typed email', ok: true, screenshot: '1.png' }],
    bugs: [],
    visual: [],
  });
});

test('progressForStep flushes when only bugs grew — a look/observe step has no acts', () => {
  const trail = createActTrail();
  const out = progressForStep(
    {
      toolCalls: [{ toolName: 'observe' }, { toolName: 'look' }],
      toolResults: [
        consoleRead(trail, { level: 'error', text: 'boom', location: 'app.js:1:1' }),
        looked(trail, '006.png', { what: 'button overlaps', where: 'header', severity: 'medium' }),
      ],
    },
    trail,
    noneFlushed(),
  );
  expect(out).toEqual({
    status: 'running',
    steps: [],
    bugs: [{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }],
    visual: [
      { issue: 'button overlaps', where: 'header', severity: 'medium', screenshot: '006.png' },
    ],
  });
  expect(trail.bugs).toHaveLength(1);
  expect(trail.visual).toHaveLength(1);
});

test('progressForStep returns null when nothing grew past flushed', () => {
  const trail = createActTrail();
  const out = progressForStep(
    { toolCalls: [{ toolName: 'observe' }], toolResults: [{ toolName: 'observe', output: {} }] },
    trail,
    noneFlushed(),
  );
  expect(out).toBeNull();
});

test('progressForStep returns null once the already-flushed evidence is passed back', () => {
  // The trail dedupes, so a re-read of the same console rows records nothing new —
  // passing the previous flush back as `flushed` must yield no second write.
  const trail = createActTrail();
  const step = {
    toolCalls: [{ toolName: 'observe' }],
    toolResults: [
      consoleRead(trail, { level: 'error', text: 'boom' }, { level: 'error', text: 'boom' }),
    ],
  };
  const first = progressForStep(step, trail, noneFlushed());
  expect(first?.bugs).toHaveLength(1);
  expect(progressForStep(step, trail, first ?? noneFlushed())).toBeNull();
  expect(trail.bugs).toHaveLength(1);
});

test('progressForStep steps aside for the terminal report step (verdict owned by report)', () => {
  const trail = createActTrail();
  const out = progressForStep(
    {
      toolCalls: [{ toolName: 'report' }, { toolName: 'act' }],
      toolResults: [acted(trail, 'click x', '1.png'), { toolName: 'report', output: {} }],
    },
    trail,
    noneFlushed(),
  );
  // No running write to clobber the verdict — but the act itself is NOT lost: `act`
  // recorded it on the shared trail, and `report` merged that trail into `steps`.
  expect(out).toBeNull();
  expect(trail.steps).toEqual([{ step: 'click x', ok: true, screenshot: '1.png' }]);
});

test('progressForStep still flushes a step whose report call was INVALID — acts on it are not lost', () => {
  const trail = createActTrail();
  // What `runAct` does on a throw (see `belt/act.ts`): the trail gets the
  // `ok: false` entry AT ACT TIME, before the step content — carrying only a
  // `tool-error` part — ever reaches `onStepFinish`.
  trail.record({ step: 'click #save', ok: false, note: 'AgentError: no element matched' });
  const out = progressForStep(
    {
      // A `report` whose arguments fail the Zod schema is never executed (no
      // report RESULT in toolResults) but still listed in `toolCalls` — gating
      // the flush on the CALL threw away exactly this step.
      toolCalls: [
        { toolName: 'act', input: { action: 'click', target: '#save' } },
        { toolName: 'report', input: { status: 'pass' } },
      ],
      toolResults: [], // neither the failed act nor the invalid call has a result here
      content: [
        toolErrorPart('act', new Error('no element matched')),
        toolErrorPart('report', new Error('invalid input')),
      ],
    },
    trail,
    noneFlushed(),
  );
  expect(out).toEqual({
    status: 'running',
    steps: [{ step: 'click #save', ok: false, note: 'AgentError: no element matched' }],
    bugs: [],
    visual: [],
  });
});

test('progressForStep flushes a FAILED act too — a rejected tool call never reaches toolResults', () => {
  const trail = createActTrail();
  trail.record({ step: 'click #save', ok: false, note: 'AgentError: no element matched' });
  const out = progressForStep(
    {
      toolCalls: [{ toolName: 'act', input: { action: 'click', target: '#save' } }],
      toolResults: [], // the failed call's result is not here — only in `content`
      content: [toolErrorPart('act', new Error('no element matched'))],
    },
    trail,
    noneFlushed(),
  );
  // Growth is read off the trail, not toolResults: the failure is recorded at act
  // time, so the step a crashed run most needs is still flushed.
  expect(out?.steps).toEqual([
    { step: 'click #save', ok: false, note: 'AgentError: no element matched' },
  ]);
});

test('progressForStep snapshots COPY the trail arrays — later records cannot rewrite a flush', () => {
  const trail = createActTrail();
  const out = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [acted(trail, 'click a', '1.png')] },
    trail,
    noneFlushed(),
  );
  acted(trail, 'click b', '2.png');
  expect(out?.steps).toEqual([{ step: 'click a', ok: true, screenshot: '1.png' }]);
});

test('flushed semantics across consecutive steps: each flush includes everything so far', () => {
  const trail = createActTrail();
  const first = progressForStep(
    {
      toolCalls: [{ toolName: 'observe' }, { toolName: 'look' }],
      toolResults: [
        consoleRead(trail, { level: 'error', text: 'boom', location: 'app.js:1:1' }),
        looked(trail, '008.png', { what: 'clipped', where: 'nav', severity: 'low' }),
      ],
    },
    trail,
    noneFlushed(),
  );
  expect(first?.bugs).toHaveLength(1);
  expect(first?.visual).toHaveLength(1);
  const flushed: TrailEvidence = {
    steps: first?.steps ?? [],
    bugs: first?.bugs ?? [],
    visual: first?.visual ?? [],
  };
  // Next step only acts — its flush still carries the earlier streamed evidence.
  const second = progressForStep(
    { toolCalls: [{ toolName: 'act' }], toolResults: [acted(trail, 'clicked Pay', '9.png')] },
    trail,
    flushed,
  );
  expect(second?.steps).toEqual([{ step: 'clicked Pay', ok: true, screenshot: '9.png' }]);
  expect(second?.visual).toEqual([
    { issue: 'clipped', where: 'nav', severity: 'low', screenshot: '008.png' },
  ]);
  expect(second?.bugs).toEqual([{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }]);
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
