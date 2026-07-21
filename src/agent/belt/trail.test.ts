import { expect, test } from 'bun:test';
import { createActTrail } from './trail.js';

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
  expect(await trail.settled()).toEqual([]);
});

test('settled() waits for an act that is already in flight', async () => {
  const trail = createActTrail();
  const acting = slowAct(trail, 'click Pay', 5);
  const steps = await trail.settled();
  expect(steps.map((s) => s.step)).toEqual(['click Pay']);
  await acting;
});

test('settled() waits for an act that only registers AFTER the read starts', async () => {
  const trail = createActTrail();
  // The SDK launches a step's tool calls in microtasks, so an act listed after
  // `report` enters the gate later in the same turn. The read must still catch it.
  const read = trail.settled();
  const acting = slowAct(trail, 'click Pay', 5);
  expect((await read).map((s) => s.step)).toEqual(['click Pay']);
  await acting;
});

test('settled() waits for EVERY concurrent act, not just the first to finish', async () => {
  const trail = createActTrail();
  const acting = Promise.all([slowAct(trail, 'fast', 1), slowAct(trail, 'slow', 15)]);
  const steps = await trail.settled();
  expect(steps.map((s) => s.step).sort()).toEqual(['fast', 'slow']);
  await acting;
});

test('the gate reopens: a later act is awaited by a later read', async () => {
  const trail = createActTrail();
  await slowAct(trail, 'first', 1);
  expect(await trail.settled()).toHaveLength(1);
  const acting = slowAct(trail, 'second', 5);
  expect(await trail.settled()).toHaveLength(2);
  await acting;
});

test('settling an act twice cannot release a read early', async () => {
  const trail = createActTrail();
  const settleFirst = trail.begin();
  const acting = slowAct(trail, 'still running', 10);
  settleFirst();
  settleFirst();
  expect((await trail.settled()).map((s) => s.step)).toEqual(['still running']);
  await acting;
});
