import { expect, test } from 'bun:test';
import { FindingsError } from '../../errors.js';
import type { Bug, Findings, Step, VisualIssue } from '../../findings/schema.js';
import {
  createReportTool,
  EMPTY_EVIDENCE,
  type FindingsWriter,
  mergeSteps,
  ReportInputSchema,
  type ReportResult,
  runReport,
} from './report.js';
import type { TrailEvidence } from './trail.js';

/** A fake {@link FindingsWriter} that records what it was asked to persist. */
function fakeWriter(path = 'sessions/x/findings.json'): {
  writer: FindingsWriter;
  written: Findings[];
} {
  const written: Findings[] = [];
  const writer: FindingsWriter = {
    writeFindings: async (findings) => {
      written.push(findings);
      return path;
    },
  };
  return { writer, written };
}

const FULL: ReportResult['status'] = 'failed';

/** Wrap recorded steps as the evidence shape `runReport` now takes. */
const evidenceOf = (
  steps: readonly Step[],
  bugs: readonly Bug[] = [],
  visual: readonly VisualIssue[] = [],
): TrailEvidence => ({
  steps,
  bugs,
  visual,
});

test('writes the verdict through the store and returns its path', async () => {
  const { writer, written } = fakeWriter('sessions/abc/findings.json');
  const res = await runReport(writer, {
    status: 'passed',
    steps: [{ step: 'Clicked Checkout', ok: true }],
    bugs: [],
    visual: [],
    dismissStreamed: false,
    summary: 'All good.',
  });
  expect(written).toHaveLength(1);
  expect(written[0]).toEqual({
    status: 'passed',
    steps: [{ step: 'Clicked Checkout', ok: true }],
    bugs: [],
    visual: [],
    summary: 'All good.',
  });
  expect(res.findings).toBe('sessions/abc/findings.json');
});

test('signals loop stop (stop:true) and echoes the terminal status', async () => {
  const { writer } = fakeWriter();
  const res = await runReport(writer, {
    status: FULL,
    steps: [],
    bugs: [],
    visual: [],
    dismissStreamed: false,
  });
  expect(res.stop).toBe(true);
  expect(res.status).toBe('failed');
});

test('reports counts so the verdict reads without re-opening the file', async () => {
  const { writer } = fakeWriter();
  const res = await runReport(writer, {
    status: 'failed',
    steps: [
      { step: 'a', ok: true },
      { step: 'b', ok: false },
    ],
    bugs: [{ kind: 'console', detail: 'TypeError' }],
    visual: [
      { issue: 'overlap', where: 'header', severity: 'high' },
      { issue: 'spacing', where: 'footer', severity: 'low' },
    ],
    dismissStreamed: false,
  });
  expect(res.counts).toEqual({ steps: 2, bugs: 1, visual: 2 });
});

test('takes the recorded act-trail when the driver reported no steps; counts match the file', async () => {
  const { writer, written } = fakeWriter();
  const trail = evidenceOf([
    { step: 'key Tab', ok: true, screenshot: '001.png' },
    { step: 'scroll down', ok: true, screenshot: '002.png' },
  ]);
  const res = await runReport(
    writer,
    { status: 'passed', steps: [], bugs: [], visual: [], dismissStreamed: false },
    trail,
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.steps).toEqual([...trail.steps]);
  // The returned counts derive from the SAME findings object — no 0-vs-N drift.
  expect(res.counts.steps).toBe(persisted.steps.length);
  expect(res.counts.steps).toBe(2);
});

test('merges reported steps with the trail — the driver’s ok:false + note survive', async () => {
  const { writer, written } = fakeWriter();
  const trail = evidenceOf([
    { step: 'click button "Checkout"', ok: true, screenshot: '001.png' },
    { step: 'wait for "network idle"', ok: true, screenshot: '002.png' },
  ]);
  const reported = [
    { step: 'Verified cart total', ok: true, note: 'shows $42' },
    { step: 'Checkout button did nothing', ok: false, note: 'stayed on /cart' },
  ];
  const res = await runReport(
    writer,
    { status: 'failed', steps: reported, bugs: [], visual: [], dismissStreamed: false },
    trail,
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  // Nothing discarded: both trail entries and both reported steps survive, each in order.
  expect(persisted.steps).toEqual([...trail.steps, ...reported]);
  expect(res.counts.steps).toBe(4);
});

test('fuses a restated step: driver fields win, the trail attaches the frame', async () => {
  const { writer, written } = fakeWriter();
  const res = await runReport(
    writer,
    {
      status: 'failed',
      // Driver echoed the act label (models commonly do) and judged it a failure.
      steps: [{ step: 'Click button "Save"', ok: false, note: 'no toast appeared' }],
      bugs: [],
      visual: [],
      dismissStreamed: false,
    },
    evidenceOf([{ step: 'click button "Save"', ok: true, screenshot: '003.png' }]),
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.steps).toEqual([
    { step: 'Click button "Save"', ok: false, note: 'no toast appeared', screenshot: '003.png' },
  ]);
  expect(res.counts.steps).toBe(1);
});

test('pairs repeated labels one-to-one instead of collapsing them', () => {
  const trail = evidenceOf([
    { step: 'click Add to cart', ok: true, screenshot: '001.png' },
    { step: 'click Add to cart', ok: true, screenshot: '002.png' },
  ]);
  const reported = [
    { step: 'click Add to cart', ok: true },
    { step: 'click Add to cart', ok: false, note: 'second one dead' },
  ];
  expect(mergeSteps(reported, trail.steps)).toEqual([
    { step: 'click Add to cart', ok: true, screenshot: '001.png' },
    { step: 'click Add to cart', ok: false, note: 'second one dead', screenshot: '002.png' },
  ]);
});

test('merge keeps a failed trail entry the driver never mentioned', () => {
  const merged = mergeSteps(
    [{ step: 'Opened /login', ok: true }],
    [{ step: 'click #save', ok: false, note: 'AgentError: no element matched "#save"' }],
  );
  expect(merged).toEqual([
    { step: 'click #save', ok: false, note: 'AgentError: no element matched "#save"' },
    { step: 'Opened /login', ok: true },
  ]);
});

test('merge is a no-op on either side being empty', () => {
  const steps = [{ step: 'a', ok: true }];
  expect(mergeSteps(steps, [])).toEqual(steps);
  expect(mergeSteps([], steps)).toEqual(steps);
  expect(mergeSteps([], [])).toEqual([]);
});

test('keeps the reported steps when no act-trail was recorded', async () => {
  const { writer, written } = fakeWriter();
  const reported = [{ step: 'manual note', ok: false }];
  const res = await runReport(
    writer,
    { status: 'failed', steps: reported, bugs: [], visual: [], dismissStreamed: false },
    EMPTY_EVIDENCE,
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.steps).toEqual(reported);
  expect(res.counts.steps).toBe(persisted.steps.length);
});

// --- the streamed-evidence merge (the terminal write never replaces) ---------

test('a report omitting bugs/visual CARRIES the streamed console errors and look issues', async () => {
  const { writer, written } = fakeWriter();
  const streamed = evidenceOf(
    [{ step: 'click Pay', ok: true, screenshot: '001.png' }],
    [{ kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' }],
    [
      {
        issue: 'total overlaps the button',
        where: 'cart footer',
        severity: 'high',
        screenshot: '002.png',
      },
    ],
  );
  const res = await runReport(
    writer,
    // The driver's verdict lists nothing but the status — the pre-merge write
    // would have persisted exactly that, erasing every surfaced finding.
    { status: 'failed', steps: [], bugs: [], visual: [], dismissStreamed: false },
    streamed,
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.bugs).toEqual([
    { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
  ]);
  expect(persisted.visual).toEqual([
    {
      issue: 'total overlaps the button',
      where: 'cart footer',
      severity: 'high',
      screenshot: '002.png',
    },
  ]);
  // Counts derive from the written file, and carried reports what was included.
  expect(res.counts).toEqual({ steps: 1, bugs: 1, visual: 1 });
  expect(res.counts.bugs).toBe(persisted.bugs.length);
  expect(res.counts.visual).toBe(persisted.visual.length);
  expect(res.carried).toEqual({ bugs: 1, visual: 1 });
});

test('dismissStreamed:true drops unrestated streamed entries — carried is zeroed', async () => {
  const { writer, written } = fakeWriter();
  const res = await runReport(
    writer,
    {
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      dismissStreamed: true,
    },
    evidenceOf(
      [],
      [{ kind: 'console', detail: 'transient 401 on /api/auth/me' }],
      [{ issue: 'phantom misalignment', where: 'footer', severity: 'low', screenshot: '9.png' }],
    ),
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  // Nothing unrestated survives a deliberate dismissal.
  expect(persisted.bugs).toEqual([]);
  expect(persisted.visual).toEqual([]);
  expect(res.counts).toEqual({ steps: 0, bugs: 0, visual: 0 });
  expect(res.carried).toEqual({ bugs: 0, visual: 0 });
});

test('dismissStreamed:true still fuses RESTATED streamed entries (only unrestated are dropped)', async () => {
  const { writer, written } = fakeWriter();
  const res = await runReport(
    writer,
    {
      status: 'failed',
      steps: [],
      // The driver restates the real bug (its own wording), dismisses the rest.
      bugs: [{ kind: 'console', detail: 'TypeError: cart is undefined' }],
      visual: [],
      dismissStreamed: true,
    },
    evidenceOf(
      [],
      [
        { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
        { kind: 'console', detail: 'noise the driver ruled out' },
      ],
    ),
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.bugs).toEqual([
    { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
  ]);
  expect(res.carried).toEqual({ bugs: 0, visual: 0 });
});

test('fusion: a restated bug appears ONCE — driver fields win, streamed fills the evidence', async () => {
  const { writer, written } = fakeWriter();
  const res = await runReport(
    writer,
    {
      status: 'failed',
      steps: [],
      bugs: [{ kind: 'network', detail: 'TypeError:   cart IS undefined', evidence: 'replay.log' }],
      visual: [],
      dismissStreamed: false,
    },
    evidenceOf(
      [],
      [{ kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' }],
    ),
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.bugs).toEqual([
    // Matched case/whitespace-insensitively; the driver's kind + evidence win.
    { kind: 'network', detail: 'TypeError:   cart IS undefined', evidence: 'replay.log' },
  ]);
  expect(res.carried).toEqual({ bugs: 0, visual: 0 });
});

test('fusion: a restated visual issue appears ONCE — streamed fills the missing screenshot', async () => {
  const { writer, written } = fakeWriter();
  const res = await runReport(
    writer,
    {
      status: 'failed',
      steps: [],
      bugs: [],
      // The driver restates the issue but has no screenshot path at hand.
      visual: [{ issue: 'total overlaps button', where: 'cart footer', severity: 'high' }],
      dismissStreamed: false,
    },
    evidenceOf(
      [],
      [],
      [
        {
          issue: 'Total  overlaps  button',
          where: 'Cart Footer',
          severity: 'medium',
          screenshot: '002-cart.png',
        },
      ],
    ),
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.visual).toEqual([
    {
      issue: 'total overlaps button',
      where: 'cart footer',
      severity: 'high',
      screenshot: '002-cart.png',
    },
  ]);
  expect(res.carried).toEqual({ visual: 0, bugs: 0 });
});

test('driver entries that restate nothing follow the streamed spine in reported order', async () => {
  const { writer, written } = fakeWriter();
  const res = await runReport(
    writer,
    {
      status: 'failed',
      steps: [],
      bugs: [{ kind: 'flow', detail: 'checkout dead-ends', evidence: '001.png' }],
      visual: [],
      dismissStreamed: false,
    },
    evidenceOf([], [{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }]),
  );
  const persisted = written[0];
  if (!persisted) throw new Error('expected a written findings');
  expect(persisted.bugs).toEqual([
    { kind: 'console', detail: 'boom', evidence: 'app.js:1:1' },
    { kind: 'flow', detail: 'checkout dead-ends', evidence: '001.png' },
  ]);
  expect(res.carried).toEqual({ bugs: 1, visual: 0 });
});

test('omits summary from the written findings when not given', async () => {
  const { writer, written } = fakeWriter();
  await runReport(writer, {
    status: 'passed',
    steps: [],
    bugs: [],
    visual: [],
    dismissStreamed: false,
  });
  expect(written[0]).toEqual({ status: 'passed', steps: [], bugs: [], visual: [] });
  expect(written[0] && 'summary' in written[0]).toBe(false);
});

test('a store write error propagates (fail loud, no silent fallback)', async () => {
  const writer: FindingsWriter = {
    writeFindings: async () => {
      throw new FindingsError('disk full');
    },
  };
  await expect(
    runReport(writer, {
      status: 'passed',
      steps: [],
      bugs: [],
      visual: [],
      dismissStreamed: false,
    }),
  ).rejects.toThrow(FindingsError);
});

test('schema defaults steps/bugs/visual to [] and dismissStreamed to false', () => {
  const parsed = ReportInputSchema.parse({ status: 'passed' });
  expect(parsed).toEqual({
    status: 'passed',
    steps: [],
    bugs: [],
    visual: [],
    dismissStreamed: false,
  });
});

test('schema rejects the non-terminal "running" status', () => {
  expect(ReportInputSchema.safeParse({ status: 'running' }).success).toBe(false);
});

test('schema rejects an unknown status', () => {
  expect(ReportInputSchema.safeParse({ status: 'flaky' }).success).toBe(false);
});

test('schema rejects a malformed bug (bad kind)', () => {
  const bad = ReportInputSchema.safeParse({
    status: 'failed',
    bugs: [{ kind: 'timeout', detail: 'x' }],
  });
  expect(bad.success).toBe(false);
});

test('schema rejects a malformed visual issue (bad severity)', () => {
  const bad = ReportInputSchema.safeParse({
    status: 'failed',
    visual: [{ issue: 'x', where: 'y', severity: 'critical' }],
  });
  expect(bad.success).toBe(false);
});

test('schema accepts a full, well-formed verdict', () => {
  const ok = ReportInputSchema.safeParse({
    status: 'failed',
    steps: [{ step: 'Opened page', ok: true, note: 'fast', screenshot: 's.png' }],
    bugs: [{ kind: 'network', detail: '500 on /api', evidence: 'network.log' }],
    visual: [{ issue: 'cut off', where: 'card', severity: 'medium', screenshot: 'v.png' }],
    dismissStreamed: true,
    summary: 'Checkout 500s; card text clips.',
  });
  expect(ok.success).toBe(true);
});

test('createReportTool exposes a described tool with an input schema', () => {
  const { writer } = fakeWriter();
  const report = createReportTool(writer);
  expect(typeof report.description).toBe('string');
  expect(report.inputSchema).toBeDefined();
});

test('createReportTool awaits an async trail read before it writes the verdict', async () => {
  const { writer, written } = fakeWriter();
  // The wired read is the act trail's `settled()`: it resolves only once the acts
  // racing `report` in the same step have recorded (see `belt/trail.ts`).
  const late = new Promise<TrailEvidence>((resolve) => {
    setTimeout(
      () =>
        resolve(
          evidenceOf(
            [{ step: 'click Pay', ok: true, screenshot: '001.png' }],
            [{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }],
          ),
        ),
      5,
    );
  });
  const report = createReportTool(writer, () => late);
  const execute = report.execute;
  if (!execute) throw new Error('expected an executable report tool');
  const result = (await execute(
    { status: 'passed', steps: [], bugs: [], visual: [], dismissStreamed: false },
    {
      toolCallId: 't1',
      messages: [],
    },
  )) as ReportResult;
  expect(result.counts.steps).toBe(1);
  expect(written[0]?.steps).toEqual([{ step: 'click Pay', ok: true, screenshot: '001.png' }]);
  // The streamed bug rides along with the steps.
  expect(result.counts.bugs).toBe(1);
  expect(result.carried).toEqual({ bugs: 1, visual: 0 });
  expect(written[0]?.bugs).toEqual([{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }]);
});
