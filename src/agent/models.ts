/**
 * Per-role model resolver — binds the three actors' model ids to `LanguageModel`s.
 *
 * Each role's id resolves from project config over the per-role defaults
 * (`DEFAULT_MODELS`): deepseek for text (driver + summary), glm for image
 * (vision) — see `idea/models.md`. Resolved ids are bound to the
 * OpenAI-compatible provider via `provider.chat(modelId)`, yielding the
 * `LanguageModel`s the agent loop hands to the Vercel AI SDK.
 */

import type { LanguageModel } from 'ai';
import { DEFAULT_MODELS } from '../config/load.js';
import type { Models } from '../config/schema.js';
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

/**
 * Resolve per-role model ids (config over `DEFAULT_MODELS`) and bind each to the
 * provider as a chat `LanguageModel`. Omitted roles fall back to the defaults.
 */
export function resolveModels(
  provider: OpenRouterProvider,
  models: Partial<Models> = {},
): RoleModels {
  return {
    driver: provider.chat(models.driver ?? DEFAULT_MODELS.driver),
    vision: provider.chat(models.vision ?? DEFAULT_MODELS.vision),
    summary: provider.chat(models.summary ?? DEFAULT_MODELS.summary),
  };
}
