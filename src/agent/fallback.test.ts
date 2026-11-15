import { expect, test } from 'bun:test';
import { APICallError, generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { DEFAULT_MODELS } from '../config/load.js';
import { type FallbackEvent, withFallback } from './fallback.js';
import { resolveModels } from './models.js';
import { createOpenRouterProvider } from './provider.js';

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function answering(modelId: string, text: string): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => ({
      content: text === '' ? [] : [{ type: 'text', text }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage,
      warnings: [],
    }),
  });
}

function failing(modelId: string, statusCode: number): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: async () => {
      throw new APICallError({
        message: `upstream ${statusCode}`,
        url: 'https://openrouter.ai/api/v1/chat/completions',
        requestBodyValues: {},
        statusCode,
      });
    },
  });
}

function run(primary: MockLanguageModelV4, fallback: MockLanguageModelV4) {
  const events: FallbackEvent[] = [];
  const model = withFallback(primary, fallback, (e) => events.push(e));
  return { events, text: () => generateText({ model, prompt: 'hi', maxRetries: 0 }) };
}

test('withFallback: a 429 on the free primary is served by the paid fallback, and reported', async () => {
  const fallback = answering('paid/model', 'from fallback');
  const { events, text } = run(failing('free/model:free', 429), fallback);
  expect((await text()).text).toBe('from fallback');
  expect(fallback.doGenerateCalls).toHaveLength(1);
  expect(events).toEqual([
    { primary: 'free/model:free', fallback: 'paid/model', reason: 'HTTP 429' },
  ]);
});

test('withFallback: 5xx and 404 (retired :free id) fall back too', async () => {
  for (const status of [502, 404]) {
    const { events, text } = run(failing('free/m', status), answering('paid/m', 'ok'));
    expect((await text()).text).toBe('ok');
    expect(events[0]?.reason).toBe(`HTTP ${status}`);
  }
});

test('withFallback: an empty answer from the primary is re-asked on the fallback', async () => {
  const { events, text } = run(answering('free/m', ''), answering('paid/m', 'filled'));
  expect((await text()).text).toBe('filled');
  expect(events[0]?.reason).toBe('empty response');
});

test('withFallback: a healthy primary never touches the fallback', async () => {
  const fallback = answering('paid/m', 'unused');
  const { events, text } = run(answering('free/m', 'primary'), fallback);
  expect((await text()).text).toBe('primary');
  expect(fallback.doGenerateCalls).toHaveLength(0);
  expect(events).toEqual([]);
});

test('withFallback: a 400 (bad request) propagates — never hidden behind another model', async () => {
  const fallback = answering('paid/m', 'unused');
  const { events, text } = run(failing('free/m', 400), fallback);
  await expect(text()).rejects.toThrow('upstream 400');
  expect(fallback.doGenerateCalls).toHaveLength(0);
  expect(events).toEqual([]);
});

test('resolveModels over HTTP: the free default 429s, the paid fallback id is requested and answers', async () => {
  const requested: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      requested.push(body.model);
      if (body.model.endsWith(':free')) {
        return Response.json(
          { error: { message: 'rate-limited upstream', code: 429 } },
          { status: 429 },
        );
      }
      return Response.json({
        id: 'c',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'paid OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    const roles: string[] = [];
    const models = resolveModels(
      createOpenRouterProvider({ apiKey: 'test-key', baseURL: `${server.url}api/v1` }),
      {},
      (role) => roles.push(role),
    );
    const result = await generateText({ model: models.driver, prompt: 'go', maxRetries: 0 });
    expect(result.text).toBe('paid OK');
    expect(requested).toEqual([DEFAULT_MODELS.driver, DEFAULT_MODELS.fallback]);
    expect(roles).toEqual(['driver']);
  } finally {
    await server.stop(true);
  }
});

test('the defaults are free primaries behind a paid fallback', () => {
  for (const id of [DEFAULT_MODELS.driver, DEFAULT_MODELS.vision, DEFAULT_MODELS.summary]) {
    expect(id.endsWith(':free')).toBe(true);
  }
  expect(DEFAULT_MODELS.fallback.endsWith(':free')).toBe(false);
});
