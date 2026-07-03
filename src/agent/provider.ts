/**
 * OpenAI-compatible provider (OpenRouter default) for the debug agent.
 * Resolves API key and base URL with fallbacks from environment variables.
 */

import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import { ProviderError } from '../errors.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

export interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Resolve the provider endpoint the same way `createOpenRouterProvider` does —
 * apiKey: provided value → OPENAI_API_KEY → OPENROUTER_API_KEY;
 * baseURL: provided value → OPENAI_BASE_URL → DEFAULT_BASE_URL.
 * Exported so capability probes hit the exact endpoint the models run against.
 * Throws ProviderError if no API key is found or if it's empty.
 */
export function resolveProviderConfig(options: ProviderOptions = {}): {
  apiKey: string;
  baseURL: string;
} {
  const apiKey =
    options.apiKey || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY || '';
  if (!apiKey || apiKey.trim() === '') {
    throw new ProviderError(
      'No API key found. Set OPENAI_API_KEY or OPENROUTER_API_KEY in the environment, or provide apiKey in options.',
    );
  }
  const baseURL = options.baseURL || process.env.OPENAI_BASE_URL || DEFAULT_BASE_URL;
  return { apiKey, baseURL };
}

/**
 * Create an OpenRouter provider with fallback resolution (see
 * {@link resolveProviderConfig} for the chains).
 */
export function createOpenRouterProvider(options: ProviderOptions = {}): OpenRouterProvider {
  const { apiKey, baseURL } = resolveProviderConfig(options);
  return createOpenRouter({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
  });
}

export type { OpenRouterProvider };
