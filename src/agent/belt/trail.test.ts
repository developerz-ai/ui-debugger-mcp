import { expect, test } from 'bun:test';
import { type ActTrail, createActTrail, evidenceKey } from './trail.js';

/** An act that takes `ms` of real work between announcing itself and recording. */
async function slowAct(
  trail: ReturnType<typeof createActTrail>,
  label: string,
  ms: number,
): Promise<void> {
  const settle = trail.begin();
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
    trail.record({ step: label, ok: true, screenshot: `${label}.png` });
  } finally {
    settle();
  }
}

/**
 * A look/observe-shaped recorder: announces itself through the same gate, takes
 * `ms` of real work, then records a visual issue before releasing. This is what
 * `createLookTool`/`createObserveTool` do when a trail is wired.
 */
async function slowLook(trail: ActTrail, issue: string, ms: number): Promise<void> {
  const settle = trail.begin();
  try {
    await new Promise((resolve) => setTimeout(resolve, ms));
    trail.recordVisual({ issue, where: 'header', severity: 'low', screenshot: '001.png' });
  } finally {
    settle();
  }
}

test('records steps in act order, ok or not', () => {
  const trail = createActTrail();
  trail.record({ step: 'click Pay', ok: true, screenshot: '001.png' });
  trail.record({ step: 'click Save', ok: false, note: 'AdapterError: node detached' });
  expect(trail.steps).toEqual([
    { step: 'click Pay', ok: true, screenshot: '001.png' },
    { step: 'click Save', ok: false, note: 'AdapterError: node detached' },
  ]);
});

test('settled() resolves straight away when no act is in flight', async () => {
  const trail = createActTrail();
  expect(await trail.settled()).toEqual({ steps: [], bugs: [], visual: [] });
});

test('settled() waits for an act that is already in flight', async () => {
  const trail = createActTrail();
  const acting = slowAct(trail, 'click Pay', 5);
  const evidence = await trail.settled();
  expect(evidence.steps.map((s) => s.step)).toEqual(['click Pay']);
  await acting;
});

test('settled() waits for an act that only registers AFTER the read starts', async () => {
  const trail = createActTrail();
  // The SDK launches a step's tool calls in microtasks, so an act listed after
  // `report` enters the gate later in the same turn. The read must still catch it.
  const read = trail.settled();
  const acting = slowAct(trail, 'click Pay', 5);
  expect((await read).steps.map((s) => s.step)).toEqual(['click Pay']);
  await acting;
});

test('settled() waits for EVERY concurrent act, not just the first to finish', async () => {
  const trail = createActTrail();
  const acting = Promise.all([slowAct(trail, 'fast', 1), slowAct(trail, 'slow', 15)]);
  const evidence = await trail.settled();
  expect(evidence.steps.map((s) => s.step).sort()).toEqual(['fast', 'slow']);
  await acting;
});

test('the gate reopens: a later act is awaited by a later read', async () => {
  const trail = createActTrail();
  await slowAct(trail, 'first', 1);
  expect((await trail.settled()).steps).toHaveLength(1);
  const acting = slowAct(trail, 'second', 5);
  expect((await trail.settled()).steps).toHaveLength(2);
  await acting;
});

test('settling an act twice cannot release a read early', async () => {
  const trail = createActTrail();
  const settleFirst = trail.begin();
  const acting = slowAct(trail, 'still running', 10);
  settleFirst();
  settleFirst();
  expect((await trail.settled()).steps.map((s) => s.step)).toEqual(['still running']);
  await acting;
});

// --- the evidence streams: recordBug / recordVisual --------------------------

test('recordBug appends in call order', () => {
  const trail = createActTrail();
  trail.recordBug({ kind: 'console', detail: 'TypeError: x is undefined' });
  trail.recordBug({
    kind: 'console',
    detail: 'failed to fetch',
    evidence: 'app.js:12:3',
  });
  expect(trail.bugs).toEqual([
    { kind: 'console', detail: 'TypeError: x is undefined' },
    { kind: 'console', detail: 'failed to fetch', evidence: 'app.js:12:3' },
  ]);
});

test('recordBug dedupes by normalized detail — a re-read of the ring adds nothing', () => {
  const trail = createActTrail();
  trail.recordBug({ kind: 'console', detail: 'TypeError: x is undefined', evidence: 'a.js:1:1' });
  // Same message, different location AND different case/spacing: still the same bug.
  trail.recordBug({
    kind: 'console',
    detail: '  typeerror:   X IS undefined ',
    evidence: 'b.js:9:9',
  });
  expect(trail.bugs).toHaveLength(1);
  expect(trail.bugs[0]?.evidence).toBe('a.js:1:1'); // first record wins
});

test('recordVisual appends in call order and dedupes issue+where case/whitespace-insensitively', () => {
  const trail = createActTrail();
  trail.recordVisual({
    issue: 'Button Overlaps',
    where: 'Header',
    severity: 'high',
    screenshot: '1.png',
  });
  trail.recordVisual({
    issue: 'button   overlaps',
    where: 'header',
    severity: 'low',
    screenshot: '2.png',
  });
  expect(trail.visual).toHaveLength(1);
  expect(trail.visual[0]?.severity).toBe('high'); // first record wins
});

test('different keys coexist — dedupe never collapses distinct findings', () => {
  const trail = createActTrail();
  trail.recordBug({ kind: 'console', detail: 'first error' });
  trail.recordBug({ kind: 'console', detail: 'second error' });
  trail.recordVisual({ issue: 'clipped', where: 'nav', severity: 'low', screenshot: '1.png' });
  trail.recordVisual({ issue: 'clipped', where: 'footer', severity: 'low', screenshot: '2.png' });
  trail.recordVisual({
    issue: 'misaligned',
    where: 'nav',
    severity: 'medium',
    screenshot: '3.png',
  });
  expect(trail.bugs).toHaveLength(2);
  expect(trail.visual).toHaveLength(3);
});

test('settled() returns all three streams, steps AND everything look/observe recorded', async () => {
  const trail = createActTrail();
  trail.record({ step: 'click Pay', ok: true, screenshot: '001.png' });
  trail.recordBug({ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' });
  trail.recordVisual({
    issue: 'overlap',
    where: 'header',
    severity: 'high',
    screenshot: '002.png',
  });
  const evidence = await trail.settled();
  expect(evidence.steps).toEqual([{ step: 'click Pay', ok: true, screenshot: '001.png' }]);
  expect(evidence.bugs).toEqual([{ kind: 'console', detail: 'boom', evidence: 'app.js:1:1' }]);
  expect(evidence.visual).toEqual([
    { issue: 'overlap', where: 'header', severity: 'high', screenshot: '002.png' },
  ]);
});

test('settled() waits for a look-shaped recorder in flight behind the same gate', async () => {
  const trail = createActTrail();
  const looking = slowLook(trail, 'button overlaps', 5);
  const evidence = await trail.settled();
  await looking;
  expect(evidence.visual.map((v) => v.issue)).toEqual(['button overlaps']);
});

test('settled() catches a recorder that only registers AFTER the read starts', async () => {
  const trail = createActTrail();
  const read = trail.settled();
  const looking = slowLook(trail, 'clipped text', 5);
  expect((await read).visual.map((v) => v.issue)).toEqual(['clipped text']);
  await looking;
});

// --- evidenceKey: the shared normalization -----------------------------------

test('evidenceKey trims, lowercases and collapses whitespace — the shared pairing key', () => {
  expect(evidenceKey('  TypeError:   X is UNDEFINED ')).toBe('typeerror: x is undefined');
  // Multi-part keys (issue + where) join with the same separator everywhere.
  expect(evidenceKey('Button Overlaps', '  Header')).toBe(evidenceKey('button overlaps', 'header'));
  expect(evidenceKey('a', 'b')).not.toBe(evidenceKey('a b'));
  expect(evidenceKey('a', 'b')).not.toBe(evidenceKey('b', 'a'));
});
