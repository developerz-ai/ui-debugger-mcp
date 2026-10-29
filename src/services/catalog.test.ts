/**
 * The catalog projection — the public shape of a configured target.
 *
 * `describe` reports what a project can be pointed at: the adapter kind, whether
 * this server LAUNCHES the target or ATTACHES to a running one, whether that
 * kind is usable on THIS host, and — for the web — where to point the driver.
 *
 * Two rules the projection must never break:
 *   - it reports FACTS, never secrets: the auth personas are discoverable by
 *     NAME, the credentials behind them are not;
 *   - it reports absence as an ABSENT KEY, not an empty value, so a caller can
 *     tell "this target has no notes" from "the notes are empty".
 *
 * The service-level view of the same catalog (on a live run) is covered in
 * `debug-service.describe.test.ts`.
 */

import { expect, test } from 'bun:test';
import type { Target } from '../config/schema.js';
import { TargetNotFoundError } from '../errors.js';
import { describeTarget, isAttach, selectTargets } from './catalog.js';

const WEB: Target = { adapter: 'browser', url: 'http://localhost:3000', headless: true };
const WEB_ATTACH: Target = { adapter: 'browser', cdpUrl: 'http://127.0.0.1:9222', headless: true };
const DESKTOP: Target = { adapter: 'desktop', launch: 'myapp' };
const ANDROID_MANAGED: Target = { adapter: 'android', avd: 'pixel', headless: true };
const ANDROID_ATTACH: Target = { adapter: 'android', adbSerial: 'emulator-5554', headless: true };
const WEB_WITH_AUTH: Target = {
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  auth: {
    admin: {
      path: '/login',
      fields: { email: 'a@dev.local', password: 'hunter2' },
      submit: 'Sign in',
    },
    user: {
      path: '/login',
      fields: { email: 'u@dev.local', password: 'u' },
      submit: 'Sign in',
    },
  },
};
const WEB_WITH_EMPTY_AUTH: Target = {
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  auth: {},
};

const CATALOG: Record<string, Target> = {
  web: WEB,
  screen: DESKTOP,
  phone: ANDROID_ATTACH,
};

// --- managed vs attach --------------------------------------------------------

test('isAttach: a browser with a cdpUrl attaches, without one it is managed', () => {
  expect(isAttach(WEB_ATTACH)).toBe(true);
  expect(isAttach(WEB)).toBe(false);
  // `null` means "no handle" (the schema's nullish cdpUrl) — not an attach.
  expect(isAttach({ adapter: 'browser', cdpUrl: null, headless: true })).toBe(false);
});

test('isAttach: an android target with a serial attaches, an avd-only one is managed', () => {
  expect(isAttach(ANDROID_ATTACH)).toBe(true);
  expect(isAttach(ANDROID_MANAGED)).toBe(false);
  expect(isAttach({ adapter: 'android', adbSerial: null, headless: true })).toBe(false);
});

test('isAttach: a desktop target is always managed (there is no attach handle)', () => {
  expect(isAttach(DESKTOP)).toBe(false);
});

// --- the projection -----------------------------------------------------------

test('describeTarget: a managed web target reports its url and headless flag', () => {
  expect(describeTarget('web', WEB, 'linux')).toEqual({
    name: 'web',
    adapter: 'browser',
    mode: 'managed',
    operational: true,
    url: 'http://localhost:3000',
    headless: true,
  });
});

test('describeTarget: a web target with a cdpUrl is an attach target', () => {
  const info = describeTarget('web', WEB_ATTACH, 'linux');

  expect(info.mode).toBe('attach');
  // An attached browser keeps its own page — this project declares no url.
  expect(info.url).toBeUndefined();
  expect(info.headless).toBe(true);
});

test('describeTarget: an android target attaches on a serial and is managed on an avd', () => {
  expect(describeTarget('phone', ANDROID_ATTACH, 'linux')).toEqual({
    name: 'phone',
    adapter: 'android',
    mode: 'attach',
    operational: true,
  });
  expect(describeTarget('phone', ANDROID_MANAGED, 'linux')).toEqual({
    name: 'phone',
    adapter: 'android',
    mode: 'managed',
    operational: true,
  });
});

test('describeTarget: a desktop target is managed and carries no web fields', () => {
  const info = describeTarget('screen', DESKTOP, 'linux');

  expect(info.mode).toBe('managed');
  // The web-only fields belong to the web adapter kind, not to every target.
  expect(info).not.toHaveProperty('url');
  expect(info).not.toHaveProperty('headless');
});

test('describeTarget: operational is DERIVED from the host platform, never hardcoded', () => {
  // Desktop is Linux tooling (X11/Wayland + AT-SPI); android ships on Linux +
  // macOS; the browser is cross-platform. The flag is evaluated against the
  // platform handed in, so a caller on macOS is told the truth about desktop.
  expect(describeTarget('screen', DESKTOP, 'linux').operational).toBe(true);
  expect(describeTarget('screen', DESKTOP, 'darwin').operational).toBe(false);
  expect(describeTarget('screen', DESKTOP, 'win32').operational).toBe(false);
  expect(describeTarget('phone', ANDROID_MANAGED, 'darwin').operational).toBe(true);
  expect(describeTarget('phone', ANDROID_MANAGED, 'win32').operational).toBe(false);
  expect(describeTarget('web', WEB, 'win32').operational).toBe(true);
});

test('describeTarget: an adapter kind this build does not wire is never operational', () => {
  // Off-schema on purpose: the config schema is a closed union, so this only
  // reaches the projection through a cast config (the factory refuses it).
  const unwired = { adapter: 'sensors' } as unknown as Target;

  const info = describeTarget('gadget', unwired, 'linux');

  expect(info.adapter as string).toBe('sensors');
  expect(info.operational).toBe(false);
});

// --- personas, notes, absent keys ---------------------------------------------

test('describeTarget: persona NAMES are discoverable, the credentials behind them are not', () => {
  // A caller must be able to pick a valid `as` without opening the config file —
  // and must never receive the credentials while doing it.
  const info = describeTarget('dashboard', WEB_WITH_AUTH, 'linux');

  expect(info.personas).toEqual(['admin', 'user']);
  const serialized = JSON.stringify(info);
  expect(serialized).not.toContain('hunter2');
  expect(serialized).not.toContain('a@dev.local');
});

test('describeTarget: nothing to report means NO KEY at all (absent, not empty)', () => {
  const plain = describeTarget('web', WEB, 'linux');

  expect(plain).not.toHaveProperty('personas');
  expect(plain).not.toHaveProperty('notes');
  // An empty `auth` map is still "no personas" — an empty array would read as
  // "this target HAS personas, but none are listed".
  expect(describeTarget('web', WEB_WITH_EMPTY_AUTH, 'linux')).not.toHaveProperty('personas');
});

test("describeTarget: a target's standing notes are reported verbatim", () => {
  const notes = 'needs seeded data — empty tables are expected on /new';
  const withNotes: Target = {
    adapter: 'browser',
    url: 'http://x.test',
    headless: true,
    notes,
  };

  expect(describeTarget('web', withNotes, 'linux').notes).toBe(notes);
});

// --- the catalog selection ----------------------------------------------------

test('selectTargets: without a name the whole catalog is projected', () => {
  const targets = selectTargets(CATALOG, undefined, 'linux');

  expect(targets).toHaveLength(3);
  expect(targets[0]?.name).toBe('web');
  expect(targets[1]?.name).toBe('screen');
  expect(targets[2]?.name).toBe('phone');
  // The web target is launched, the phone is attached to a running device.
  expect(targets[0]?.mode).toBe('managed');
  expect(targets[1]?.mode).toBe('managed');
  expect(targets[2]?.mode).toBe('attach');
});

test('selectTargets: a name narrows the catalog to that one target', () => {
  const targets = selectTargets(CATALOG, 'screen', 'linux');

  expect(targets).toHaveLength(1);
  expect(targets[0]?.name).toBe('screen');
});

test('selectTargets: an unknown name fails loud instead of returning nothing', () => {
  // An empty catalog would read as "this project has no targets" — the caller
  // must be told the NAME it got wrong.
  expect(() => selectTargets(CATALOG, 'nope', 'linux')).toThrow(TargetNotFoundError);
  expect(() => selectTargets(CATALOG, 'nope', 'linux')).toThrow(
    "target 'nope' not found in config.targets",
  );
});

test('selectTargets: an empty catalog projects an empty list', () => {
  expect(selectTargets({}, undefined, 'linux')).toEqual([]);
});
