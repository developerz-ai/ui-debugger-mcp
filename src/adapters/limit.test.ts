import { expect, test } from 'bun:test';
import { AdapterError } from '../errors.js';
import { capToLimit } from './limit.js';

const rows = ['a', 'b', 'c'];

test('capToLimit returns everything when no limit is given', () => {
  expect(capToLimit(rows)).toEqual(rows);
});

test('capToLimit caps at the limit, keeping order', () => {
  expect(capToLimit(rows, 2)).toEqual(['a', 'b']);
  expect(capToLimit(rows, 0)).toEqual([]);
  expect(capToLimit(rows, 99)).toEqual(rows);
});

test('capToLimit rejects a negative limit instead of silently dropping the tail', () => {
  // `slice(0, -1)` would return ['a','b'] — a quietly truncated read.
  expect(() => capToLimit(rows, -1)).toThrow(AdapterError);
  expect(() => capToLimit(rows, -1)).toThrow(/non-negative integer/);
});

test('capToLimit rejects NaN/Infinity instead of returning an empty read', () => {
  expect(() => capToLimit(rows, Number.NaN)).toThrow(AdapterError);
  expect(() => capToLimit(rows, Number.POSITIVE_INFINITY)).toThrow(AdapterError);
});

test('capToLimit rejects a fractional limit', () => {
  expect(() => capToLimit(rows, 1.5)).toThrow(AdapterError);
});
