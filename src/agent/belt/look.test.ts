import { expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { Adapter } from '../../adapters/contract.js';
import { AdapterError, AgentError, VisionUnavailableError } from '../../errors.js';
import {
  createLookExecute,
  createLookTool,
  createSelfLookTool,
  type EvidenceRecorder,
  isImageRejection,
  LookInputSchema,
  runLook,
  type VisionGenerate,
  type VisionRequest,
  visionUnavailableMessage,
} from './look.js';

/** A fake {@link Adapter} whose only meaningful method is `screenshot`. */
function fakeAdapter(png: Uint8Array, order?: string[]): Adapter {
  return {
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async () => [],
    screenshot: async () => {
      order?.push('screenshot');
      return png;
    },
    waitFor: async () => {},
    console: async () => [],
    network: async () => [],
    close: async () => {},
  };
}

/** A fake {@link VisionGenerate} returning canned text and recording its request. */
function fakeVision(
  text: string,
  order?: string[],
): { generate: VisionGenerate; seen: VisionRequest[] } {
  const seen: VisionRequest[] = [];
  const generate: VisionGenerate = async (req) => {
    order?.push('generate');
    seen.push(req);
    return { text };
  };
  return { generate, seen };
}

/** A fake {@link EvidenceRecorder} that records what it saved. */
function fakeRecorder(order?: string[]): {
  recorder: EvidenceRecorder;
  saved: Array<{ label: string; data: Uint8Array }>;
} {
  const saved: Array<{ label: string; data: Uint8Array }> = [];
  const recorder: EvidenceRecorder = {
    saveScreenshot: async (label, data) => {
      order?.push('save');
      saved.push({ label, data });
      return `screenshots/001-${label}.png`;
    },
  };
  return { recorder, saved };
}

const PNG = new Uint8Array([137, 80, 78, 71]);

const cleanReply = JSON.stringify({
  description: 'A blue button, centred.',
  matches: true,
  issues: [{ what: 'low contrast label', where: 'primary button', severity: 'low' }],
});

test('captures the frame and sends it to the vision model with the question', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate, seen } = fakeVision(cleanReply);
  const { recorder } = fakeRecorder();
  await runLook(adapter, generate, recorder, { question: 'is the button centred?' });

  expect(seen).toHaveLength(1);
  const content = seen[0]?.messages[0]?.content;
  expect(Array.isArray(content)).toBe(true);
  // both a text part (the question) and the captured image part are sent
  expect(content).toEqual([
    { type: 'text', text: 'Question: is the button centred?' },
    { type: 'image', image: PNG, mediaType: 'image/png' },
  ]);
  expect(seen[0]?.messages[0]?.role).toBe('user');
  expect(typeof seen[0]?.system).toBe('string');
});

test('parses a clean JSON reply into description + matches + issues', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate } = fakeVision(cleanReply);
  const { recorder } = fakeRecorder();
  const res = await runLook(adapter, generate, recorder, {
    question: 'centred?',
    expect: 'a centred blue button',
  });
  expect(res.description).toBe('A blue button, centred.');
  expect(res.matches).toBe(true);
  expect(res.issues).toEqual([
    { what: 'low contrast label', where: 'primary button', severity: 'low' },
  ]);
});

test('attaches the screenshot as evidence (saves the exact captured png)', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate } = fakeVision(cleanReply);
  const { recorder, saved } = fakeRecorder();
  const res = await runLook(adapter, generate, recorder, { question: 'centred?' });
  expect(saved).toEqual([{ label: 'centred?', data: PNG }]);
  expect(res.screenshot).toBe('screenshots/001-centred?.png');
});

test('order: capture, then ask vision, then save evidence', async () => {
  const order: string[] = [];
  const adapter = fakeAdapter(PNG, order);
  const { generate } = fakeVision(cleanReply, order);
  const { recorder } = fakeRecorder(order);
  await runLook(adapter, generate, recorder, { question: 'q' });
  expect(order).toEqual(['screenshot', 'generate', 'save']);
});

test('strips ```json fences before parsing', async () => {
  const adapter = fakeAdapter(PNG);
  const fenced = `Here you go:\n\`\`\`json\n${JSON.stringify({ description: 'ok' })}\n\`\`\``;
  const { generate } = fakeVision(fenced);
  const { recorder } = fakeRecorder();
  const res = await runLook(adapter, generate, recorder, {});
  expect(res.description).toBe('ok');
  expect(res.issues).toEqual([]); // issues default to [] when omitted
});

test('matches is absent when the model omits it', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate } = fakeVision(JSON.stringify({ description: 'no expectation given' }));
  const { recorder } = fakeRecorder();
  const res = await runLook(adapter, generate, recorder, {});
  expect(res.matches).toBeUndefined();
});

test('no question/expect → still prompts for a general description', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate, seen } = fakeVision(JSON.stringify({ description: 'a page' }));
  const { recorder } = fakeRecorder();
  await runLook(adapter, generate, recorder, {});
  expect(seen[0]?.messages[0]?.content).toEqual([
    { type: 'text', text: 'Describe what you see and flag any visual issues.' },
    { type: 'image', image: PNG, mediaType: 'image/png' },
  ]);
});

test('non-JSON reply → throws AgentError (fail loud, no silent fallback)', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate } = fakeVision('the button looks fine to me');
  const { recorder, saved } = fakeRecorder();
  await expect(runLook(adapter, generate, recorder, { question: 'q' })).rejects.toThrow(AgentError);
  expect(saved).toEqual([]); // no evidence saved when the reply is unusable
});

test('schema-invalid reply (bad severity) → throws AgentError', async () => {
  const adapter = fakeAdapter(PNG);
  const bad = JSON.stringify({
    description: 'x',
    issues: [{ what: 'a', where: 'b', severity: 'critical' }],
  });
  const { generate } = fakeVision(bad);
  const { recorder } = fakeRecorder();
  await expect(runLook(adapter, generate, recorder, {})).rejects.toThrow(AgentError);
});

test('adapter screenshot error propagates (fail loud)', async () => {
  const adapter = fakeAdapter(PNG);
  adapter.screenshot = async () => {
    throw new AdapterError('display gone');
  };
  const { generate } = fakeVision(cleanReply);
  const { recorder } = fakeRecorder();
  await expect(runLook(adapter, generate, recorder, {})).rejects.toThrow(AdapterError);
});

test('schema accepts empty, question-only, expect-only', () => {
  expect(LookInputSchema.safeParse({}).success).toBe(true);
  expect(LookInputSchema.safeParse({ question: 'q' }).success).toBe(true);
  expect(LookInputSchema.safeParse({ expect: 'e' }).success).toBe(true);
});

test('schema rejects a non-string question', () => {
  expect(LookInputSchema.safeParse({ question: 42 }).success).toBe(false);
});

test('createLookTool exposes a described tool with an input schema', () => {
  const adapter = fakeAdapter(PNG);
  const { recorder } = fakeRecorder();
  // A model id string is a valid LanguageModel; the model is never invoked here (no execute).
  const look = createLookTool(adapter, 'vision-model-id', recorder);
  expect(typeof look.description).toBe('string');
  expect(look.inputSchema).toBeDefined();
});

test('runLook forwards the abort signal into the vision seam', async () => {
  const adapter = fakeAdapter(PNG);
  const { generate, seen } = fakeVision(cleanReply);
  const { recorder } = fakeRecorder();
  const controller = new AbortController();
  await runLook(adapter, generate, recorder, { question: 'q' }, controller.signal);
  expect(seen[0]?.abortSignal).toBe(controller.signal);
});

test('createLookTool threads the tool abort signal into the vision generateText call', async () => {
  const seenSignals: Array<AbortSignal | undefined> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ abortSignal }) => {
      seenSignals.push(abortSignal);
      return {
        content: [{ type: 'text' as const, text: cleanReply }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
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
    },
  });
  const { recorder } = fakeRecorder();
  const look = createLookTool(fakeAdapter(PNG), model, recorder);
  const controller = new AbortController();
  const result = await look.execute?.(
    { question: 'q' },
    { toolCallId: 't1', messages: [], abortSignal: controller.signal },
  );
  // Without the signal a stalled vision provider would block session teardown.
  expect(seenSignals).toEqual([controller.signal]);
  expect((result as { description: string }).description).toBe('A blue button, centred.');
});

test('isImageRejection matches the provider phrasings for text-only models', () => {
  // z.ai coding endpoint (glm text models)
  expect(isImageRejection("messages.content.type is invalid, allowed values: ['text']")).toBe(true);
  // OpenRouter / OpenAI-compatible variants
  expect(isImageRejection('This model does not support image input')).toBe(true);
  expect(isImageRejection("model doesn't support vision")).toBe(true);
  expect(isImageRejection('image input is not supported by this model')).toBe(true);
  expect(isImageRejection('Invalid content type: image_url')).toBe(true);
});

test('isImageRejection stays quiet on transient/provider-neutral errors', () => {
  expect(isImageRejection('rate limit exceeded')).toBe(false);
  expect(isImageRejection('fetch failed')).toBe(false);
  expect(isImageRejection('The operation was aborted')).toBe(false);
  expect(isImageRejection('insufficient credits')).toBe(false);
});

test('visionUnavailableMessage names the model and tells the driver to stop calling look', () => {
  const msg = visionUnavailableMessage(
    'glm-5.2',
    "content.type is invalid, allowed values: ['text']",
  );
  expect(msg).toContain("'glm-5.2'");
  expect(msg).toContain('Do NOT call look again');
  expect(msg).toContain('.ui-debugger-mcp.json');
});

test('createLookExecute latches VisionUnavailableError: later calls fail fast, no screenshot', async () => {
  const order: string[] = [];
  const adapter = fakeAdapter(PNG, order);
  const generate: VisionGenerate = async () => {
    order.push('generate');
    throw new VisionUnavailableError('look is unavailable for this run: text-only vision model');
  };
  const { recorder } = fakeRecorder();
  const execute = createLookExecute(adapter, generate, recorder);

  await expect(execute({ question: 'q' })).rejects.toThrow(VisionUnavailableError);
  // First call reached the adapter + provider…
  expect(order).toEqual(['screenshot', 'generate']);

  await expect(execute({ question: 'again' })).rejects.toThrow('look is unavailable');
  // …the latched second call touched neither.
  expect(order).toEqual(['screenshot', 'generate']);
});

test('createLookExecute does NOT latch transient errors — the next call retries fully', async () => {
  const order: string[] = [];
  const adapter = fakeAdapter(PNG, order);
  let calls = 0;
  const generate: VisionGenerate = async () => {
    order.push('generate');
    calls += 1;
    if (calls === 1) throw new Error('rate limit exceeded');
    return { text: cleanReply };
  };
  const { recorder } = fakeRecorder(order);
  const execute = createLookExecute(adapter, generate, recorder);

  await expect(execute({ question: 'q' })).rejects.toThrow('rate limit');
  const result = await execute({ question: 'q' });
  expect(result.description).toBe('A blue button, centred.');
  expect(order).toEqual(['screenshot', 'generate', 'screenshot', 'generate', 'save']);
});

test('createSelfLookTool returns the frame itself and maps it to multimodal tool output', async () => {
  const adapter = fakeAdapter(PNG);
  const { recorder, saved } = fakeRecorder();
  const selfLook = createSelfLookTool(adapter, recorder);
  const output = (await selfLook.execute?.(
    { question: 'is the button centred?' },
    { toolCallId: 't1', messages: [] },
  )) as { screenshot: string; bytes: number; prompt: string; frame: string };

  expect(saved).toHaveLength(1);
  expect(output.bytes).toBe(PNG.byteLength);
  expect(output.frame).toBe(Buffer.from(PNG).toString('base64'));
  expect(output.prompt).toContain('is the button centred?');

  const modelOutput = await selfLook.toModelOutput?.({
    toolCallId: 't1',
    input: { question: 'is the button centred?' },
    output,
  });
  expect(modelOutput?.type).toBe('content');
  const value = (modelOutput as { value: Array<{ type: string }> }).value;
  expect(value.map((v) => v.type)).toEqual(['text', 'file-data']);
  const media = value[1] as unknown as { data: string; mediaType: string };
  expect(media.mediaType).toBe('image/png');
  expect(media.data).toBe(output.frame);
});
