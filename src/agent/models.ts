/**
 * Per-role model resolver — binds the three actors' model ids to `LanguageModel`s.
 *
 * Each role's id resolves from project config over the per-role defaults
 * (`DEFAULT_MODELS`): free OpenRouter models, one paid `fallback` behind every
 * role — see `idea/models.md`. Resolved ids are bound to the OpenAI-compatible
 * provider via `provider.chat(modelId)` and wrapped by `withFallback`, yielding
 * the `LanguageModel`s the agent loop hands to the Vercel AI SDK.
 */

import type { LanguageModel } from 'ai';
import { DEFAULT_MODELS } from '../config/load.js';
import type { Models } from '../config/schema.js';
import { type OnFallback, withFallback } from './fallback.js';
import type { OpenRouterProvider } from './provider.js';

/** The three actors' models, bound and ready for the AI SDK. */
export interface RoleModels {
  /** fast guy — the blind text driver running the high-frequency click loop. */
  driver: LanguageModel;
  /** vision guy — the multimodal eyes (`look`: describes/judges screenshots). */
  vision: LanguageModel;
  /** summary — compresses findings for the smart agent. */
  summary: LanguageModel;
}

/** Every fallback names its role, so a log line says WHICH actor left its primary. */
export type OnRoleFallback = (role: keyof RoleModels, event: Parameters<OnFallback>[0]) => void;

/**
 * Resolve per-role model ids (config over `DEFAULT_MODELS`) and bind each to the
 * provider as a chat `LanguageModel` with the fallback behind it. Omitted roles
 * fall back to the defaults. A role whose primary IS the fallback is bound bare.
 */
export function resolveModels(
  provider: OpenRouterProvider,
  models: Partial<Models> = {},
  onFallback: OnRoleFallback = () => {},
): RoleModels {
  const fallbackId = models.fallback ?? DEFAULT_MODELS.fallback;
  const bind = (role: keyof RoleModels, id: string): LanguageModel =>
    id === fallbackId
      ? provider.chat(id)
      : withFallback(provider.chat(id), provider.chat(fallbackId), (event) =>
          onFallback(role, event),
        );
  return {
    driver: bind('driver', models.driver ?? DEFAULT_MODELS.driver),
    vision: bind('vision', models.vision ?? DEFAULT_MODELS.vision),
    summary: bind('summary', models.summary ?? DEFAULT_MODELS.summary),
  };
}
