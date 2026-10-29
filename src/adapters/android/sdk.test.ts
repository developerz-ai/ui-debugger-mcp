/**
 * Unit tests for emulator binary resolution (`sdk.ts`).
 *
 * Hermetic about the host: every case injects its own seams, so no test reads
 * `process.env` or depends on an SDK (or its absence) on the machine running
 * the suite. One test builds throwaway files in a tmp dir to pin the real
 * eligibility predicate (`realEmulatorSeams`).
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type EmulatorSeams, realEmulatorSeams, resolveEmulatorBin } from './sdk.js';

/** Seams fake: only `executable` paths pass eligibility; every probe is recorded. */
function seamsWith(opts: {
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
  platform?: NodeJS.Platform;
  /** Paths eligible for auto-detection: regular files this process may execute. */
  executable?: readonly string[];
}): EmulatorSeams & { probes: string[] } {
  const executable = new Set(opts.executable ?? []);
  const probes: string[] = [];
  return {
    env: opts.env ?? {},
    isExecutableFile: (path) => {
      probes.push(path);
      return executable.has(path);
    },
    home: opts.home ?? '/home/tester',
    platform: opts.platform ?? 'linux',
    probes,
  };
}

describe('resolveEmulatorBin — explicit config wins', () => {
  test('a configured emulatorPath is used verbatim, probing nothing', () => {
    const seams = seamsWith({ executable: [] });
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
      executable: ['/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin('', seams).origin).toBe('sdk');
    expect(resolveEmulatorBin(null, seams).origin).toBe('sdk');
    expect(resolveEmulatorBin(undefined, seams).origin).toBe('sdk');
  });

  test('a whitespace-only emulatorPath counts as unset too', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk' },
      executable: ['/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin('   ', seams).origin).toBe('sdk');
  });
});

describe('resolveEmulatorBin — SDK detection', () => {
  test('finds the emulator under $ANDROID_HOME with no PATH in play at all', () => {
    // Deliberately no `PATH` key: an SDK hit must never lean on PATH.
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk' },
      executable: ['/sdk/emulator/emulator'],
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
      executable: ['/other/sdk/emulator/emulator'],
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
      executable: ['/home/sdk/emulator/emulator', '/other/sdk/emulator/emulator'],
    });
    const resolved = resolveEmulatorBin(null, seams);
    expect(resolved.where).toBe('$ANDROID_HOME');
    expect(resolved.bin).toBe('/home/sdk/emulator/emulator');
    // Stops at the first hit — the lower-priority candidate is never probed.
    expect(seams.probes).toEqual(['/home/sdk/emulator/emulator']);
  });

  test('finds the Linux SDK layout under the home seam', () => {
    const seams = seamsWith({ executable: ['/home/tester/Android/Sdk/emulator/emulator'] });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/home/tester/Android/Sdk/emulator/emulator',
      origin: 'sdk',
      where: '~/Android/Sdk',
    });
  });

  test('finds the macOS SDK layout under ~/Library/Android/sdk', () => {
    const seams = seamsWith({
      home: '/Users/tester',
      executable: ['/Users/tester/Library/Android/sdk/emulator/emulator'],
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
      executable: ['/opt/tools/emulator'],
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
      executable: ['D:\\Bin\\emulator.exe'],
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
      executable: ['C:\\Android\\emulator\\emulator.exe'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: 'C:\\Android\\emulator\\emulator.exe',
      origin: 'sdk',
      where: '$ANDROID_HOME',
    });
  });
});

describe('resolveEmulatorBin — executable-file eligibility', () => {
  test('a non-executable PATH hit falls through to an executable one behind it', () => {
    // The reported scenario: PATH=/a:/b — existence alone would accept the
    // non-executable /a/emulator and mask the runnable /b/emulator behind it.
    const seams = seamsWith({
      env: { PATH: '/a:/b' },
      executable: ['/b/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/b/emulator',
      origin: 'path',
      where: 'PATH',
    });
    // The rejected candidate was probed first, then skipped — not fatal. The
    // home SDK layouts ran ahead of PATH as always.
    expect(seams.probes).toEqual([
      '/home/tester/Android/Sdk/emulator/emulator',
      '/home/tester/Library/Android/sdk/emulator/emulator',
      '/a/emulator',
      '/b/emulator',
    ]);
  });

  test('a non-executable SDK candidate falls through to PATH', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk', PATH: '/usr/bin' },
      executable: ['/usr/bin/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/usr/bin/emulator',
      origin: 'path',
      where: 'PATH',
    });
    expect(seams.probes[0]).toBe('/sdk/emulator/emulator');
  });

  test('a non-executable SDK candidate falls through to a lower SDK source', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/home/sdk', ANDROID_SDK_ROOT: '/other/sdk' },
      executable: ['/other/sdk/emulator/emulator'],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '/other/sdk/emulator/emulator',
      origin: 'sdk',
      where: '$ANDROID_SDK_ROOT',
    });
    expect(seams.probes).toEqual(['/home/sdk/emulator/emulator', '/other/sdk/emulator/emulator']);
  });

  test('rejected non-executable candidates are still reported as searched', () => {
    const seams = seamsWith({
      env: { ANDROID_HOME: '/sdk', PATH: '/a:/b' },
      executable: [],
    });
    expect(resolveEmulatorBin(null, seams)).toEqual({
      bin: '',
      origin: 'missing',
      where: 'not found',
      searched: [
        '$ANDROID_HOME/emulator/emulator',
        '$ANDROID_SDK_ROOT/emulator/emulator',
        '~/Android/Sdk/emulator/emulator',
        '~/Library/Android/sdk/emulator/emulator',
        '/a/emulator',
        '/b/emulator',
      ],
    });
    expect(seams.probes).toEqual([
      '/sdk/emulator/emulator',
      '/home/tester/Android/Sdk/emulator/emulator',
      '/home/tester/Library/Android/sdk/emulator/emulator',
      '/a/emulator',
      '/b/emulator',
    ]);
  });
});

describe('realEmulatorSeams', () => {
  test('wires the real environment and host — without touching the filesystem', () => {
    const seams = realEmulatorSeams(); // `isExecutableFile` is never called here
    expect(seams.env).toBe(process.env);
    expect(seams.platform).toBe(process.platform);
    expect(typeof seams.home).toBe('string');
    expect(typeof seams.isExecutableFile).toBe('function');
  });

  test('isExecutableFile: an executable regular file passes, everything else fails', () => {
    // The only real-fs test here, and self-contained: throwaway files in a
    // tmp dir, so no host env, SDK or PATH state can skew the result.
    const dir = mkdtempSync(join(tmpdir(), 'sdk-elig-'));
    afterAll(() => rmSync(dir, { recursive: true, force: true }));
    const isExecutableFile = realEmulatorSeams().isExecutableFile;

    const bin = join(dir, 'runnable');
    writeFileSync(bin, '#!/bin/sh\n');
    chmodSync(bin, 0o755);
    expect(isExecutableFile(bin)).toBe(true);

    if (process.platform !== 'win32') {
      // No exec bit → ineligible; on Windows `X_OK` degrades to existence and
      // chmod has no exec bit, so this half is unix-only.
      const plain = join(dir, 'plain');
      writeFileSync(plain, 'data');
      chmodSync(plain, 0o644);
      expect(isExecutableFile(plain)).toBe(false);
    }

    // A directory passes `X_OK` on its own — the file check must reject it.
    mkdirSync(join(dir, 'emulator'));
    expect(isExecutableFile(join(dir, 'emulator'))).toBe(false);
    expect(isExecutableFile(join(dir, 'nope'))).toBe(false);
  });
});
