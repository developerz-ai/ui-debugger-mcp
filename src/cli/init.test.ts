import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigSchema } from '../config/schema.js';
import { runInit } from './init.js';

const TMP = join(import.meta.dir, '__test_init_tmp__');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test('creates workspace dir', () => {
  runInit(TMP);
  expect(existsSync(join(TMP, 'tmp', 'ui-debugger-mcp'))).toBe(true);
});

test('writes .ui-debugger-mcp.json when absent', () => {
  runInit(TMP);
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  expect(existsSync(configPath)).toBe(true);
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(parsed).toHaveProperty('models');
  expect(parsed).toHaveProperty('targets.web');
  expect(parsed.targets.web.adapter).toBe('browser');
});

test('the starter config validates against ConfigSchema', () => {
  runInit(TMP);
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(ConfigSchema.safeParse(parsed).success).toBe(true);
});

test('does not overwrite existing .ui-debugger-mcp.json', () => {
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  const original = '{"custom":true}\n';
  writeFileSync(configPath, original, 'utf8');
  runInit(TMP);
  expect(readFileSync(configPath, 'utf8')).toBe(original);
});

test('adds tmp/ to .gitignore when absent', () => {
  runInit(TMP);
  const content = readFileSync(join(TMP, '.gitignore'), 'utf8');
  expect(content).toContain('tmp/');
});

test('does not duplicate tmp/ in existing .gitignore', () => {
  const gitignorePath = join(TMP, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\ntmp/\n', 'utf8');
  runInit(TMP);
  const content = readFileSync(gitignorePath, 'utf8');
  const count = content.split('\n').filter((l) => l.trim() === 'tmp/').length;
  expect(count).toBe(1);
});

test('appends to existing .gitignore without clobbering', () => {
  const gitignorePath = join(TMP, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\n', 'utf8');
  runInit(TMP);
  const content = readFileSync(gitignorePath, 'utf8');
  expect(content).toContain('node_modules/');
  expect(content).toContain('tmp/');
});

test('is idempotent (second init is a no-op)', () => {
  runInit(TMP);
  const configBefore = readFileSync(join(TMP, '.ui-debugger-mcp.json'), 'utf8');
  const gitignoreBefore = readFileSync(join(TMP, '.gitignore'), 'utf8');
  runInit(TMP);
  expect(readFileSync(join(TMP, '.ui-debugger-mcp.json'), 'utf8')).toBe(configBefore);
  expect(readFileSync(join(TMP, '.gitignore'), 'utf8')).toBe(gitignoreBefore);
});

test('respects an existing config workspace for mkdir instead of the tmp/ default', () => {
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  writeFileSync(configPath, JSON.stringify({ workspace: './custom-ws', targets: {} }), 'utf8');
  runInit(TMP);
  expect(existsSync(join(TMP, 'custom-ws'))).toBe(true);
  expect(existsSync(join(TMP, 'tmp', 'ui-debugger-mcp'))).toBe(false);
});

test('respects an existing config workspace for gitignore instead of tmp/', () => {
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  writeFileSync(configPath, JSON.stringify({ workspace: './custom-ws', targets: {} }), 'utf8');
  runInit(TMP);
  const content = readFileSync(join(TMP, '.gitignore'), 'utf8');
  expect(content).toContain('custom-ws/');
});

test('does not write .mcp.json or any API key to disk (snippet is stdout-only)', () => {
  runInit(TMP);
  // The .mcp.json snippet is only printed, never written.
  expect(existsSync(join(TMP, '.mcp.json'))).toBe(false);
  // The project config written to disk contains no API key or secret.
  const config = readFileSync(join(TMP, '.ui-debugger-mcp.json'), 'utf8');
  expect(config).not.toContain('OPENAI_API_KEY');
  expect(config).not.toContain('sk-');
  // Placeholder in the snippet must remain a placeholder, not a real value.
  expect(config).not.toContain('<your-key-here>');
});
