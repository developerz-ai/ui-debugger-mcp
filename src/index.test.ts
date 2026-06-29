import { expect, test } from 'bun:test';
import { NAME, VERSION } from './index.js';

test('exposes a stable package name', () => {
  expect(NAME).toBe('ui-debugger-mcp');
});

test('exposes a semver version', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
