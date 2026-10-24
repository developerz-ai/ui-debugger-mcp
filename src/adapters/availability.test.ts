/**
 * The availability rule — pure lookups, nothing launched.
 *
 * `operational` is a DERIVED fact: the adapter kind is wired in this build AND
 * the host platform supports it. No adapter, browser, emulator or device is
 * touched here — the rule is two table reads.
 */

import { expect, test } from 'bun:test';
import { TargetSchema } from '../config/schema.js';
import { isAdapterOperational, SUPPORTED_PLATFORMS } from './availability.js';
import { isAdapterWired } from './factory.js';

test('a wired kind on a platform it supports is operational', () => {
  expect(isAdapterOperational('browser', 'linux')).toBe(true);
  expect(isAdapterOperational('browser', 'darwin')).toBe(true);
  expect(isAdapterOperational('browser', 'win32')).toBe(true);
  expect(isAdapterOperational('desktop', 'linux')).toBe(true);
  expect(isAdapterOperational('android', 'linux')).toBe(true);
  expect(isAdapterOperational('android', 'darwin')).toBe(true);
});

test('a kind this build does not wire is not operational (and the lookup does not throw)', () => {
  expect(isAdapterOperational('sensors', 'linux')).toBe(false);
  expect(isAdapterOperational('', 'linux')).toBe(false);
  // A prototype-chain name is not a wired kind either.
  expect(isAdapterOperational('constructor', 'linux')).toBe(false);
  expect(isAdapterOperational('toString', 'linux')).toBe(false);
});

test('a wired kind on a platform it does not support is not operational', () => {
  // Desktop is Linux tooling (X11/Wayland + AT-SPI) — wired, but not on darwin.
  expect(isAdapterOperational('desktop', 'darwin')).toBe(false);
  expect(isAdapterOperational('desktop', 'win32')).toBe(false);
  expect(isAdapterOperational('android', 'win32')).toBe(false);
});

test('the default platform is the host platform, not a hardcoded one', () => {
  // Desktop is supported on linux only, so the default answer must track the
  // host — a rule that silently assumed linux would be wrong off linux.
  expect(isAdapterOperational('desktop')).toBe(process.platform === 'linux');
});

// --- the two halves of the rule ---------------------------------------------

/**
 * Every adapter kind the config schema can name — the closed union, read at
 * runtime from the discriminated union's own options.
 *
 * This is the universe of kinds the rule must answer for. `isAdapterWired`
 * filters it down to what THIS build wires.
 */
const SCHEMA_KINDS = TargetSchema.options.map((option) => option.shape.adapter.value);

/** The kinds this build wires. */
const WIRED_KINDS = SCHEMA_KINDS.filter((kind) => isAdapterWired(kind));

/** The same kinds, as plain strings — the shape the drift check compares. */
const WIRED_KIND_NAMES: string[] = WIRED_KINDS;

/**
 * Every `NodeJS.Platform` value — the union `@types/node` declares.
 *
 * Typed as `Record<NodeJS.Platform, true>`, the same idiom the factory uses
 * for its wired map: a platform missing here is a TYPE error, and a platform
 * that is not in the union is an excess-property error. The list therefore
 * cannot drift from the union it claims to enumerate.
 */
const PLATFORM_IDS: Record<NodeJS.Platform, true> = {
  aix: true,
  android: true,
  darwin: true,
  freebsd: true,
  haiku: true,
  linux: true,
  openbsd: true,
  sunos: true,
  win32: true,
  cygwin: true,
  netbsd: true,
};

/** The same ids, as the values the rule is called with. */
const ALL_PLATFORMS = Object.keys(PLATFORM_IDS) as NodeJS.Platform[];

/** The table's keys, as plain strings — the shape the drift check compares. */
const TABLE_KINDS: string[] = Object.keys(SUPPORTED_PLATFORMS);

test('the supported table covers exactly the wired adapter kinds', () => {
  // Drift in EITHER direction is a bug: a kind wired but with no row (the rule
  // could not answer for it) and a row for a kind this build does not wire
  // (the table describes a capability nothing implements).
  expect([...WIRED_KIND_NAMES].sort()).toEqual([...TABLE_KINDS].sort());
});

test('every row of the supported table belongs to a kind this build wires', () => {
  for (const kind of TABLE_KINDS) {
    expect(isAdapterWired(kind)).toBe(true);
  }
});

test('every wired kind has a row in the supported table', () => {
  for (const kind of WIRED_KINDS) {
    expect(SUPPORTED_PLATFORMS[kind]).toBeDefined();
  }
});

test('the platform ids in the table are real NodeJS.Platform values', () => {
  for (const kind of TABLE_KINDS as (keyof typeof SUPPORTED_PLATFORMS)[]) {
    for (const id of SUPPORTED_PLATFORMS[kind]) {
      expect(ALL_PLATFORMS).toContain(id);
    }
  }
});

test('the rule is total: every wired kind on every platform answers, and never throws', () => {
  for (const kind of WIRED_KINDS) {
    for (const platform of ALL_PLATFORMS) {
      expect(() => isAdapterOperational(kind, platform)).not.toThrow();
      expect(typeof isAdapterOperational(kind, platform)).toBe('boolean');
    }
  }
});

test('a wired kind whose row is missing answers false instead of throwing', () => {
  // `SUPPORTED_PLATFORMS` is TOTAL over the config-schema union, so the
  // missing-row case is a TYPE error — the comment at the table says so. This
  // test pins the runtime guard anyway: with the browser row taken out of the
  // exported table, the rule must answer `false` — not die on
  // `undefined.includes(...)`.
  //
  // The table is a module-level export, so the row is taken out and put back
  // in place — the whole table is rebuilt, key order included, so the module
  // is left exactly as it was found.
  const snapshot = Object.entries(SUPPORTED_PLATFORMS);
  Reflect.deleteProperty(SUPPORTED_PLATFORMS, 'browser');
  try {
    expect(isAdapterOperational('browser', 'linux')).toBe(false);
    expect(isAdapterOperational('browser', 'darwin')).toBe(false);
  } finally {
    for (const key of Object.keys(SUPPORTED_PLATFORMS)) {
      Reflect.deleteProperty(SUPPORTED_PLATFORMS, key);
    }
    for (const [key, row] of snapshot) {
      Object.defineProperty(SUPPORTED_PLATFORMS, key, {
        value: row,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  // The table is back, in its original order.
  expect(Object.keys(SUPPORTED_PLATFORMS)).toEqual(snapshot.map(([key]) => key));
  expect(SUPPORTED_PLATFORMS.browser).toEqual(['linux', 'darwin', 'win32']);
});
