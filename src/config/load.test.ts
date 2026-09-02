import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

test('missing OPENAI_API_KEY throws ConfigError', () => {
  expect(() => loadConfig({ cwd: tmpProject(minimal), env: {} })).toThrow(ConfigError);
  expect(() => loadConfig({ cwd: tmpProject(minimal), env: { OPENAI_API_KEY: '  ' } })).toThrow(
    ConfigError,
  );
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
