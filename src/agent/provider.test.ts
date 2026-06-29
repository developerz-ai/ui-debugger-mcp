import { expect, test } from 'bun:test';
import { ProviderError } from '../errors.js';
import { createOpenRouterProvider } from './provider.js';

test('createOpenRouterProvider: throws ProviderError when no API key is available', () => {
  // Temporarily clear env vars
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    expect(() => createOpenRouterProvider()).toThrow(ProviderError);
  } finally {
    // Restore env vars
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
  }
});

test('createOpenRouterProvider: throws ProviderError when API key is empty string', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    expect(() => createOpenRouterProvider({ apiKey: '   ' })).toThrow(ProviderError);
  } finally {
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
  }
});

test('createOpenRouterProvider: uses provided apiKey', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    // Should not throw with a provided apiKey
    const provider = createOpenRouterProvider({ apiKey: 'test-key' });
    expect(provider).toBeDefined();
  } finally {
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
  }
});

test('createOpenRouterProvider: uses OPENAI_API_KEY fallback', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;

  try {
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = 'openai-key';

    const provider = createOpenRouterProvider();
    expect(provider).toBeDefined();
  } finally {
    delete process.env.OPENAI_API_KEY;
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
  }
});

test('createOpenRouterProvider: uses OPENROUTER_API_KEY fallback', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;

  try {
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = 'openrouter-key';

    const provider = createOpenRouterProvider();
    expect(provider).toBeDefined();
  } finally {
    delete process.env.OPENROUTER_API_KEY;
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
  }
});

test('createOpenRouterProvider: prefers provided apiKey over env vars', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;

  try {
    process.env.OPENAI_API_KEY = 'env-openai-key';
    process.env.OPENROUTER_API_KEY = 'env-openrouter-key';

    // Should not throw and should use the provided key
    const provider = createOpenRouterProvider({ apiKey: 'provided-key' });
    expect(provider).toBeDefined();
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
  }
});

test('createOpenRouterProvider: uses provided baseURL', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalBaseURL = process.env.OPENAI_BASE_URL;

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    process.env.OPENAI_API_KEY = 'test-key';

    const provider = createOpenRouterProvider({ baseURL: 'https://custom.api/v1' });
    expect(provider).toBeDefined();
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
    if (originalBaseURL) process.env.OPENAI_BASE_URL = originalBaseURL;
  }
});

test('createOpenRouterProvider: uses OPENAI_BASE_URL env var fallback', () => {
  const originalOpenAI = process.env.OPENAI_API_KEY;
  const originalOpenRouter = process.env.OPENROUTER_API_KEY;
  const originalBaseURL = process.env.OPENAI_BASE_URL;

  try {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    process.env.OPENAI_API_KEY = 'test-key';
    process.env.OPENAI_BASE_URL = 'https://env-base-url/v1';

    const provider = createOpenRouterProvider();
    expect(provider).toBeDefined();
  } finally {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_BASE_URL;
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    if (originalOpenRouter) process.env.OPENROUTER_API_KEY = originalOpenRouter;
    if (originalBaseURL) process.env.OPENAI_BASE_URL = originalBaseURL;
  }
});
