/**
 * `log-filters.ts` — the whitelisted console/network `filters`. Every unknown key
 * or wrong value type must fail loud (never a silent ignore), so both paths are
 * asserted here.
 */

import { expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { ConsoleEntry, NetworkEntry } from '../contract.js';
import { filterConsole, filterNetwork } from './log-filters.js';

// --- filterConsole ----------------------------------------------------------

const c = (over: Partial<ConsoleEntry>): ConsoleEntry => ({
  level: 'log',
  text: '',
  timestamp: 0,
  ...over,
});

test('filterConsole returns all when no filters', () => {
  const entries = [c({ text: 'a' }), c({ text: 'b' })];
  expect(filterConsole(entries)).toEqual(entries);
});

test('filterConsole narrows by level_eq', () => {
  const entries = [c({ level: 'error', text: 'a' }), c({ level: 'log', text: 'b' })];
  expect(filterConsole(entries, { level_eq: 'error' }).map((e) => e.text)).toEqual(['a']);
});

test('filterConsole narrows by level_in', () => {
  const entries = [c({ level: 'error' }), c({ level: 'warn' }), c({ level: 'log' })];
  expect(filterConsole(entries, { level_in: ['error', 'warn'] }).map((e) => e.level)).toEqual([
    'error',
    'warn',
  ]);
});

test('filterConsole narrows by text_contains (case-insensitive)', () => {
  const entries = [c({ text: 'TypeError: x' }), c({ text: 'ok' })];
  expect(filterConsole(entries, { text_contains: 'typeerror' }).map((e) => e.text)).toEqual([
    'TypeError: x',
  ]);
});

test('filterConsole throws on unknown key', () => {
  expect(() => filterConsole([c({})], { bogus_eq: true })).toThrow(AdapterError);
});

test('filterConsole throws on wrong value type', () => {
  expect(() => filterConsole([c({})], { level_in: 'error' })).toThrow(AdapterError);
  expect(() => filterConsole([c({})], { level_eq: 5 })).toThrow(AdapterError);
});

// --- filterNetwork ----------------------------------------------------------

const n = (over: Partial<NetworkEntry>): NetworkEntry => ({
  method: 'GET',
  url: '',
  status: 200,
  ok: true,
  timestamp: 0,
  ...over,
});

test('filterNetwork narrows by status_gte', () => {
  const entries = [n({ status: 200 }), n({ status: 404 }), n({ status: 500 })];
  expect(filterNetwork(entries, { status_gte: 400 }).map((e) => e.status)).toEqual([404, 500]);
});

test('filterNetwork narrows by status_lt and status_eq', () => {
  const entries = [n({ status: 200 }), n({ status: 301 }), n({ status: 500 })];
  expect(filterNetwork(entries, { status_lt: 400 }).map((e) => e.status)).toEqual([200, 301]);
  expect(filterNetwork(entries, { status_eq: 301 }).map((e) => e.status)).toEqual([301]);
});

test('filterNetwork narrows by ok_eq and failed_eq', () => {
  const entries = [n({ ok: true }), n({ ok: false }), n({ ok: false, error: 'net::ERR' })];
  expect(filterNetwork(entries, { ok_eq: false }).length).toBe(2);
  expect(filterNetwork(entries, { failed_eq: true }).map((e) => e.error)).toEqual(['net::ERR']);
});

test('filterNetwork narrows by method_eq (case-insensitive), resource_in, url_contains', () => {
  const entries = [
    n({ method: 'GET', url: 'http://x/api/users', resourceType: 'xhr' }),
    n({ method: 'POST', url: 'http://x/assets/logo.png', resourceType: 'image' }),
  ];
  expect(filterNetwork(entries, { method_eq: 'post' }).map((e) => e.url)).toEqual([
    'http://x/assets/logo.png',
  ]);
  expect(filterNetwork(entries, { resource_in: ['xhr', 'fetch'] }).map((e) => e.method)).toEqual([
    'GET',
  ]);
  expect(filterNetwork(entries, { url_contains: '/API/' }).map((e) => e.method)).toEqual(['GET']);
});

test('filterNetwork throws on unknown key and wrong value type', () => {
  expect(() => filterNetwork([n({})], { bogus: 1 })).toThrow(AdapterError);
  expect(() => filterNetwork([n({})], { status_gte: '400' })).toThrow(AdapterError);
  expect(() => filterNetwork([n({})], { ok_eq: 'no' })).toThrow(AdapterError);
});

test('filterNetwork narrows by duration_gte and body_contains', () => {
  const entries = [
    n({ url: 'fast', durationMs: 10 }),
    n({ url: 'slow', durationMs: 900 }),
    n({ url: 'untimed' }),
    n({ url: 'boom', responseBody: '{"error":"nope"}' }),
  ];
  expect(filterNetwork(entries, { duration_gte: 500 }).map((e) => e.url)).toEqual(['slow']);
  expect(filterNetwork(entries, { body_contains: 'ERROR' }).map((e) => e.url)).toEqual(['boom']);
});
