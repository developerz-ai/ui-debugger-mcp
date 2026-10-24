/**
 * OpenAI-compatible provider (OpenRouter default) for the debug agent.
 * Resolves API key and base URL with fallbacks from environment variables.
 */

import { createOpenRouter, type OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import { ProviderError } from '../errors.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * The provider credential contract — ONE list, used by every entry point that
 * resolves an API key (the runtime provider here, the boot-time config loader
 * in `src/config/load.ts`). Order is precedence: `OPENAI_API_KEY` wins over
 * `OPENROUTER_API_KEY` when both are set.
 *
 * Keep this list and {@link resolveProviderApiKey} in sync by using both — a
 * missing-key message that names a key this list does not accept sends the
 * user to a variable the resolver never reads.
 */
export const PROVIDER_API_KEY_ENV_VARS = ['OPENAI_API_KEY', 'OPENROUTER_API_KEY'] as const;

/** An environment-shaped record of provider credentials. */
export type ProviderEnv = Record<string, string | undefined>;

export interface ProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

/**
 * Resolve the provider API key: explicit value → `OPENAI_API_KEY` →
 * `OPENROUTER_API_KEY` (see {@link PROVIDER_API_KEY_ENV_VARS} for the
 * precedence). Blank values count as absent, so an empty variable falls
 * through to the next source instead of shadowing it.
 *
 * Returns the key only — never the whole environment, and never an error
 * message that could carry a credential value.
 */
export function resolveProviderApiKey(
  explicit?: string,
  env: ProviderEnv = process.env,
): string | undefined {
  const provided = explicit?.trim();
  if (provided) return provided;
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * The precedence clause shared by every missing-key message: the accepted
 * environment variables IN RESOLUTION ORDER, and the fact that the first one
 * wins when several are set. Derived from {@link PROVIDER_API_KEY_ENV_VARS} so
 * the resolver and the message can never drift apart.
 *
 * Never includes a credential value.
 */
export function providerApiKeyPrecedence(): string {
  const [first, ...rest] = PROVIDER_API_KEY_ENV_VARS;
  const tieBreak = rest.length > 0 ? ` (${first} wins if both are set)` : '';
  return `Set ${PROVIDER_API_KEY_ENV_VARS.join(' or ')} in the environment${tieBreak}`;
}

/**
 * The missing-key guidance, naming ONLY the environment variables this module
 * accepts. Derived from {@link PROVIDER_API_KEY_ENV_VARS} so it can never
 * drift out of sync, and never includes a credential value.
 */
export function providerApiKeyGuidance(): string {
  return `No API key found. ${providerApiKeyPrecedence()} Or provide apiKey in options.`;
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
  const apiKey = resolveProviderApiKey(options.apiKey);
  if (!apiKey) {
    throw new ProviderError(providerApiKeyGuidance());
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
