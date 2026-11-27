/**
 * Self-look frame hygiene for the debug loop's transcript.
 *
 * A multimodal driver's `look` returns the screenshot itself, and the SDK
 * re-sends every tool result on every step — so each frame would ride along for
 * the rest of the run. {@link pruneStaleFrames} keeps only the newest one live;
 * the loop applies it per step in `prepareStep` (`loop.ts`).
 */

import type { ModelMessage } from 'ai';

/** What a pruned frame collapses to — tells the driver how to get a fresh one. */
export const STALE_FRAME_NOTE = '[stale frame removed — call look again for a fresh screenshot]';

/**
 * A tool-result part that may carry a self-look frame, narrowed to what the
 * prune reads: a `look` tool-result whose `content` output holds the frame.
 */
type FramePart = {
  type?: string;
  toolName?: string;
  output?: { type?: string; value?: unknown };
};

/** Where one live self-look frame sits in the transcript. */
type FrameSite = {
  /** Index of the message holding the frame. */
  messageIndex: number;
  /** Index of the tool-result part inside that message's content. */
  partIndex: number;
  /** Index of the `file` value inside that part's output value array. */
  valueIndex: number;
};

/** The content parts of a message as a plain array (empty for string content). */
function partsOf(message: ModelMessage): unknown[] {
  return Array.isArray(message.content) ? (message.content as unknown[]) : [];
}

/**
 * Every self-look frame in the transcript, in transcript order (message →
 * content part → output value).
 *
 * A frame is ONE `file` value part of a look tool-result. AI SDK 6 puts ALL
 * of a step's tool results into ONE `tool`-role message, so a step that called
 * `look` twice carries TWO frames inside a SINGLE message — counting messages
 * instead of frames let both survive and stacked the driver's images.
 */
function findFrames(messages: ModelMessage[]): FrameSite[] {
  const frames: FrameSite[] = [];
  messages.forEach((message, messageIndex) => {
    partsOf(message).forEach((part, partIndex) => {
      // A content array may hold a null/undefined part — skip it instead of
      // dereferencing it and killing the whole run inside `prepareStep`.
      if (typeof part !== 'object' || part === null) return;
      const p = part as FramePart;
      if (p.type !== 'tool-result' || p.toolName !== 'look') return;
      const output = p.output;
      if (output?.type !== 'content') return;
      const values = output.value;
      if (!Array.isArray(values)) return;
      (values as unknown[]).forEach((value, valueIndex) => {
        if ((value as { type?: string } | null | undefined)?.type === 'file') {
          frames.push({ messageIndex, partIndex, valueIndex });
        }
      });
    });
  });
  return frames;
}

/** Collapse the stale frames of ONE tool-result part to the stale-frame note. */
function collapseStaleFrames(part: unknown, staleValues: ReadonlySet<number>): unknown {
  const p = part as FramePart;
  const values = (p.output?.value ?? []) as unknown[];
  return {
    ...p,
    output: {
      ...p.output,
      value: values.map((value, valueIndex) =>
        staleValues.has(valueIndex) ? { type: 'text' as const, text: STALE_FRAME_NOTE } : value,
      ),
    },
  };
}

/**
 * Keep only the NEWEST self-look frame in the transcript. The SDK re-sends every
 * tool result on every step, so each `look` image would otherwise ride along for
 * the rest of the run — N looks × M steps of image tokens. Rebuilt per step in
 * `prepareStep`, over the stripped chain (`stripInjectedStepMessages`, `loop.ts`).
 *
 * Counts FRAMES, not messages: AI SDK 6 collects ALL of a step's tool results
 * into ONE `tool`-role message, so a step that looked twice holds two frames in
 * a single message. The newest frame (last in transcript order) stays live and
 * every older one collapses to {@link STALE_FRAME_NOTE}; the rest of each
 * tool-result (its own text, a sibling `act` result) is left exactly as it was.
 * Returns the SAME array when the transcript holds at most ONE frame, keeping
 * the no-change fast path.
 */
export function pruneStaleFrames(messages: ModelMessage[]): ModelMessage[] {
  const frames = findFrames(messages);
  if (frames.length <= 1) return messages;
  // Every frame but the LAST is stale — group them by the part they live in.
  const staleByMessage = new Map<number, Map<number, Set<number>>>();
  for (const frame of frames.slice(0, -1)) {
    let parts = staleByMessage.get(frame.messageIndex);
    if (!parts) {
      parts = new Map<number, Set<number>>();
      staleByMessage.set(frame.messageIndex, parts);
    }
    let values = parts.get(frame.partIndex);
    if (!values) {
      values = new Set<number>();
      parts.set(frame.partIndex, values);
    }
    values.add(frame.valueIndex);
  }
  return messages.map((message, messageIndex) => {
    const staleParts = staleByMessage.get(messageIndex);
    if (!staleParts) return message;
    const content = partsOf(message).map((part, partIndex) => {
      const staleValues = staleParts.get(partIndex);
      return staleValues ? collapseStaleFrames(part, staleValues) : part;
    });
    return { ...message, content } as unknown as ModelMessage;
  });
}
