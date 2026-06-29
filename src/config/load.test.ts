import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError } from '../errors.js';
import {
  CONFIG_FILENAME,
  DEFAULT_MODELS,
  DEFAULT_WORKSPACE,
  loadConfig,
  loadWorkspaceDir,
  OPENROUTER_BASE_URL,
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
