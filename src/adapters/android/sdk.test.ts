/**
 * Unit tests for emulator binary resolution (`sdk.ts`).
 *
 * Fully hermetic: every case injects its own seams, so no test reads
 * `process.env`, probes the real filesystem, or depends on an SDK (or its
 * absence) on the machine running the suite.
 */

import { describe, expect, test } from 'bun:test';
import { type EmulatorSeams, realEmulatorSeams, resolveEmulatorBin } from './sdk.js';

/** Seams fake: only `existing` paths exist; every `exists` probe is recorded. */
function seamsWith(opts: {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: NodeJS.Platform;
  existing?: readonly string[];
}): EmulatorSeams & { probes: string[] } {
  const existing = new Set(opts.existing ?? []);
  const probes: string[] = [];
  return {
    env: opts.env ?? {},
    exists: (path) => {
      probes.push(path);
      return existing.has(path);
    },
    home: opts.home ?? '/home/tester',
    platform: opts.platform ?? 'linux',
    probes,
  };
}

describe('resolveEmulatorBin — explicit config wins', () => {
  test('a configured emulatorPath is used verbatim, probing nothing', () => {
    const seams = seamsWith({ existing: [] });
    expect(resolveEmulatorBin('/opt/sdk/emulator/emulator', seams)).toEqual({
      bin: '/opt/sdk/emulator/emulator',
      origin: 'config',
      where: 'configured emulatorPath',
    });
    // Precedence: zero env/fs access — not even one probe.
    expect(seams.probes).toEqual([]);
  });

  test('an empty-string emulatorPath counts as unset and detection runs', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk' },
      existing: ['/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin('', seams).origin).toBe('sdk');
    expect(resolveEmulatorBin(null, seams).origin).toBe('sdk');
    expect(resolveEmulatorBin(undefined, seams).origin).toBe('sdk');
  });

  test('a whitespace-only emulatorPath counts as unset too', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk' },
      existing: ['/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin('   ', seams).origin).toBe('sdk');
  });
});

describe('resolveEmulatorBin — SDK detection', () => {
  test('finds the emulator under $ANDROID_HOME with no PATH in play at all', () => {
    // Deliberately no `PATH` key: an SDK hit must never lean on PATH.
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk' },
      existing: ['/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/sdk/emulator/emulator',
      origin: 'sdk',
      where: '$ANDROID_HOME',
    });
    expect(seams.probes).toEqual(['/sdk/emulator/emulator']);
  });

  test('falls through to $ANDROID_SDK_ROOT when ANDROID_HOME is unset', () => {
    const seams = seamsWith({
      env: { ANDROID_SDK_ROOT: '/other/sdk' },
      existing: ['/other/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/other/sdk/emulator/emulator',
      origin: 'sdk',
      where: '$ANDROID_SDK_ROOT',
    });
    expect(seams.probes[0]).toBe('/other/sdk/emulator/emulator');
  });

  test('$ANDROID_HOME outranks $ANDROID_SDK_ROOT when both resolve', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/home/sdk', ANDROID_SDK_ROOT: '/other/sdk' },
      existing: ['/home/sdk/emulator/emulator', '/other/sdk/emulator/emulator'],
    });
    const resolved = resolveEmulatorBin(null, seams);
    expect(resolved.where).toBe('$ANDROID_HOME');
    expect(resolved.bin).toBe('/home/sdk/emulator/emulator');
    // Stops at the first hit — the lower-priority candidate is never probed.
    expect(seams.probes).toEqual(['/home/sdk/emulator/emulator']);
  });

  test('finds the Linux SDK layout under the home seam', () => {
    const seams = seamsWith({ existing: ['/home/tester/Android/Sdk/emulator/emulator'] });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/home/tester/Android/Sdk/emulator/emulator',
      origin: 'sdk',
      where: '~/Android/Sdk',
    });
  });

  test('finds the macOS SDK layout under ~/Library/Android/sdk', () => {
    const seams = seamsWith({
      home: '/Users/tester',
      existing: ['/Users/tester/Library/Android/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/Users/tester/Library/Android/sdk/emulator/emulator',
      origin: 'sdk',
      where: '~/Library/Android/sdk',
    });
  });
});

describe('resolveEmulatorBin — PATH fallback and missing', () => {
  test('a PATH entry is the fallback once every SDK candidate missed', () => {
    const seams = seamsWith({
      env: { PATH: '/usr/bin:/opt/tools' },
      existing: ['/opt/tools/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/opt/tools/emulator',
      origin: 'path',
      where: 'PATH',
    });
    // SDK layouts were probed before PATH — the fallback is a last resort.
    expect(seams.probes).toEqual([
      '/home/tester/Android/Sdk/emulator/emulator',
      '/home/tester/Library/Android/sdk/emulator/emulator',
      '/usr/bin/emulator',
      '/opt/tools/emulator',
    ]);
  });

  test('nothing anywhere → missing, with every searched location attached', () => {
    // A whitespace-only ANDROID_HOME is unset: still listed as searched, never probed.
    const seams = seamsWith({ env: { ANDROID_HOME: '   ' } });
    expect(resolveEmulatorBin(undefined, seams)).toEqual({
      bin: '',
      origin: 'missing',
      where: 'not found',
      searched: [
        '$ANDROID_HOME/emulator/emulator',
        '$ANDROID_SDK_ROOT/emulator/emulator',
        '~/Android/Sdk/emulator/emulator',
        '~/Library/Android/sdk/emulator/emulator',
      ],
    });
    expect(seams.probes).toEqual([
      '/home/tester/Android/Sdk/emulator/emulator',
      '/home/tester/Library/Android/sdk/emulator/emulator',
    ]);
  });

  test('a PATH sweep that finds nothing is reported in searched too', () => {
    // No SDK configured, no existing file anywhere: the PATH entries were
    // still probed, so `missing` must name them after the four SDK labels.
    const seams = seamsWith({ env: { PATH: '/usr/bin:/opt/tools' } });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '',
      origin: 'missing',
      where: 'not found',
      searched: [
        '$ANDROID_HOME/emulator/emulator',
        '$ANDROID_SDK_ROOT/emulator/emulator',
        '~/Android/Sdk/emulator/emulator',
        '~/Library/Android/sdk/emulator/emulator',
        '/usr/bin/emulator',
        '/opt/tools/emulator',
      ],
    });
    // Each searched PATH label is a location genuinely probed, in order.
    expect(seams.probes).toEqual([
      '/home/tester/Android/Sdk/emulator/emulator',
      '/home/tester/Library/Android/sdk/emulator/emulator',
      '/usr/bin/emulator',
      '/opt/tools/emulator',
    ]);
  });

  test('win32 looks for emulator.exe with Windows joins and PATH splits', () => {
    const seams = seamsWith({
      platform: 'win32',
      env: { PATH: 'C:\\Tools;D:\\Bin' },
      existing: ['D:\\Bin\\emulator.exe'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: 'D:\\Bin\\emulator.exe',
      origin: 'path',
      where: 'PATH',
    });
  });

  test('win32 SDK candidates carry the .exe suffix', () => {
    const seams = seamsWith({
      platform: 'win32',
      env: { ANDROID_HOME: 'C:\\Android' },
      existing: ['C:\\Android\\emulator\\emulator.exe'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: 'C:\\Android\\emulator\\emulator.exe',
      origin: 'sdk',
      where: '$ANDROID_HOME',
    });
  });
});

describe('realEmulatorSeams', () => {
  test('wires the real environment and host — without touching the filesystem', () => {
    const seams = realEmulatorSeams(); // `exists` is never called here: hermetic
    expect(seams.env).toBe(process.env);
    expect(seams.platform).toBe(process.platform);
    expect(typeof seams.home).toBe('string');
    expect(typeof seams.exists).toBe('function');
  });
});
