import { expect, test } from 'bun:test';
import type { ModelMessage } from 'ai';
import { pruneStaleFrames, STALE_FRAME_NOTE } from './loop.js';

// --- pruneStaleFrames --------------------------------------------------------

/** One self-look tool-result: a text part plus the frame itself (`file-data`). */
const lookResult = (id: string) => ({
  type: 'tool-result',
  toolCallId: id,
  toolName: 'look',
  output: {
    type: 'content',
    value: [
      { type: 'text', text: `screenshot saved: ${id}.png` },
      { type: 'file-data', data: `FRAME-${id}`, mediaType: 'image/png' },
    ],
  },
});

/** A tool message carrying one self-look frame per id. */
function lookFrameMessage(...ids: string[]): ModelMessage {
  return {
    role: 'tool',
    content: ids.map(lookResult),
  } as unknown as ModelMessage;
}

/** One output value of a look tool-result — the text part or the frame itself. */
type FrameValue = { type: string; text?: string; data?: string; mediaType?: string };

/** The content parts of a message (empty for string content). */
const partsOf = (message: ModelMessage) =>
  Array.isArray(message.content)
    ? (message.content as Array<{
        toolName?: string;
        output: { value: FrameValue[] };
      }>)
    : [];

/** The output values of one tool-result part (empty for a non-content output). */
const valuesOf = (part: unknown) => {
  const value = (part as { output?: { value?: unknown } }).output?.value;
  return Array.isArray(value) ? (value as FrameValue[]) : [];
};

/** The frames still live in a message (every `file-data` output value). */
const liveFrames = (message: ModelMessage) =>
  partsOf(message).flatMap((part) => valuesOf(part).filter((v) => v.type === 'file-data'));

test('pruneStaleFrames keeps only the newest look frame; older ones collapse to a note', () => {
  const user: ModelMessage = { role: 'user', content: 'go' };
  const messages = [user, lookFrameMessage('a'), lookFrameMessage('b')];
  const pruned = pruneStaleFrames(messages);

  // older frame stripped to the stale note
  expect(valuesOf(partsOf(pruned[1] as ModelMessage)[0]).map((v) => v.type)).toEqual([
    'text',
    'text',
  ]);
  expect(valuesOf(partsOf(pruned[1] as ModelMessage)[0])[1]?.text).toBe(STALE_FRAME_NOTE);
  // newest frame untouched
  expect(valuesOf(partsOf(pruned[2] as ModelMessage)[0]).map((v) => v.type)).toEqual([
    'text',
    'file-data',
  ]);
  // untouched messages pass through by reference
  expect(pruned[0]).toBe(user);
});

test('pruneStaleFrames collapses the older frame when ONE message holds two look results', () => {
  // AI SDK 6 collects ALL of a step's tool results into ONE `tool` message — two
  // looks in one step mean two frames inside a single message.
  const pruned = pruneStaleFrames([lookFrameMessage('a', 'b')]);

  const parts = partsOf(pruned[0] as ModelMessage);
  // the older result's image part collapses to the stale note
  expect(valuesOf(parts[0]).map((v) => v.type)).toEqual(['text', 'text']);
  expect(valuesOf(parts[0])[1]?.text).toBe(STALE_FRAME_NOTE);
  // the newer result keeps its frame
  expect(valuesOf(parts[1]).map((v) => v.type)).toEqual(['text', 'file-data']);
  expect(valuesOf(parts[1])[1]?.data).toBe('FRAME-b');
});

/** One look tool-result whose output value array holds TWO frames. */
const twoFrameLookResult = {
  type: 'tool-result',
  toolCallId: 'a',
  toolName: 'look',
  output: {
    type: 'content',
    value: [
      { type: 'text', text: 'screenshot saved: a.png' },
      { type: 'file-data', data: 'FRAME-a-old', mediaType: 'image/png' },
      { type: 'file-data', data: 'FRAME-a-new', mediaType: 'image/png' },
    ],
  },
};

test('pruneStaleFrames collapses the older frame when ONE look result holds two frames', () => {
  // Per-VALUE granularity: a single tool-result's output value array can carry
  // several `file-data` values — only the older one may collapse to the note,
  // the newer must stay live. A per-tool-result collapse would take both.
  const pruned = pruneStaleFrames([
    { role: 'tool', content: [twoFrameLookResult] } as unknown as ModelMessage,
  ]);

  const values = valuesOf(partsOf(pruned[0] as ModelMessage)[0]);
  expect(values.map((v) => v.type)).toEqual(['text', 'text', 'file-data']);
  // the older frame collapses to the stale note
  expect(values[1]?.text).toBe(STALE_FRAME_NOTE);
  // the newer frame stays a live image
  expect(values[2]).toEqual({ type: 'file-data', data: 'FRAME-a-new', mediaType: 'image/png' });
  // the look result's own text part is untouched
  expect(values[0]).toEqual({ type: 'text', text: 'screenshot saved: a.png' });
});

test('pruneStaleFrames leaves exactly ONE live frame across the whole transcript', () => {
  const user: ModelMessage = { role: 'user', content: 'go' };
  // frames in separate messages AND two inside one message
  const messages = [user, lookFrameMessage('a'), lookFrameMessage('b', 'c')];
  const pruned = pruneStaleFrames(messages);

  const live = pruned.flatMap((message) => liveFrames(message));
  expect(live).toHaveLength(1);
  // the survivor is the NEWEST frame
  expect(live[0]?.data).toBe('FRAME-c');
  // untouched messages pass through by reference
  expect(pruned[0]).toBe(user);
});

test('pruneStaleFrames leaves the look text and a sibling act result untouched', () => {
  const actResult = {
    type: 'tool-result',
    toolCallId: 'x',
    toolName: 'act',
    output: { type: 'json', value: { label: 'click', screenshot: 's.png' } },
  };
  const mixed = {
    role: 'tool',
    content: [actResult, lookResult('a'), lookResult('b')],
  } as unknown as ModelMessage;

  const pruned = pruneStaleFrames([mixed]);
  const parts = partsOf(pruned[0] as ModelMessage);

  // the act result is untouched — same object, same value
  expect(parts[0] as unknown).toBe(actResult);
  expect((parts[0] as { output: { value: unknown } }).output.value).toEqual({
    label: 'click',
    screenshot: 's.png',
  });
  // the older look result keeps its own text part
  expect(valuesOf(parts[1])[0]).toEqual({ type: 'text', text: 'screenshot saved: a.png' });
  // the newer look result keeps its frame
  expect(valuesOf(parts[2])[0]).toEqual({ type: 'text', text: 'screenshot saved: b.png' });
  expect(valuesOf(parts[2])[1]).toEqual({
    type: 'file-data',
    data: 'FRAME-b',
    mediaType: 'image/png',
  });
});

test('pruneStaleFrames returns the SAME array when there is at most one frame', () => {
  const single = [{ role: 'user', content: 'go' } as ModelMessage, lookFrameMessage('only')];
  expect(pruneStaleFrames(single)).toBe(single);
  const none = [{ role: 'user', content: 'go' } as ModelMessage];
  expect(pruneStaleFrames(none)).toBe(none);
});

test('pruneStaleFrames returns a NEW array when ONE message holds two frames', () => {
  const messages = [lookFrameMessage('a', 'b')];
  const pruned = pruneStaleFrames(messages);
  expect(pruned).not.toBe(messages);
  expect(pruned).toHaveLength(1);
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
