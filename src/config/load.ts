/**
 * Config loader + resolution order.
 *
 * Resolves the project config (`.dz/ui-debugger/ui-debugger-mcp.json` first,
 * falling back to the root `.ui-debugger-mcp.json` — see {@link CONFIG_CANDIDATES}),
 * Zod-validates it, and resolves a fully defaulted `ResolvedConfig`.
 * Layering follows `idea/config.md`:
 *
 *   built-in defaults  <  project file  <  env
 *
 * The layers govern disjoint fields, so the order is unambiguous:
 *   - models / workspace / targets  → project file over defaults
 *   - provider creds (key, base url) → env over the OpenRouter default base url
 *
 * The provider key is resolved through the shared provider credential contract
 * (`src/agent/provider.ts`): `OPENAI_API_KEY` then `OPENROUTER_API_KEY`, the
 * same order the runtime provider uses.
 * Per-session overrides are a runtime concern, not the file loader's — the
 * doc's `Resolution order` marks the layer proposed, not shipped.
 *
 * Bad config fails fast and loud via `ConfigError` — never a silent fallback.
 * That includes a bad `.dz/` copy: it errors, never falls through to root.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import {
  type ProviderEnv,
  providerApiKeyPrecedence,
  resolveProviderApiKey,
} from '../agent/provider.js';
import { ConfigError } from '../errors.js';
import type { Target } from './schema.js';
import { ConfigSchema } from './schema.js';

/** Committed, per-project debug config filename (the legacy root location). */
export const CONFIG_FILENAME = '.ui-debugger-mcp.json';

/**
 * Where the per-repo config may live, in resolution order: the `.dz/`
 * consolidation location first, the repo-root file as the legacy fallback.
 * Every config read/write resolves through {@link resolveConfigPath}, so this
 * array is the ONE place the order lives.
 */
export const CONFIG_CANDIDATES = ['.dz/ui-debugger/ui-debugger-mcp.json', CONFIG_FILENAME] as const;

/** Default base url — OpenRouter. Override with env `OPENAI_BASE_URL`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/** A provider base url: absolute, http(s) only. */
const BaseUrlSchema = z.url({ protocol: /^https?$/ });

/** Default workspace dir (per-project sessions, profiles, logs). */
export const DEFAULT_WORKSPACE = './tmp/ui-debugger-mcp';

/**
 * Per-role model defaults — free OpenRouter models, one paid fallback behind them.
 *
 * Measured 2026-11-14 on the `dummy/web` planted-bug fixture (real runs, real
 * OpenRouter): particle-1 driving + nemotron-3.5-super-vl seeing found every
 * planted bug (404s, the JSON error, the ReferenceError, both dead buttons, the
 * invisible subtitle), where the previous paid deepseek-v4-flash + qwen3-vl pair
 * missed the visual ones. `:free` models are rate-limited and throttled at will,
 * so `fallback` (text + image + tools, the cheapest provider via `:floor`) takes
 * any call a primary cannot serve — see `src/agent/fallback.ts`. Driver and
 * summary sit on DIFFERENT free models so they never share one per-model limit.
 *
 * Plain catalog ids or router suffixes only: the router rejects `#uptime`
 * outright (`… is not a valid model ID`, HTTP 400), so shipping it as the
 * default driver made a fresh install fail on its very first run. See
 * `idea/models.md`.
 */
export const DEFAULT_MODELS: ResolvedModels = {
  driver: 'particle-ai/particle-1:free',
  vision: 'nvidia/nemotron-3.5-super-vl:free',
  summary: 'baidu/ernie-5.5-flash-preview:free',
  fallback: 'deepseek/deepseek-v4.1-flash:floor',
};

/** Fully resolved per-role models — every role present after defaulting. */
export interface ResolvedModels {
  driver: string;
  vision: string;
  summary: string;
  /** Paid model behind every role (`src/agent/fallback.ts`). */
  fallback: string;
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
 * The config path this project actually uses, resolved against `cwd`:
 *
 *  - the first candidate FILE that exists — `.dz/` wins when both do
 *  - when neither exists, the path a fresh `init` should WRITE: the `.dz/`
 *    location if the repo already has a `.dz/` dir, else the root file.
 */
export function resolveConfigPath(cwd: string): string {
  for (const candidate of CONFIG_CANDIDATES) {
    const path = join(cwd, candidate);
    if (existsSync(path)) return path;
  }
  return join(cwd, existsSync(join(cwd, '.dz')) ? CONFIG_CANDIDATES[0] : CONFIG_FILENAME);
}

/**
 * The shadowed root filename when BOTH candidates exist — what callers print as
 * the one-line "you have two configs" notice (`.dz/` wins). `null` otherwise.
 */
export function ignoredRootConfig(cwd: string): string | null {
  if (!existsSync(join(cwd, CONFIG_CANDIDATES[0]))) return null;
  return existsSync(join(cwd, CONFIG_FILENAME)) ? CONFIG_FILENAME : null;
}

/** The candidate as the user writes it (relative to `cwd`) — for messages. */
function configName(cwd: string, path: string): string {
  return relative(cwd, path) || CONFIG_FILENAME;
}

/**
 * Load, validate, and resolve the project config. Throws `ConfigError` if the
 * file is missing, not JSON, fails the schema, or no provider API key is set
 * (`OPENAI_API_KEY` / `OPENROUTER_API_KEY`).
 */
export function loadConfig(opts: LoadOptions = {}): ResolvedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const env = opts.env ?? process.env;
  const path = resolveConfigPath(cwd);

  if (!existsSync(path)) {
    throw new ConfigError(
      `No project config in ${cwd} — tried \`${CONFIG_CANDIDATES[0]}\` then \`${CONFIG_FILENAME}\`. ` +
        'Run `ui-debugger-mcp init` to scaffold it.',
    );
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `Failed to read \`${configName(cwd, path)}\`: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const project = parseProject(raw, configName(cwd, path));

  return {
    models: {
      driver: project.models?.driver ?? DEFAULT_MODELS.driver,
      vision: project.models?.vision ?? DEFAULT_MODELS.vision,
      summary: project.models?.summary ?? DEFAULT_MODELS.summary,
      fallback: project.models?.fallback ?? DEFAULT_MODELS.fallback,
    },
    workspace: project.workspace ?? DEFAULT_WORKSPACE,
    targets: project.targets,
    provider: resolveProvider(env),
  };
}

/**
 * Resolve just the workspace dir for a project — no provider creds required.
 * Backs the `status` / `stop` CLI, which read `state.json` but need no API key.
 *
 * Falls back to {@link DEFAULT_WORKSPACE} only when the config file is ABSENT. A
 * present-but-invalid config surfaces its `ConfigError` (fail loud, no silent
 * fallback) — otherwise a typo anywhere in the file would silently point `status`/
 * `stop` at the default workspace and report "no run" for a custom-workspace run.
 */
export function loadWorkspaceDir(cwd: string = process.cwd()): string {
  const path = resolveConfigPath(cwd);
  if (!existsSync(path)) return DEFAULT_WORKSPACE;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    throw new ConfigError(
      `Failed to read \`${configName(cwd, path)}\`: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return parseProject(raw, configName(cwd, path)).workspace ?? DEFAULT_WORKSPACE;
}

/** Parse JSON + Zod-validate the raw file contents into a typed config. */
function parseProject(raw: string, name: string) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new ConfigError(
      `\`${name}\` is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  const result = ConfigSchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new ConfigError(`\`${name}\` is invalid: ${issues}`);
  }
  return result.data;
}

/**
 * Resolve OpenAI-compatible router creds: env over the OpenRouter default base url.
 *
 * The key comes from the shared provider credential contract — explicit value,
 * then `OPENAI_API_KEY`, then `OPENROUTER_API_KEY` (`PROVIDER_API_KEY_ENV_VARS`
 * in `src/agent/provider.ts`) — so boot and runtime resolve identically.
 * The missing-key message reuses the same precedence clause as the runtime
 * guidance ({@link providerApiKeyPrecedence}), so both name the same keys AND
 * the same precedence, and never carry a value.
 */
function resolveProvider(env: ProviderEnv): ProviderConfig {
  const apiKey = resolveProviderApiKey(undefined, env);
  if (!apiKey) {
    throw new ConfigError(
      `No provider API key found — ${providerApiKeyPrecedence()} (add the model API key to your \`.mcp.json\` env).`,
    );
  }
  const baseUrl = env.OPENAI_BASE_URL?.trim() || OPENROUTER_BASE_URL;
  // Env is a boundary too: `openrouter.ai/api/v1` (no scheme) otherwise boots fine
  // and only fails as an opaque fetch error on the run's first model call.
  if (!BaseUrlSchema.safeParse(baseUrl).success) {
    throw new ConfigError(
      `OPENAI_BASE_URL must be an http(s) URL (e.g. ${OPENROUTER_BASE_URL}), got ${JSON.stringify(baseUrl)}.`,
    );
  }
  return { apiKey, baseUrl };
}
