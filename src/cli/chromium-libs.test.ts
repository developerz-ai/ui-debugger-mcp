import { expect, test } from 'bun:test';
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ChromiumLibsMissingError } from '../errors.js';
import {
  checkChromiumLibs,
  formatMissingLibsMessage,
  INSTALL_DEPS_COMMAND,
  locateHeadlessShell,
  MISSING_LIBS_MARKER,
  parseMissingLibs,
  probeElevation,
  readPinnedHeadlessShellRevision,
  remediationPlan,
  runInstaller,
  runLdd,
} from './chromium-libs.js';

const TMP = join(import.meta.dir, '__test_chromium_libs_tmp__');

/** `ldd` output with two unresolved libraries. */
const LDD_WITH_MISSING = [
  '\tlinux-vdso.so.1 (0x00007ffdf81e0000)',
  '\tlibdl.so.2 => /lib/x86_64-linux-gnu/libdl.so.2 (0x000074a158180000)',
  '\tlibX.so => not found',
  '\tlibnss3.so => /lib/x86_64-linux-gnu/libnss3.so (0x000074a158c749000)',
  '\tlibgbm.so.1 => not found',
].join('\n');

/** `ldd` output where everything resolves. */
const LDD_CLEAN = [
  '\tlinux-vdso.so.1 (0x00007ffdf81e0000)',
  '\tlibX11.so.6 => /lib/x86_64-linux-gnu/libX11.so.6 (0x000074a158c26b000)',
  '\tlibnss3.so => /lib/x86_64-linux-gnu/libnss3.so (0x000074a158c749000)',
].join('\n');

const BINARY =
  '/cache/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell';

// --- pure helpers -------------------------------------------------------

test('parseMissingLibs: reads the library name left of "=> not found"', () => {
  expect(parseMissingLibs(LDD_WITH_MISSING)).toEqual(['libX.so', 'libgbm.so.1']);
});

test('parseMissingLibs: a fully resolved ldd output yields nothing missing', () => {
  expect(parseMissingLibs(LDD_CLEAN)).toEqual([]);
});

test('parseMissingLibs: de-duplicates a repeated library', () => {
  expect(parseMissingLibs('libX.so => not found\nlibX.so => not found')).toEqual(['libX.so']);
});

test('parseMissingLibs: ignores lines that are not "=> not found"', () => {
  const out = parseMissingLibs(
    'libc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f)\nnot a dynamic executable',
  );
  expect(out).toEqual([]);
});

test('formatMissingLibsMessage: starts with the marker, names every lib and the command', () => {
  const message = formatMissingLibsMessage(['libX.so', 'libgbm.so.1']);
  expect(message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
  expect(message).toContain('libX.so');
  expect(message).toContain('libgbm.so.1');
  expect(message).toContain(INSTALL_DEPS_COMMAND);
});

test('formatMissingLibsMessage: the count is the NUMBER of libraries, not their length', () => {
  // "libdep.so" is 9 characters — counting characters here would report
  // "9 shared libraries" for a single missing library.
  expect(formatMissingLibsMessage(['libdep.so'])).toContain('1 shared library missing');
  expect(formatMissingLibsMessage(['libX.so', 'libgbm.so.1'])).toContain(
    '2 shared libraries missing',
  );
});

test('remediationPlan: nothing missing => no action', () => {
  expect(remediationPlan([], true)).toEqual({ kind: 'none' });
});

test('remediationPlan: missing + elevation => install-deps with the pinned command', () => {
  const plan = remediationPlan(['libX.so'], true);
  expect(plan).toEqual({ kind: 'install-deps', command: INSTALL_DEPS_COMMAND });
});

test('remediationPlan: missing + no elevation => blocked with the diagnostic, no install', () => {
  const plan = remediationPlan(['libX.so'], false);
  expect(plan.kind).toBe('blocked');
  if (plan.kind !== 'blocked') throw new Error('unreachable');
  expect(plan.message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
  expect(plan.message).toContain('libX.so');
});

// --- the orchestrator ----------------------------------------------------

test('missing libraries: the failure carries the marker, every lib and the install command', () => {
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      locateBinary: () => BINARY,
      ldd: () => LDD_WITH_MISSING,
      probeElevation: () => false,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  expect(message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
  expect(message).toContain('libX.so');
  expect(message).toContain('libgbm.so.1');
  expect(message).toContain(INSTALL_DEPS_COMMAND);
});

test('missing libraries + elevation: the pinned install-deps command is attempted', () => {
  const attempted: string[] = [];
  checkChromiumLibs('/cache', {
    locateBinary: () => BINARY,
    ldd: () => (attempted.length > 0 ? LDD_CLEAN : LDD_WITH_MISSING),
    probeElevation: () => true,
    install: (command) => {
      attempted.push(command);
    },
  });
  expect(attempted).toEqual([INSTALL_DEPS_COMMAND]);
});

test('a FAILING install stays a failure — never a success', () => {
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      locateBinary: () => BINARY,
      ldd: () => LDD_WITH_MISSING,
      probeElevation: () => true,
      install: () => {
        throw new Error('apt-get exited with code 100');
      },
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  expect(message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
  expect(message).toContain(INSTALL_DEPS_COMMAND);
});

test('no elevation: the check fails with the diagnostic and attempts NO install', () => {
  let installCalled = false;
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      locateBinary: () => BINARY,
      ldd: () => LDD_WITH_MISSING,
      probeElevation: () => false,
      install: () => {
        installCalled = true;
      },
    });
  } catch (err) {
    thrown = err;
  }
  expect(installCalled).toBe(false);
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  expect(message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
  expect(message).toContain('libX.so');
});

test('nothing missing: nothing is attempted and the check passes', () => {
  let installCalled = false;
  let probed = false;
  const result = checkChromiumLibs('/cache', {
    locateBinary: () => BINARY,
    ldd: () => LDD_CLEAN,
    probeElevation: () => {
      probed = true;
      return true;
    },
    install: () => {
      installCalled = true;
    },
  });
  expect(result.ok).toBe(true);
  expect(result.missing).toEqual([]);
  expect(installCalled).toBe(false);
  expect(probed).toBe(false);
});

test('an install that claims success but leaves a library missing is still a failure', () => {
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      locateBinary: () => BINARY,
      ldd: () => LDD_WITH_MISSING,
      probeElevation: () => true,
      install: () => {
        /* "succeeded" but nothing changed */
      },
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
});

test('a missing headless-shell binary fails loudly instead of reporting missing libs', () => {
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      locateBinary: () => null,
      ldd: () => LDD_CLEAN,
      probeElevation: () => false,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  expect(message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
  expect(message).toContain('/cache');
});

test('checkChromiumLibs: the PINNED revision drives which binary is inspected', () => {
  const located = { revision: 'unset' as number | null | undefined | 'unset' };
  const result = checkChromiumLibs('/cache', {
    pinnedRevision: () => 1228,
    locateBinary: (_cacheDir, revision) => {
      located.revision = revision;
      return BINARY;
    },
    ldd: () => LDD_CLEAN,
    probeElevation: () => false,
  });
  expect(result.ok).toBe(true);
  expect(located.revision).toBe(1228);
});

test('checkChromiumLibs: an absent PINNED revision fails loud naming it — never a foreign pass', () => {
  // Even a locator that would happily return a newer revision's binary must
  // not be consulted into a false healthy: null for the pinned revision is
  // the answer, with the revision named.
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      pinnedRevision: () => 1228,
      locateBinary: (_cacheDir, revision) => (revision === 9999 ? '/cache/rev-9999/shell' : null),
      ldd: () => LDD_CLEAN,
      probeElevation: () => false,
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  expect(message).toContain('revision 1228');
  expect(message).toContain('/cache');
});

test('checkChromiumLibs: the elevation probe is asked about the ACTUAL install command', () => {
  const asked = { command: null as string | null };
  let thrown: unknown;
  try {
    checkChromiumLibs('/cache', {
      locateBinary: () => BINARY,
      ldd: () => LDD_WITH_MISSING,
      probeElevation: (command) => {
        asked.command = command;
        return false;
      },
    });
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
  expect(asked.command).toBe(INSTALL_DEPS_COMMAND);
});

// --- locating the headless shell in the Playwright cache ----------------

/** Create a fake cache dir with a headless shell at `rel`. */
function makeCache(rel: string): string {
  const dir = join(TMP, 'cache');
  const path = join(dir, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '#!/bin/sh\n', 'utf8');
  return path;
}

test('locateHeadlessShell: finds the linux-x64 layout', () => {
  rmSync(TMP, { recursive: true, force: true });
  const expected = makeCache(
    'chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
  );
  expect(locateHeadlessShell(join(TMP, 'cache'))).toBe(expected);
  rmSync(TMP, { recursive: true, force: true });
});

test('locateHeadlessShell: finds the linux-arm64 layout', () => {
  rmSync(TMP, { recursive: true, force: true });
  const expected = makeCache('chromium_headless_shell-1228/chrome-linux/headless_shell');
  expect(locateHeadlessShell(join(TMP, 'cache'))).toBe(expected);
  rmSync(TMP, { recursive: true, force: true });
});

test('locateHeadlessShell: the PINNED revision wins when the cache holds both 1228 and 9999', () => {
  // The launch uses the revision playwright-core pins — checking the newer
  // 9999 binary instead would answer the wrong question in both directions.
  rmSync(TMP, { recursive: true, force: true });
  const expected = makeCache(
    'chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell',
  );
  makeCache('chromium_headless_shell-9999/chrome-headless-shell-linux64/chrome-headless-shell');
  expect(locateHeadlessShell(join(TMP, 'cache'), 1228)).toBe(expected);
  rmSync(TMP, { recursive: true, force: true });
});

test('locateHeadlessShell: an ABSENT pinned revision yields null — never a foreign binary', () => {
  // A newer revision on disk must not stand in for the pinned one: the launch
  // would fail too, so "healthy" off the foreign binary is a false answer.
  rmSync(TMP, { recursive: true, force: true });
  makeCache('chromium_headless_shell-9999/chrome-headless-shell-linux64/chrome-headless-shell');
  expect(locateHeadlessShell(join(TMP, 'cache'), 1228)).toBeNull();
  rmSync(TMP, { recursive: true, force: true });
});

test('locateHeadlessShell: with NO pinned revision, the scan falls back to the HIGHEST revision', () => {
  // Fallback for an unreadable manifest; the numeric sort still beats the
  // lexical one that would put "9999" before "1228".
  rmSync(TMP, { recursive: true, force: true });
  makeCache('chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell');
  const expected = makeCache(
    'chromium_headless_shell-9999/chrome-headless-shell-linux64/chrome-headless-shell',
  );
  expect(locateHeadlessShell(join(TMP, 'cache'))).toBe(expected);
  rmSync(TMP, { recursive: true, force: true });
});

test('locateHeadlessShell: an absent cache dir yields null, not a wrong answer', () => {
  expect(locateHeadlessShell(join(TMP, 'no-such-cache'))).toBeNull();
});

// --- the pinned revision from playwright-core's manifest -----------------

test('readPinnedHeadlessShellRevision: parses the headless-shell entry', () => {
  const manifest = join(TMP, 'browsers.json');
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({
      comment: '...',
      browsers: [
        { name: 'chromium', revision: '1228' },
        { name: 'chromium-headless-shell', revision: '1228' },
      ],
    }),
    'utf8',
  );
  expect(readPinnedHeadlessShellRevision(manifest)).toBe(1228);
  rmSync(TMP, { recursive: true, force: true });
});

test('readPinnedHeadlessShellRevision: falls back to the chromium entry on older manifests', () => {
  const manifest = join(TMP, 'browsers-old.json');
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    manifest,
    JSON.stringify({ browsers: [{ name: 'chromium', revision: '1148' }] }),
    'utf8',
  );
  expect(readPinnedHeadlessShellRevision(manifest)).toBe(1148);
  rmSync(TMP, { recursive: true, force: true });
});

test('readPinnedHeadlessShellRevision: an unreadable or invalid manifest yields null, not a guess', () => {
  expect(readPinnedHeadlessShellRevision(join(TMP, 'no-such-browsers.json'))).toBeNull();
  const manifest = join(TMP, 'browsers-broken.json');
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  writeFileSync(manifest, '{not json', 'utf8');
  expect(readPinnedHeadlessShellRevision(manifest)).toBeNull();
  writeFileSync(
    manifest,
    JSON.stringify({ browsers: [{ name: 'firefox', revision: '9999' }] }),
    'utf8',
  );
  expect(readPinnedHeadlessShellRevision(manifest)).toBeNull();
  rmSync(TMP, { recursive: true, force: true });
});

test('readPinnedHeadlessShellRevision: the INSTALLED playwright-core manifest resolves', () => {
  // The default path is module-relative — this is the property bin/setup
  // depends on: the check pins the same revision the launch will use.
  const revision = readPinnedHeadlessShellRevision();
  expect(typeof revision).toBe('number');
  expect(revision ?? Number.NaN).toBeGreaterThan(0);
});

// --- the REAL ldd runner -------------------------------------------------
//
// Every test above injects a fake `ldd` seam, so the real runner never
// executes: nothing pinned that it survives `ldd`'s exit status 1. `ldd`
// exits non-zero when it cannot resolve a dependency, and `execFileSync`
// THROWS on a non-zero exit — discarding the very "=> not found" lines the
// check exists to read. These tests drive the real runner against a real
// fixture whose dependency genuinely cannot resolve.

/** A dynamically-linked system binary to build the fixture from. */
const CANDIDATE_BINARIES = ['/bin/true', '/usr/bin/true', '/bin/echo', '/usr/bin/id'];

/** The DT_NEEDED name that is rewritten to an absent library, and its replacement. */
const PATCH_FROM = 'libc.so.6';
const PATCH_TO = 'libq.so.6';

/**
 * Copy a system binary and rewrite its `libc.so.6` DT_NEEDED entry to
 * `libq.so.6`, which exists nowhere. The loader then cannot resolve it and
 * `ldd` reports `libq.so.6 => not found` for a genuinely absent library.
 *
 * The rewrite is an equal-length byte patch of the `.dynstr` string, so the
 * ELF stays structurally valid — no compiler is required.
 *
 * @returns the fixture path, or `null` when no candidate binary could be
 * patched (no dynamically-linked system binary on this host).
 */
function makeUnresolvableBinary(dir: string): string | null {
  for (const candidate of CANDIDATE_BINARIES) {
    let original: Buffer;
    try {
      original = readFileSync(candidate);
    } catch {
      continue;
    }
    const from = Buffer.from(`${PATCH_FROM}\0`, 'utf8');
    const to = Buffer.from(`${PATCH_TO}\0`, 'utf8');
    if (from.length !== to.length) continue;
    const at = original.indexOf(from);
    if (at < 0) continue;
    const patched = Buffer.from(original);
    patched.set(to, at);
    const path = join(dir, 'unresolvable-binary');
    writeFileSync(path, patched);
    chmodSync(path, 0o755);
    return path;
  }
  return null;
}

/**
 * The absolute path of the real `ldd`, resolved BEFORE the test shadows it.
 * `null` when the host has no `ldd` at all.
 */
function findRealLdd(): string | null {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'ldd');
    try {
      // A regular file only — a DIRECTORY named `ldd` would not be runnable.
      if (!statSync(candidate).isFile()) continue;
      return candidate;
    } catch {
      // Not here — keep looking.
    }
  }
  return null;
}

/**
 * Put a stub `ldd` first on PATH. The stub runs the REAL `ldd` (so the output
 * is the loader's own) and then exits 1 — the status `ldd` uses when it could
 * not resolve everything.
 *
 * @returns the PATH to restore.
 */
function installExitingLddStub(dir: string, realLdd: string): string {
  const stub = join(dir, 'ldd');
  writeFileSync(stub, `#!/bin/sh\n"${realLdd}" "$@" || true\nexit 1\n`, 'utf8');
  chmodSync(stub, 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${previous}`;
  return previous;
}

test('runLdd: ldd exiting 1 still yields the "=> not found" lines', () => {
  const dir = join(TMP, 'real-ldd');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const realLdd = findRealLdd();
  const binary = makeUnresolvableBinary(dir);
  if (!realLdd || !binary) {
    rmSync(dir, { recursive: true, force: true });
    return; // No `ldd` or no patchable binary on this host — nothing to assert.
  }

  const previousPath = installExitingLddStub(dir, realLdd);
  try {
    const output = runLdd(binary);
    // The whole point: the missing library is READABLE, not thrown away
    // with the non-zero exit status.
    expect(parseMissingLibs(output)).toEqual([PATCH_TO]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkChromiumLibs: the REAL ldd runner reports the missing library', () => {
  const dir = join(TMP, 'real-ldd-check');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const realLdd = findRealLdd();
  const binary = makeUnresolvableBinary(dir);
  if (!realLdd || !binary) {
    rmSync(dir, { recursive: true, force: true });
    return; // No `ldd` or no patchable binary on this host — nothing to assert.
  }

  const previousPath = installExitingLddStub(dir, realLdd);
  try {
    // No `ldd` seam is injected: the real runner does the work.
    let thrown: unknown;
    try {
      checkChromiumLibs(dir, {
        locateBinary: () => binary,
        probeElevation: () => false,
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ChromiumLibsMissingError);
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message.startsWith(MISSING_LIBS_MARKER)).toBe(true);
    expect(message).toContain(PATCH_TO);
    expect(message).toContain(INSTALL_DEPS_COMMAND);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the REAL elevation probe and installer ------------------------------
//
// `sudo` is stubbed on PATH (the same trick the real-`ldd` tests above use),
// so these drive the REAL `probeElevation`/`runInstaller` against a policy
// that can be shaped per test. The scenario that must never come back: a
// sudoers rule allowing passwordless `true` while the real install needs a
// password — the old `sudo -n true` probe passed it and install-deps' inner
// `sudo -- sh -c …` prompted, hanging the run.

/**
 * Put a stub `sudo` first on PATH. `body` is the shell body; `$@` is argv.
 * Returns the PATH to restore.
 */
function installSudoStub(dir: string, body: string): string {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, 'sudo');
  writeFileSync(stub, `#!/bin/sh\n${body}\n`, 'utf8');
  chmodSync(stub, 0o755);
  const previous = process.env.PATH ?? '';
  process.env.PATH = `${dir}:${previous}`;
  return previous;
}

/**
 * Run `fn` with `process.getuid` reporting non-root, so the sudo paths of the
 * probe and installer are exercised even on a host running the suite as root.
 */
function asNonRoot<T>(fn: () => T): T {
  const real = process.getuid;
  process.getuid = () => 1000;
  try {
    return fn();
  } finally {
    process.getuid = real;
  }
}

/** A sudoers rule: NOPASSWD for `true` ONLY — everything else needs a password. */
const SUDO_TRUE_ONLY = `[ "$1" = "-n" ] && shift
[ "$1" = "-l" ] && shift
[ "$1" = "true" ] && exit 0
echo 'sudo: a password is required' >&2
exit 1`;

const SUDO_ARGV_RECORD = (record: string) =>
  `printf '%s\\n' "$@" >> ${JSON.stringify(record)}\nexit 0`;

/** A sudo that demands a password — what `sudo -n` must surface as a LOUD failure. */
const SUDO_DEMANDS_PASSWORD = `echo 'sudo: a password is required' >&2\nexit 1`;

test('probeElevation: asks the POLICY about the ACTUAL install command (sudo -n -l <argv>)', () => {
  const dir = join(TMP, 'sudo-probe');
  const record = join(dir, 'argv.txt');
  const previousPath = installSudoStub(dir, SUDO_ARGV_RECORD(record));
  try {
    expect(asNonRoot(() => probeElevation(INSTALL_DEPS_COMMAND))).toBe(true);
    // The probe must name the exact argv the installer will run — a generic
    // "sudo works" probe is what let a passwordless-`true` sudoers rule pass.
    expect(readFileSync(record, 'utf8').split('\n').filter(Boolean)).toEqual([
      '-n',
      '-l',
      'node',
      'node_modules/playwright-core/cli.js',
      'install-deps',
      'chromium',
    ]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('probeElevation: a passwordless-`true`-only rule does NOT clear the real install command', () => {
  const dir = join(TMP, 'sudo-true-only');
  const previousPath = installSudoStub(dir, SUDO_TRUE_ONLY);
  try {
    // The rule really covers `true`…
    expect(asNonRoot(() => probeElevation('true'))).toBe(true);
    // …and yet the command the installer runs is refused: no probe pass that
    // would let install-deps prompt mid-install.
    expect(asNonRoot(() => probeElevation(INSTALL_DEPS_COMMAND))).toBe(false);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runInstaller: elevates the ACTUAL command under sudo -n, never a bare sudo', () => {
  const dir = join(TMP, 'sudo-install');
  const record = join(dir, 'argv.txt');
  const previousPath = installSudoStub(dir, SUDO_ARGV_RECORD(record));
  try {
    asNonRoot(() => runInstaller(INSTALL_DEPS_COMMAND));
    // Exactly the noninteractive wrapper + the pinned installer argv.
    expect(readFileSync(record, 'utf8').split('\n').filter(Boolean)).toEqual([
      '-n',
      'node',
      'node_modules/playwright-core/cli.js',
      'install-deps',
      'chromium',
    ]);
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runInstaller: a sudo that wants a password fails LOUD instead of prompting', () => {
  const dir = join(TMP, 'sudo-password');
  const previousPath = installSudoStub(dir, SUDO_DEMANDS_PASSWORD);
  try {
    // `sudo -n` must FAIL here — instantly, non-zero, naming the invocation —
    // never hang on a prompt. (The stub's message lands on the terminal via
    // `stdio: 'inherit'`; the thrown error names the failed invocation.)
    expect(() => asNonRoot(() => runInstaller(INSTALL_DEPS_COMMAND))).toThrow(
      'Command failed: sudo -n node node_modules/playwright-core/cli.js install-deps chromium',
    );
  } finally {
    process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});
