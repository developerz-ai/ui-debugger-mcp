import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PROVIDER_API_KEY_ENV_VARS, providerApiKeyGuidance } from '../agent/provider.js';
import { ConfigError } from '../errors.js';
import {
  CONFIG_CANDIDATES,
  CONFIG_FILENAME,
  DEFAULT_MODELS,
  DEFAULT_WORKSPACE,
  ignoredRootConfig,
  loadConfig,
  loadWorkspaceDir,
  OPENROUTER_BASE_URL,
  resolveConfigPath,
} from './load.js';

const minimal = {
  targets: { web: { adapter: 'browser', url: 'http://localhost:3000', headless: true } },
};

/** Write `config` (object → JSON, or raw string) into a fresh temp project dir. */
function tmpProject(config?: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'uidbg-'));
  if (config !== undefined) {
    const body = typeof config === 'string' ? config : JSON.stringify(config);
    writeFileSync(join(dir, CONFIG_FILENAME), body);
  }
  return dir;
}

/** The `.dz/` consolidation candidate — first in resolution order. */
const DZ_CANDIDATE = CONFIG_CANDIDATES[0];

/**
 * Write `config` (object → JSON, or raw string) at a candidate-relative path
 * inside `dir`, creating parent dirs (`/.dz/ui-debugger/`) as needed.
 */
function writeCandidate(dir: string, candidate: string, config: unknown): string {
  const path = join(dir, candidate);
  mkdirSync(dirname(path), { recursive: true });
  const body = typeof config === 'string' ? config : JSON.stringify(config);
  writeFileSync(path, body);
  return dir;
}

const key = { OPENAI_API_KEY: 'sk-test' };

/**
 * A credential-shaped SENTINEL — a fake value that MUST never reach a message.
 * Deliberately shaped like a real key so the shape assertions below can fail.
 */
const CREDENTIAL_SENTINEL = 'sk-ant-sentinel-0123456789abcdef';

/** Matches a credential-shaped token (the `sk-`/`rk-`/`or-`/`pk-` key families). */
const CREDENTIAL_SHAPED = /\b(?:sk|rk|or|pk)-[A-Za-z0-9_-]{8,}\b/;

/**
 * Assert `message` carries NO credential-shaped token. Reports a boolean, not
 * the message, so a failing assertion never echoes a credential value.
 */
function expectNoCredentialShapedToken(message: string): void {
  expect(CREDENTIAL_SHAPED.test(message)).toBe(false);
}

test('fills model and workspace defaults when the project omits them', () => {
  const cfg = loadConfig({ cwd: tmpProject(minimal), env: key });
  expect(cfg.models).toEqual(DEFAULT_MODELS);
  expect(cfg.workspace).toBe(DEFAULT_WORKSPACE);
  expect(cfg.targets.web?.adapter).toBe('browser');
});

test('project models override defaults; summary defaults when omitted', () => {
  const dir = tmpProject({ ...minimal, models: { driver: 'd', vision: 'v' } });
  const cfg = loadConfig({ cwd: dir, env: key });
  expect(cfg.models.driver).toBe('d');
  expect(cfg.models.vision).toBe('v');
  expect(cfg.models.summary).toBe(DEFAULT_MODELS.summary);
});

test('project workspace overrides the default', () => {
  const cfg = loadConfig({ cwd: tmpProject({ ...minimal, workspace: './ws' }), env: key });
  expect(cfg.workspace).toBe('./ws');
});

test('provider resolves from env: key required, OpenRouter base url default', () => {
  const cfg = loadConfig({ cwd: tmpProject(minimal), env: key });
  expect(cfg.provider).toEqual({ apiKey: 'sk-test', baseUrl: OPENROUTER_BASE_URL });
});

test('env OPENAI_BASE_URL overrides the default base url', () => {
  const cfg = loadConfig({
    cwd: tmpProject(minimal),
    env: { ...key, OPENAI_BASE_URL: 'https://api.z.ai/v1' },
  });
  expect(cfg.provider.baseUrl).toBe('https://api.z.ai/v1');
});

test('blank OPENAI_BASE_URL falls back to the OpenRouter default', () => {
  const cfg = loadConfig({ cwd: tmpProject(minimal), env: { ...key, OPENAI_BASE_URL: '   ' } });
  expect(cfg.provider.baseUrl).toBe(OPENROUTER_BASE_URL);
});

test('missing provider API key throws ConfigError', () => {
  expect(() => loadConfig({ cwd: tmpProject(minimal), env: {} })).toThrow(ConfigError);
  expect(() => loadConfig({ cwd: tmpProject(minimal), env: { OPENAI_API_KEY: '  ' } })).toThrow(
    ConfigError,
  );
});

// --- the boot-time provider credential contract: OPENAI_API_KEY then
// OPENROUTER_API_KEY, the same order the runtime provider resolves in.

test('neither provider env key set: ConfigError names both accepted keys, no value', () => {
  let caught: unknown;
  try {
    loadConfig({ cwd: tmpProject(minimal), env: {} });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;
  expect(message).toContain('OPENAI_API_KEY');
  expect(message).toContain('OPENROUTER_API_KEY');
  // No credential value can appear — none was given. Asserted by SHAPE, not by
  // a literal that was never in scope: a shape check can actually fail.
  expectNoCredentialShapedToken(message);
});

test('the missing-key ConfigError carries no credential value from the env', () => {
  // A credential-shaped value sits in an env var the resolver never reads, so
  // the missing-key path still throws — the message must not pick it up.
  let caught: unknown;
  try {
    loadConfig({
      cwd: tmpProject(minimal),
      env: { ANTHROPIC_API_KEY: CREDENTIAL_SENTINEL },
    });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  expectNoCredentialShapedToken((caught as ConfigError).message);
});

test('OPENAI_API_KEY alone: the config provider resolves that key', () => {
  const cfg = loadConfig({
    cwd: tmpProject(minimal),
    env: { OPENAI_API_KEY: 'sk-openai' },
  });
  expect(cfg.provider.apiKey.length).toBe('sk-openai'.length);
  expect(cfg.provider.apiKey === 'sk-openai').toBe(true);
  expect(cfg.provider.baseUrl).toBe(OPENROUTER_BASE_URL);
});

test('OPENROUTER_API_KEY alone: the config provider resolves that key', () => {
  const cfg = loadConfig({
    cwd: tmpProject(minimal),
    env: { OPENROUTER_API_KEY: 'sk-openrouter' },
  });
  expect(cfg.provider.apiKey.length).toBe('sk-openrouter'.length);
  expect(cfg.provider.apiKey === 'sk-openrouter').toBe(true);
  expect(cfg.provider.baseUrl).toBe(OPENROUTER_BASE_URL);
});

test('both provider env keys set: OPENAI_API_KEY wins', () => {
  const cfg = loadConfig({
    cwd: tmpProject(minimal),
    env: { OPENAI_API_KEY: 'sk-openai', OPENROUTER_API_KEY: 'sk-openrouter' },
  });
  expect(cfg.provider.apiKey.length).toBe('sk-openai'.length);
  expect(cfg.provider.apiKey === 'sk-openai').toBe(true);
});

test('a blank OPENAI_API_KEY falls through to OPENROUTER_API_KEY', () => {
  const cfg = loadConfig({
    cwd: tmpProject(minimal),
    env: { OPENAI_API_KEY: '   ', OPENROUTER_API_KEY: 'sk-openrouter' },
  });
  expect(cfg.provider.apiKey.length).toBe('sk-openrouter'.length);
  expect(cfg.provider.apiKey === 'sk-openrouter').toBe(true);
});

test('a missing provider key errors without naming an unsupported env key', () => {
  let caught: unknown;
  try {
    loadConfig({ cwd: tmpProject(minimal), env: { OPENAI_API_KEY: '  ' } });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;
  expect(message).toContain('OPENAI_API_KEY');
  expect(message).toContain('OPENROUTER_API_KEY');
  expect(message).not.toContain('ANTHROPIC_API_KEY');
});

test('the missing-key ConfigError states the env precedence the resolver applies', () => {
  let caught: unknown;
  try {
    loadConfig({ cwd: tmpProject(minimal), env: {} });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;
  // The accepted keys appear in RESOLUTION order — OPENAI_API_KEY first.
  expect(message.indexOf('OPENAI_API_KEY')).toBeLessThan(message.indexOf('OPENROUTER_API_KEY'));
  // The tie-break is stated explicitly and names the winning key.
  expect(message).toContain('OPENAI_API_KEY wins if both are set');
});

test('the boot ConfigError and the runtime ProviderError guidance agree', () => {
  let caught: unknown;
  try {
    loadConfig({ cwd: tmpProject(minimal), env: {} });
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(ConfigError);
  const message = (caught as ConfigError).message;
  // Same accepted keys AND the same precedence statement on both sides.
  for (const name of PROVIDER_API_KEY_ENV_VARS) {
    expect(message).toContain(name);
    expect(providerApiKeyGuidance()).toContain(name);
  }
  expect(message).toContain('OPENAI_API_KEY wins if both are set');
  expect(providerApiKeyGuidance()).toContain('OPENAI_API_KEY wins if both are set');
});

test('missing config file throws ConfigError', () => {
  expect(() => loadConfig({ cwd: tmpProject(), env: key })).toThrow(ConfigError);
});

test('invalid JSON throws ConfigError', () => {
  expect(() => loadConfig({ cwd: tmpProject('{ not json'), env: key })).toThrow(ConfigError);
});

test('schema-invalid config throws ConfigError', () => {
  const bad = { targets: { web: { adapter: 'browser', url: 'not-a-url', headless: true } } };
  expect(() => loadConfig({ cwd: tmpProject(bad), env: key })).toThrow(ConfigError);
});

test('loadWorkspaceDir falls back to the default only when the config file is absent', () => {
  expect(loadWorkspaceDir(tmpProject())).toBe(DEFAULT_WORKSPACE);
  expect(loadWorkspaceDir(tmpProject({ ...minimal, workspace: './ws' }))).toBe('./ws');
});

test('loadWorkspaceDir surfaces ConfigError on an invalid config (no silent default)', () => {
  expect(() => loadWorkspaceDir(tmpProject('{ not json'))).toThrow(ConfigError);
  const bad = { targets: { web: { adapter: 'browser', url: 'not-a-url', headless: true } } };
  expect(() => loadWorkspaceDir(tmpProject(bad))).toThrow(ConfigError);
});

// --- dual-candidate resolution: `.dz/ui-debugger/ui-debugger-mcp.json` first,
// root `.ui-debugger-mcp.json` as the legacy fallback.

test('resolveConfigPath prefers an existing .dz/ copy over the root file', () => {
  let dir = tmpProject();
  writeCandidate(dir, DZ_CANDIDATE, minimal);
  expect(resolveConfigPath(dir)).toBe(join(dir, DZ_CANDIDATE));

  dir = tmpProject(minimal); // only the root copy exists
  expect(resolveConfigPath(dir)).toBe(join(dir, CONFIG_FILENAME));
});

test('resolveConfigPath targets .dz/ for a fresh config when a .dz/ dir exists', () => {
  // No config anywhere yet: the write target follows the repo's `.dz/` convention.
  let dir = tmpProject();
  mkdirSync(join(dir, '.dz'), { recursive: true });
  expect(resolveConfigPath(dir)).toBe(join(dir, DZ_CANDIDATE));

  dir = tmpProject(); // no `.dz/` dir → the historical root filename
  expect(resolveConfigPath(dir)).toBe(join(dir, CONFIG_FILENAME));
});

test('loadConfig reads the .dz/ copy first — root values are ignored when both exist', () => {
  const dir = writeCandidate(tmpProject({ ...minimal, workspace: './ws-root' }), DZ_CANDIDATE, {
    ...minimal,
    workspace: './ws-dz',
  });
  const cfg = loadConfig({ cwd: dir, env: key });
  expect(cfg.workspace).toBe('./ws-dz');
});

test('a bad .dz/ copy errors without falling back to a valid root file', () => {
  const dir = writeCandidate(tmpProject(minimal), DZ_CANDIDATE, '{ not json');
  let caught: unknown;
  try {
    loadConfig({ cwd: dir, env: key });
  } catch (e) {
    caught = e;
  }
  // No catch = loadConfig succeeded = root was read. The error must name .dz/.
  expect(caught).toBeInstanceOf(ConfigError);
  expect((caught as ConfigError).message).toContain(DZ_CANDIDATE);
});

test('loadWorkspaceDir prefers the .dz/ copy and errors on a bad one (no silent root read)', () => {
  const dir = writeCandidate(tmpProject({ ...minimal, workspace: './ws-root' }), DZ_CANDIDATE, {
    ...minimal,
    workspace: './ws-dz',
  });
  expect(loadWorkspaceDir(dir)).toBe('./ws-dz');

  const bad = writeCandidate(tmpProject(minimal), DZ_CANDIDATE, '{ not json');
  expect(() => loadWorkspaceDir(bad)).toThrow(ConfigError);
});

test('ignoredRootConfig names the shadowed root file only when both candidates exist', () => {
  expect(ignoredRootConfig(writeCandidate(tmpProject(minimal), DZ_CANDIDATE, minimal))).toBe(
    CONFIG_FILENAME,
  );
  expect(ignoredRootConfig(tmpProject(minimal))).toBeNull();
  expect(ignoredRootConfig(writeCandidate(tmpProject(), DZ_CANDIDATE, minimal))).toBeNull();
});
