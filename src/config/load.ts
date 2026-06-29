/**
 * Config loader + resolution order.
 *
 * Reads `./.ui-debugger-mcp.json` (cwd), Zod-validates it, and resolves a fully
 * defaulted `ResolvedConfig`. Layering follows `idea/config.md`:
 *
 *   built-in defaults  <  project file  <  env
 *
 * The layers govern disjoint fields, so the order is unambiguous:
 *   - models / workspace / targets  → project file over defaults
 *   - provider creds (key, base url) → env over the OpenRouter default base url
 * The per-session smart-agent overrides (top of the documented order) are a
 * runtime concern, not the file loader's — out of scope here.
 *
 * Bad config fails fast and loud via `ConfigError` — never a silent fallback.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigError } from '../errors.js';
import type { Target } from './schema.js';
import { ConfigSchema } from './schema.js';

/** Committed, per-project debug config filename, resolved against the cwd. */
export const CONFIG_FILENAME = '.ui-debugger-mcp.json';

/** Default base url — OpenRouter. Override with env `OPENAI_BASE_URL`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** Default workspace dir (per-project sessions, profiles, logs). */
export const DEFAULT_WORKSPACE = './tmp/ui-debugger-mcp';

/** Per-role model defaults — deepseek for text, glm for image. See `idea/models.md`. */
export const DEFAULT_MODELS: ResolvedModels = {
  driver: 'deepseek/deepseek-v4-flash#uptime',
  vision: 'z-ai/glm-5v-turbo',
  summary: 'deepseek/deepseek-v4-flash',
};

/** Fully resolved per-role models — every role present after defaulting. */
export interface ResolvedModels {
  driver: string;
  vision: string;
  summary: string;
}

/** OpenAI-compatible router credentials, resolved from env + the OpenRouter default. */
export interface ProviderConfig {
  apiKey: string;
  baseUrl: string;
}

/** Resolved config: project values with defaults filled and env-sourced creds. */
export interface ResolvedConfig {
  models: ResolvedModels;
  workspace: string;
  targets: Record<string, Target>;
  provider: ProviderConfig;
}

export interface LoadOptions {
  /** Project root holding the config file. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Environment source for provider creds. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

/**
 * Load, validate, and resolve the project config. Throws `ConfigError` if the
 * file is missing, not JSON, fails the schema, or `OPENAI_API_KEY` is unset.
 */
export function loadConfig(opts: LoadOptions = {}): ResolvedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const path = join(cwd, CONFIG_FILENAME);

  if (!existsSync(path)) {
    throw new ConfigError(
      `\`${CONFIG_FILENAME}\` not found in ${cwd}. Run \`ui-debugger-mcp init\` to scaffold it.`,
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `Failed to read \`${CONFIG_FILENAME}\`: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const project = parseProject(raw);

  return {
    models: {
      driver: project.models?.driver ?? DEFAULT_MODELS.driver,
      vision: project.models?.vision ?? DEFAULT_MODELS.vision,
      summary: project.models?.summary ?? DEFAULT_MODELS.summary,
    },
    workspace: project.workspace ?? DEFAULT_WORKSPACE,
    targets: project.targets,
    provider: resolveProvider(env),
  };
}

/** Parse JSON + Zod-validate the raw file contents into a typed config. */
function parseProject(raw: string) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(
      `\`${CONFIG_FILENAME}\` is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`\`${CONFIG_FILENAME}\` is invalid: ${issues}`);
  }
  return result.data;
}

/** Resolve OpenAI-compatible router creds: env over the OpenRouter default base url. */
function resolveProvider(env: Record<string, string | undefined>): ProviderConfig {
  const apiKey = env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      'OPENAI_API_KEY is not set — add the model API key to your `.mcp.json` env.',
    );
  }
  const baseUrl = env.OPENAI_BASE_URL?.trim() || OPENROUTER_BASE_URL;
  return { apiKey, baseUrl };
}
