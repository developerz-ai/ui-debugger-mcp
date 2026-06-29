import { expect, test } from 'bun:test';
import type { LanguageModelV3 } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import { DEFAULT_MODELS } from '../config/load.js';
import { resolveModels } from './models.js';
import { createOpenRouterProvider } from './provider.js';

const provider = createOpenRouterProvider({ apiKey: 'test-key' });

/** Read the bound model id off a resolved role model. */
const modelId = (m: LanguageModel): string => (m as LanguageModelV3).modelId;

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
