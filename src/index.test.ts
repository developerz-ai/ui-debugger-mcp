import { expect, test } from 'bun:test';
import { NAME, VERSION } from './index.js';

test('exposes a stable package name', () => {
  expect(NAME).toBe('ui-debugger-mcp');
});

test('exposes a semver version', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test('VERSION matches package.json', async () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = await import(pkgPath.href, { with: { type: 'json' } });
  expect(VERSION).toBe(pkg.default.version);
});
