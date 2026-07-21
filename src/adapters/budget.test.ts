import { expect, test } from 'bun:test';
import { AdapterError } from '../errors.js';
import { capWait } from './budget.js';

test('no budget leaves the adapter default alone', () => {
  expect(capWait(30_000)).toBe(30_000);
  expect(capWait(30_000, undefined)).toBe(30_000);
});

test('a tighter budget shortens the wait; a looser one never extends it', () => {
  expect(capWait(30_000, 5_000)).toBe(5_000);
  expect(capWait(30_000, 300_000)).toBe(30_000);
});

test('a spent budget fails fast at 1ms — never 0, which means "no timeout" to Playwright', () => {
  expect(capWait(30_000, 0)).toBe(1);
});

test('a nonsense budget fails loud instead of becoming a wait that never expires', () => {
  expect(() => capWait(30_000, Number.NaN)).toThrow(AdapterError);
  expect(() => capWait(30_000, Number.POSITIVE_INFINITY)).toThrow(AdapterError);
  expect(() => capWait(30_000, -1)).toThrow(AdapterError);
});
