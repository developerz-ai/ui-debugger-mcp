import { expect, test } from 'bun:test';
import type { LanguageModelV4 } from '@openrouter/ai-sdk-provider';
import { generateText, type LanguageModel } from 'ai';
import { DEFAULT_MODELS } from '../config/load.js';
import { resolveModels } from './models.js';
import { createOpenRouterProvider } from './provider.js';

const provider = createOpenRouterProvider({ apiKey: 'test-key' });

test('resolved OpenRouter models generate text through the installed AI SDK', async () => {
  const requestedModels: string[] = [];
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string };
      requestedModels.push(body.model);
      return Response.json({
        id: 'test-completion',
        object: 'chat.completion',
        created: 0,
        model: body.model,
        choices: [
          { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  try {
    const models = resolveModels(
      createOpenRouterProvider({ apiKey: 'test-key', baseURL: `${server.url}api/v1` }),
    );
    for (const model of [models.driver, models.vision, models.summary]) {
      const result = await generateText({ model, prompt: 'Reply OK', maxRetries: 0 });
      expect(result.text).toBe('OK');
    }
    expect(requestedModels).toEqual([
      DEFAULT_MODELS.driver,
      DEFAULT_MODELS.vision,
      DEFAULT_MODELS.summary,
    ]);
  } finally {
    await server.stop(true);
  }
});

/** Read the bound model id off a resolved role model. */
const modelId = (m: LanguageModel): string => (m as LanguageModelV4).modelId;

test('resolveModels: falls back to per-role defaults when config omits roles', () => {
  const models = resolveModels(provider);
  expect(modelId(models.driver)).toBe(DEFAULT_MODELS.driver);
  expect(modelId(models.vision)).toBe(DEFAULT_MODELS.vision);
  expect(modelId(models.summary)).toBe(DEFAULT_MODELS.summary);
});

test('resolveModels: uses configured ids over defaults', () => {
  const models = resolveModels(provider, {
    driver: 'anthropic/claude-3.5-haiku',
    vision: 'openai/gpt-4o',
    summary: 'meta-llama/llama-3.1-8b-instruct',
  });
  expect(modelId(models.driver)).toBe('anthropic/claude-3.5-haiku');
  expect(modelId(models.vision)).toBe('openai/gpt-4o');
  expect(modelId(models.summary)).toBe('meta-llama/llama-3.1-8b-instruct');
});

test('resolveModels: partial config overrides only named roles, defaults the rest', () => {
  const models = resolveModels(provider, { driver: 'custom/driver-model' });
  expect(modelId(models.driver)).toBe('custom/driver-model');
  expect(modelId(models.vision)).toBe(DEFAULT_MODELS.vision);
  expect(modelId(models.summary)).toBe(DEFAULT_MODELS.summary);
});
