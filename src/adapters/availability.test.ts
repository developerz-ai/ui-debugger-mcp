/**
 * The availability rule — pure lookups, nothing launched.
 *
 * `operational` is a DERIVED fact: the adapter kind is wired in this build AND
 * the host platform supports it. No adapter, browser, emulator or device is
 * touched here — the rule is two table reads.
 */

import { expect, test } from 'bun:test';
import { isAdapterOperational } from './availability.js';

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
