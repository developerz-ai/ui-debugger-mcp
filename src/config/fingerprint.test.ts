import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configFingerprint, makeConfigWatch } from './fingerprint.js';
import { CONFIG_FILENAME } from './load.js';

const dirs: string[] = [];

function project(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'uidbg-fingerprint-'));
  dirs.push(dir);
  if (contents !== undefined) writeFileSync(join(dir, CONFIG_FILENAME), contents);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
});

// The published bin runs under Node (`#!/usr/bin/env node`), where `Bun` is
// undefined. Hashing with `Bun.hash` threw straight into the catch, so every
// installed copy fingerprinted `null` and drift detection silently did nothing.
test('fingerprints an existing config with a runtime-agnostic hash', () => {
  const fp = configFingerprint(project('{"targets":{}}'));
  expect(fp).toMatch(/^[0-9a-f]{64}$/);
});

test('a missing config fingerprints as null — nothing to drift from', () => {
  expect(configFingerprint(project())).toBeNull();
});

test('an unreadable config throws instead of masquerading as absent', () => {
  const dir = project('{"targets":{}}');
  chmodSync(join(dir, CONFIG_FILENAME), 0o000);
  // Root ignores the mode bits; only assert where the permission actually bites.
  if (process.getuid?.() === 0) return;
  expect(() => configFingerprint(dir)).toThrow();
});

test('identical contents fingerprint identically; a change is detected', () => {
  const dir = project('{"targets":{}}');
  const changed = makeConfigWatch(dir);
  expect(changed()).toBe(false);

  writeFileSync(join(dir, CONFIG_FILENAME), '{"targets":{"web":{"adapter":"browser"}}}');
  expect(changed()).toBe(true);
});

test('a config created after boot counts as drift', () => {
  const dir = project();
  const changed = makeConfigWatch(dir);
  expect(changed()).toBe(false);

  writeFileSync(join(dir, CONFIG_FILENAME), '{"targets":{}}');
  expect(changed()).toBe(true);
});
