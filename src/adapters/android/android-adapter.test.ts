/**
 * Unit tests for the Android adapter's pure log parsers — parseLogcat, applyLogFilters.
 * No fake seams needed here (no device/emulator, no adapter instance).
 *
 * AndroidAdapter creation/boot/binding live in android-adapter.lifecycle.test.ts;
 * click/type/read/wait/console/network behaviors live in android-adapter.behavior.test.ts;
 * shared fakes (FakeAdb/FakeUi/makeAdapter/...) live in android-adapter.test-helpers.ts.
 * The pure argv builders live in `commands.test.ts` and the view-hierarchy reader
 * (parsers + `AdbUiAutomator`) in `uiautomator.test.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import { applyLogFilters, parseLogcat } from './android-adapter.js';

describe('parseLogcat', () => {
  const LOGCAT_LINE = '1546300800.000  1000  1001 I ActivityManager: Starting process';
  const WARN_LINE = '1546300801.500  1000  1001 W MyTag: low memory';
  const ERR_LINE = '1546300802.100  1000  1001 E CrashHandler: ANR detected';
  const DEBUG_LINE = '1546300803.000  1000  1001 D Debug: verbose output';
  const VERBOSE_LINE = '1546300804.000  1000  1001 V Verbose: very verbose';

  test('parses a single info line', () => {
    const entries = parseLogcat(LOGCAT_LINE);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('info');
    expect(entries[0]?.text).toBe('Starting process');
    expect(entries[0]?.location).toBe('ActivityManager');
    expect(entries[0]?.timestamp).toBe(1546300800000);
  });
  test('maps W → warn', () => {
    expect(parseLogcat(WARN_LINE)[0]?.level).toBe('warn');
  });
  test('maps E → error', () => {
    expect(parseLogcat(ERR_LINE)[0]?.level).toBe('error');
  });
  test('maps D → debug', () => {
    expect(parseLogcat(DEBUG_LINE)[0]?.level).toBe('debug');
  });
  test('maps V → log', () => {
    expect(parseLogcat(VERBOSE_LINE)[0]?.level).toBe('log');
  });
  test('skips non-matching lines (header/empty)', () => {
    const raw = `--------- beginning of main\n${LOGCAT_LINE}`;
    expect(parseLogcat(raw)).toHaveLength(1);
  });
  test('parses multi-line output', () => {
    const raw = `${LOGCAT_LINE}\n${WARN_LINE}\n${ERR_LINE}`;
    expect(parseLogcat(raw)).toHaveLength(3);
  });
  test('empty string → empty array', () => {
    expect(parseLogcat('')).toHaveLength(0);
  });
});

describe('applyLogFilters', () => {
  const entries = [
    { level: 'info' as const, text: 'started', location: 'App', timestamp: 1000 },
    { level: 'error' as const, text: 'crash occurred', location: 'Crash', timestamp: 2000 },
    { level: 'warn' as const, text: 'low memory', location: 'Memory', timestamp: 3000 },
  ];

  test('no filters → returns all', () => {
    expect(applyLogFilters(entries)).toHaveLength(3);
  });
  test('level_eq filters to one level', () => {
    const result = applyLogFilters(entries, { level_eq: 'error' });
    expect(result).toHaveLength(1);
    expect(result[0]?.level).toBe('error');
  });
  test('level_in filters to multiple levels', () => {
    const result = applyLogFilters(entries, { level_in: ['error', 'warn'] });
    expect(result).toHaveLength(2);
  });
  test('text_contains filters case-insensitively', () => {
    const result = applyLogFilters(entries, { text_contains: 'CRASH' });
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe('crash occurred');
  });
  test('throws on unknown filter key', () => {
    expect(() => applyLogFilters(entries, { unknown: 'x' })).toThrow(AdapterError);
  });
  test('throws when level_eq gets wrong type', () => {
    expect(() => applyLogFilters(entries, { level_eq: 123 })).toThrow(AdapterError);
  });
  test('throws when level_in gets wrong type', () => {
    expect(() => applyLogFilters(entries, { level_in: 'error' })).toThrow(AdapterError);
  });
});
