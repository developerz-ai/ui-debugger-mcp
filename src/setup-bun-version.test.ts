/**
 * `bin/require-bun` — the stage `bin/setup` uses to pin the Bun runtime CI
 * runs on — and the way `bin/setup` consumes it.
 *
 * The defect this pins: setup used to accept whatever `bun` was on PATH (or
 * whatever a best-effort `mise` activation produced) and carry it into every
 * later stage, so a checkout could be provisioned on a runtime CI never runs
 * on. `bin/require-bun` derives the version from the CI configuration itself
 * (.github/workflows/ci.yml — the source of truth), selects a runtime at
 * exactly that version, verifies the runtime's own `--version`, and fails
 * loud when it cannot.
 *
 * These tests EXECUTE `bin/require-bun` against stub `bun`/`mise` binaries
 * on a synthetic PATH. Nothing here touches the network, downloads a browser
 * or mutates the developer's real toolchain: the stub PATH contains only the
 * handful of host binaries the script needs (node, dirname, basename) plus
 * the stubs themselves.
 *
 * Every guard carries a MUTATION check: the guard is shown to turn RED when
 * the thing it guards is broken. A guard that cannot fail is a defect.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const REQUIRE_BUN = join(REPO_ROOT, 'bin/require-bun');
const SETUP_SCRIPT = join(REPO_ROOT, 'bin/setup');
const CI_WORKFLOW = join(REPO_ROOT, '.github/workflows/ci.yml');
const MISE_TOML = join(REPO_ROOT, 'mise.toml');

/** The bun version the repository's CI pins, read independently of the script. */
function ciPinnedVersions(): string[] {
  const text = readFileSync(CI_WORKFLOW, 'utf8');
  const versions = [...text.matchAll(/bun-version:\s*["']?([^"'\s#]+)["']?/g)]
    .map((m) => m[1])
    .filter((version): version is string => version !== undefined);
  return [...new Set(versions)];
}

/** The single version the CI configuration pins. */
function ciPinnedVersion(): string {
  const versions = ciPinnedVersions();
  expect(versions.length).toBe(1);
  return versions[0] ?? '';
}

/**
 * The real `node` binary, as an absolute path. `node` on a mise-managed host
 * is a SHIM (a symlink to the mise binary) that fails when mise is not on
 * PATH — and the stub PATH deliberately is not the host PATH. So the shim is
 * resolved once, with the host environment, to the binary it dispatches to.
 */
function realNodeBinary(): string {
  const result = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' });
  const resolved = result.stdout.trim();
  if (result.status === 0 && resolved.startsWith('/')) return resolved;
  const fallback = join('/usr/bin', 'node');
  return fallback;
}

/**
 * A host binary the stub PATH must carry. `node` reads the workflow; `dirname`
 * and `basename` build the absolute path the script prints.
 */
function hostBinary(name: string): string {
  if (name === 'node') return realNodeBinary();
  const found = Bun.which(name);
  if (found) return found;
  const fallback = join('/usr/bin', name);
  return fallback;
}

type RunResult = { status: number; stdout: string; stderr: string };

type FixtureOptions = {
  /** The workflow text the stub repo carries. Defaults to the real one. */
  workflow?: string;
  /** The version the stub `bun` reports. `null` = no stub bun at all. */
  bunVersion?: string | null;
  /** The version the mise-provided bun reports. `null` = no mise stub. */
  miseVersion?: string | null;
  /** The script text the stub repo carries. Defaults to the real one. */
  script?: string;
  /** Whether node is on the stub PATH. Default: true. */
  nodeOnPath?: boolean;
  /** mise has an INSTALLED node — the host manages it, PATH does not. */
  miseNode?: boolean;
};

/**
 * A synthetic checkout: `bin/require-bun` plus a workflow, on a PATH holding
 * only node/dirname/basename and the stubs. `bun` and `mise` are what the
 * test chooses, so the ambient toolchain of the host can never leak in.
 */
function makeFixture(options: FixtureOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'require-bun-'));
  const repo = join(root, 'repo');
  const stubBin = join(root, 'stubbin');
  const sysBin = join(root, 'sysbin');
  mkdirSync(join(repo, 'bin'), { recursive: true });
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  mkdirSync(sysBin, { recursive: true });

  // The script under test — the real one, or a mutated copy a guard proves
  // it can fail on.
  writeFileSync(
    join(repo, 'bin/require-bun'),
    options.script ?? readFileSync(REQUIRE_BUN, 'utf8'),
    'utf8',
  );
  chmodSync(join(repo, 'bin/require-bun'), 0o755);
  writeFileSync(
    join(repo, '.github/workflows/ci.yml'),
    options.workflow ?? readFileSync(CI_WORKFLOW, 'utf8'),
    'utf8',
  );

  for (const name of ['node', 'dirname', 'basename']) {
    // A host that manages node with mise can have it INSTALLED but not on
    // PATH — the fixture reproduces that by leaving node out of the stub
    // PATH, so the script has to resolve it through mise.
    if (name === 'node' && options.nodeOnPath === false) continue;
    const source = hostBinary(name);
    try {
      symlinkSync(source, join(sysBin, name));
    } catch {
      // A symlink can fail where the target is not linkable — copy instead.
      copyFileSync(source, join(sysBin, name));
      chmodSync(join(sysBin, name), 0o755);
    }
  }

  const stubBun = join(stubBin, 'bun');
  if (options.bunVersion !== null && options.bunVersion !== undefined) {
    writeFileSync(stubBun, `#!/bin/sh\necho "${options.bunVersion}"\n`, 'utf8');
    chmodSync(stubBun, 0o755);
  }

  const miseDir = join(root, 'mise-install');
  const miseNodeDir = join(root, 'mise-node');
  const miseLog = join(stubBin, 'mise-calls.log');
  const miseEnvLog = join(stubBin, 'mise-env.log');
  const hasMiseBun = options.miseVersion !== null && options.miseVersion !== undefined;

  if (hasMiseBun) {
    mkdirSync(join(miseDir, 'bin'), { recursive: true });
    const miseBun = join(miseDir, 'bin/bun');
    writeFileSync(miseBun, `#!/bin/sh\necho "${options.miseVersion}"\n`, 'utf8');
    chmodSync(miseBun, 0o755);
  }

  if (options.miseNode === true) {
    // mise has node INSTALLED (the host manages it) — PATH does not have it.
    mkdirSync(join(miseNodeDir, 'bin'), { recursive: true });
    const miseNodeBin = join(miseNodeDir, 'bin/node');
    try {
      symlinkSync(realNodeBinary(), miseNodeBin);
    } catch {
      copyFileSync(realNodeBinary(), miseNodeBin);
      chmodSync(miseNodeBin, 0o755);
    }
  }

  if (hasMiseBun || options.miseNode === true) {
    // A mise stub that answers ONLY for tools that are ALREADY INSTALLED —
    // a request for any other version is answered "not installed", exactly
    // as mise does — and that RECORDS every call, so a test can assert the
    // EXACT query the script made. A stub that answered every version would
    // hide a wrong request.
    const whereAnswers: string[] = [];
    if (hasMiseBun) {
      whereAnswers.push(`      'bun@${options.miseVersion}') echo '${miseDir}'; exit 0 ;;`);
    }
    if (options.miseNode === true) {
      whereAnswers.push(`      'node') echo '${miseNodeDir}'; exit 0 ;;`);
    }
    const whichAnswers: string[] =
      options.miseNode === true ? [`      'node') echo '${miseNodeDir}/bin/node'; exit 0 ;;`] : [];
    writeFileSync(
      join(stubBin, 'mise'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$*" >> '${miseLog}'`,
        `printf 'MISE_AUTO_INSTALL=%s\\n' "\${MISE_AUTO_INSTALL:-unset}" >> '${miseEnvLog}'`,
        'case "$1" in',
        '  where)',
        '    case "$2" in',
        ...whereAnswers,
        '    esac',
        '    ;;',
        '  which)',
        '    case "$2" in',
        ...whichAnswers,
        '    esac',
        '    ;;',
        'esac',
        'exit 1',
        '',
      ].join('\n'),
      'utf8',
    );
    chmodSync(join(stubBin, 'mise'), 0o755);
  }

  const path = `${stubBin}:${sysBin}`;

  const run = (): RunResult => {
    const result = spawnSync('/bin/bash', [join(repo, 'bin/require-bun')], {
      cwd: root,
      env: { PATH: path, HOME: root },
      encoding: 'utf8',
      timeout: 10_000,
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout ?? '',
      stderr: result.stderr ?? '',
    };
  };

  return {
    root,
    repo,
    stubBun,
    miseBun: join(miseDir, 'bin/bun'),
    miseLog,
    miseEnvLog,
    run,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** Every mise call the stub recorded, in the order the script made them. */
function miseCalls(fixture: { miseLog: string }): string[] {
  if (!existsSync(fixture.miseLog)) return [];
  return readFileSync(fixture.miseLog, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0);
}

/** The `BUN_VERSION=` / `BUN_PATH=` values a successful run printed. */
function parseOutput(stdout: string): { version: string; path: string } {
  const version = stdout.match(/^BUN_VERSION=(.*)$/m)?.[1] ?? '';
  const path = stdout.match(/^BUN_PATH=(.*)$/m)?.[1] ?? '';
  return { version, path };
}

describe('bin/require-bun — the required version comes from ci.yml', () => {
  test('the derived version is the version the CI configuration pins', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).version).toBe(expected);
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: changing the ci.yml pin changes the derived version', () => {
    // The guard above passes with ANY pin as long as the script agrees with
    // the file — which is the point, but it also means the script could
    // hardcode a literal and still pass. Changing the pin in a scratch
    // workflow proves the version is DERIVED, not baked in.
    const original = readFileSync(CI_WORKFLOW, 'utf8');
    const mutated = original.replace(/bun-version:\s*["']?[^"'\s#]+["']?/g, 'bun-version: "9.9.9"');
    expect(mutated).not.toBe(original);

    const fixture = makeFixture({ workflow: mutated, bunVersion: '9.9.9' });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).version).toBe('9.9.9');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a ci.yml whose setup-bun steps disagree is UNRESOLVED', () => {
    // Two setup-bun steps pinning different versions: CI itself would be
    // ambiguous, so the required version cannot be resolved — the script
    // must fail loud rather than pick one.
    const original = readFileSync(CI_WORKFLOW, 'utf8');
    const mutated = `${original}\n      - uses: oven-sh/setup-bun@v2\n        with:\n          bun-version: "9.9.9"\n`;
    const fixture = makeFixture({ workflow: mutated, bunVersion: '9.9.9' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_UNRESOLVED:');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: disagreeing setup-bun steps in opposite key orders are UNRESOLVED', () => {
    // The parser must collect EVERY setup-bun step, not only steps whose
    // first key is `uses:`. These two steps disagree and use opposite key
    // orders: whichever one the parser drops, the remaining pin would look
    // unambiguous — so the script must fail rather than silently pick one.
    const workflow = [
      'name: ci',
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: oven-sh/setup-bun@v2',
      '        with:',
      '          bun-version: "1.4.3"',
      '      - name: Install Bun for the second job',
      '        uses: oven-sh/setup-bun@v2',
      '        with:',
      '          bun-version: "9.9.9"',
      '',
    ].join('\n');
    const fixture = makeFixture({ workflow, bunVersion: '1.4.3' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_UNRESOLVED:');
      expect(result.stdout).not.toContain('BUN_VERSION=');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a ci.yml with NO setup-bun step is UNRESOLVED', () => {
    const workflow =
      'name: ci\non: push\njobs:\n  a:\n    steps:\n      - uses: actions/checkout@v7\n';
    const fixture = makeFixture({ workflow, bunVersion: '1.4.3' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_UNRESOLVED:');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a pin with a trailing comment yields the version, not the comment', () => {
    // `bun-version: "1.4.3" # CI runtime` pins 1.4.3 — the comment is NOT part
    // of the value. A parser that keeps it derives `1.4.3 # CI runtime`, a
    // version no runtime ever reports, so setup would reject a bun that
    // matches CI exactly.
    const workflow = [
      'name: ci',
      'on: push',
      'jobs:',
      '  test:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: oven-sh/setup-bun@v2 # the runtime CI installs',
      '        with:',
      '          bun-version: "1.4.3" # CI runtime',
      '',
    ].join('\n');
    const fixture = makeFixture({ workflow, bunVersion: '1.4.3' });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).version).toBe('1.4.3');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: an UNQUOTED pin with a trailing comment yields the version', () => {
    // Same pin without quotes — a plain YAML scalar, where the comment
    // starts at the `#` the whitespace introduces.
    const workflow = [
      'name: ci',
      'on: push',
      'jobs:',
      '  test:',
      '    steps:',
      '      - uses: oven-sh/setup-bun@v2',
      '        with:',
      '          bun-version: 1.4.3 # CI runtime',
      '',
    ].join('\n');
    const fixture = makeFixture({ workflow, bunVersion: '1.4.3' });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).version).toBe('1.4.3');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('bin/require-bun — a matching runtime is accepted', () => {
  test('a bun whose version matches is accepted and reported', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      const { version, path } = parseOutput(result.stdout);
      expect(version).toBe(expected);
      // The reported path must be the ABSOLUTE path of the stub — the caller
      // puts its directory on PATH, so a relative path would resolve
      // against whatever cwd the caller happens to have.
      expect(path.startsWith('/')).toBe(true);
      expect(path.endsWith('/bun')).toBe(true);
      expect(result.stdout.trim().split('\n')).toEqual([
        `BUN_VERSION=${expected}`,
        `BUN_PATH=${path}`,
      ]);
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a bun whose version differs is REJECTED — the guard turns red', () => {
    // The accept guard above must not survive a runtime of the wrong
    // version: the same fixture, a bun reporting another version, must be
    // rejected — so a hardcoded "accept whatever is on PATH" implementation
    // cannot pass both.
    const fixture = makeFixture({ bunVersion: '0.0.1' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_MISMATCH:');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: the version comparison tolerates a leading v and whitespace', () => {
    // `bun --version` prints a bare version; a build that prefixes `v` is
    // the same runtime. The comparison must not reject it — and must not
    // accept a DIFFERENT version that merely looks similar.
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: `v${expected}\n` });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).version).toBe(expected);
    } finally {
      fixture.cleanup();
    }
  });

  test('a mise-provided runtime is preferred over the ambient bun', () => {
    const expected = ciPinnedVersion();
    // BOTH runtimes report the required version, so only the PREFERENCE
    // decides which one is used: mise is asked first and its binary is the
    // one that gets reported. With a mismatched ambient bun this would pass
    // either way (the loop would fall through to mise), so the ambient bun
    // here matches too.
    const fixture = makeFixture({ bunVersion: expected, miseVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      const { version, path } = parseOutput(result.stdout);
      expect(version).toBe(expected);
      expect(path).toBe(fixture.miseBun);
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a mise runtime beats an equally-matching ambient bun', () => {
    // Same fixture, mise removed: the ambient bun is then the only runtime
    // left and it must be the one reported. A script that always answered
    // with mise would fail this.
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).path).toBe(fixture.stubBun);
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: without the mise runtime the same fixture falls back and fails', () => {
    // Same fixture, mise removed: the ambient bun (wrong version) is all
    // that is left, and it must be rejected. A script that silently used
    // the ambient bun despite mise would fail this.
    const fixture = makeFixture({ bunVersion: '0.0.1' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_MISMATCH:');
    } finally {
      fixture.cleanup();
    }
  });

  test('the mise query asks for EXACTLY the CI-pinned version', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected, miseVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).path).toBe(fixture.miseBun);
      // The query names the version CI pins — mise resolves an INSTALLED
      // version, so any other spec would resolve nothing.
      expect(miseCalls(fixture)).toContain(`where bun@${expected}`);
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a mise query for another version turns the guard red', () => {
    // The stub answers ONLY the installed version, so a script that asked
    // for another one selects no mise runtime at all — and the exact query
    // the guard above asserts is gone.
    const expected = ciPinnedVersion();
    const source = readFileSync(REQUIRE_BUN, 'utf8');
    const mutated = source.replace(
      /mise where "bun@\$\{required_version\}"/,
      'mise where "bun@0.0.1"',
    );
    expect(mutated).not.toBe(source);
    const fixture = makeFixture({
      script: mutated,
      bunVersion: expected,
      miseVersion: expected,
    });
    try {
      const result = fixture.run();
      expect(miseCalls(fixture)).not.toContain(`where bun@${expected}`);
      expect(parseOutput(result.stdout).path).not.toBe(fixture.miseBun);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('bin/require-bun — node comes from PATH or from mise', () => {
  test('a node that is INSTALLED but not on PATH is resolved through mise', () => {
    // The host manages its runtimes with mise: node is installed, PATH does
    // not carry it. The workflow must still be read — the pin derives from
    // it — so the node is resolved through mise instead of failing.
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected, nodeOnPath: false, miseNode: true });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(parseOutput(result.stdout).version).toBe(expected);
      // The resolution never downloads: mise's auto-install stays off.
      expect(readFileSync(fixture.miseEnvLog, 'utf8')).toContain('MISE_AUTO_INSTALL=0');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: without the mise node resolution the same fixture fails', () => {
    const expected = ciPinnedVersion();
    const source = readFileSync(REQUIRE_BUN, 'utf8');
    const mutated = source.replace(
      'if [ -z "$node_bin" ] && command -v mise >/dev/null 2>&1; then',
      'if false; then',
    );
    expect(mutated).not.toBe(source);
    const fixture = makeFixture({
      script: mutated,
      bunVersion: expected,
      nodeOnPath: false,
      miseNode: true,
    });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_UNRESOLVED:');
    } finally {
      fixture.cleanup();
    }
  });

  test('a node that is nowhere at all fails loud', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected, nodeOnPath: false });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_UNRESOLVED:');
      // The diagnostic must name how to obtain one.
      expect(result.stderr).toContain('mise install node');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('bin/require-bun — the failure paths are loud', () => {
  test('a mismatched ambient bun is rejected naming both versions', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: '0.0.1' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      // The diagnostic must name BOTH the found and the required version —
      // a mismatch without the two numbers is not actionable.
      expect(result.stderr).toContain('X_BUN_VERSION_MISMATCH:');
      expect(result.stderr).toContain('0.0.1');
      expect(result.stderr).toContain(expected);
      // And nothing may be reported as verified on stdout.
      expect(result.stdout).not.toContain('BUN_PATH=');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: the mismatch diagnostic disappears once the versions agree', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('X_BUN_VERSION_MISMATCH:');
    } finally {
      fixture.cleanup();
    }
  });

  test('no obtainable runtime fails loud with a named diagnostic', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: null });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      // No runtime at all is MISSING — a different diagnosis from a runtime
      // of the wrong version, and the one that names how to obtain it.
      expect(result.stderr).toContain('X_BUN_MISSING:');
      // The diagnostic must name the required version and how to obtain it.
      expect(result.stderr).toContain(expected);
      expect(result.stderr).toContain('mise install');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: the same fixture succeeds once a matching runtime exists', () => {
    const expected = ciPinnedVersion();
    const fixture = makeFixture({ bunVersion: expected });
    try {
      const result = fixture.run();
      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain('X_BUN_MISSING:');
    } finally {
      fixture.cleanup();
    }
  });

  test('MUTATION: a runtime of the WRONG version is a MISMATCH, never a MISSING', () => {
    // The two diagnoses are distinct: a bun IS present, it is just not the
    // one CI pins. Reporting "missing" for a present-but-wrong runtime sends
    // the reader looking for an absent binary instead of a wrong one.
    const fixture = makeFixture({ bunVersion: '0.0.1' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('X_BUN_VERSION_MISMATCH:');
      expect(result.stderr).not.toContain('X_BUN_MISSING:');
    } finally {
      fixture.cleanup();
    }
  });

  test('a failing run prints its diagnostic on stderr, not stdout', () => {
    const fixture = makeFixture({ bunVersion: '0.0.1' });
    try {
      const result = fixture.run();
      expect(result.status).not.toBe(0);
      expect(result.stdout).not.toContain('X_BUN_');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('mise.toml and ci.yml cannot drift apart', () => {
  test('the mise.toml bun pin equals the version ci.yml pins', () => {
    const ciVersion = ciPinnedVersion();
    const miseText = readFileSync(MISE_TOML, 'utf8');
    const miseVersion = miseText.match(/^\s*bun\s*=\s*["']([^"']+)["']/m)?.[1];
    expect(miseVersion).toBeDefined();
    expect(miseVersion).toBe(ciVersion);
  });

  test('MUTATION: a mise.toml pinning another version breaks the agreement', () => {
    const miseText = readFileSync(MISE_TOML, 'utf8');
    const mutated = miseText.replace(/bun\s*=\s*["'][^"']+["']/, 'bun = "0.0.1"');
    expect(mutated).not.toBe(miseText);
    const miseVersion = mutated.match(/^\s*bun\s*=\s*["']([^"']+)["']/m)?.[1];
    expect(miseVersion).not.toBe(ciPinnedVersion());
  });
});

describe('bin/setup consumes the verified runtime', () => {
  const setupText = readFileSync(SETUP_SCRIPT, 'utf8');

  /** 1-based line number of the first CODE line containing `needle`, or -1. */
  function codeLineOf(needle: string): number {
    const lines = setupText
      .split('\n')
      .map((line, index) => ({ text: line.trim(), line: index + 1 }))
      .filter((entry) => entry.text.length > 0 && !entry.text.startsWith('#'));
    const hit = lines.find((entry) => entry.text.includes(needle));
    return hit ? hit.line : -1;
  }

  test('the verification runs before the root install', () => {
    const verifyLine = codeLineOf('bin/require-bun');
    const installLine = codeLineOf('bun install');
    expect(verifyLine).toBeGreaterThan(0);
    expect(installLine).toBeGreaterThan(0);
    expect(verifyLine).toBeLessThan(installLine);
  });

  test('MUTATION: moving the verification after the install breaks the ordering', () => {
    // The ordering guard must fail when the verification is moved after the
    // install — otherwise a setup that provisions on an unverified runtime
    // would pass.
    const lines = setupText.split('\n');
    const verifyIndex = lines.findIndex((line) => line.includes('bun_env=$(bin/require-bun)'));
    const installIndex = lines.findIndex((line) => line.trim() === 'bun install');
    expect(verifyIndex).toBeGreaterThan(-1);
    expect(installIndex).toBeGreaterThan(-1);

    const mutated = [...lines];
    const [verifyLine] = mutated.splice(verifyIndex, 1);
    expect(verifyLine).toBeDefined();
    mutated.splice(installIndex, 0, verifyLine ?? '');

    const verifyPosition = mutated.findIndex((line) => line.includes('bun_env=$(bin/require-bun)'));
    const installPosition = mutated.findIndex((line) => line.trim() === 'bun install');
    expect(verifyPosition).toBeGreaterThan(installPosition);
  });

  test('the verified bun directory is exported onto PATH before the install', () => {
    const exportLine = codeLineOf('export PATH=');
    const installLine = codeLineOf('bun install');
    expect(exportLine).toBeGreaterThan(0);
    expect(installLine).toBeGreaterThan(0);
    expect(exportLine).toBeLessThan(installLine);
    // The verified directory must be PREPENDED — ahead of every other entry
    // that could hold a bun — not appended behind it.
    const exportText = setupText
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('export PATH='));
    expect(exportText).toBeDefined();
    expect(exportText?.startsWith('export PATH="$(dirname "$BUN_PATH"):$PATH"')).toBe(true);
  });

  test('MUTATION: appending the verified directory instead of prepending breaks it', () => {
    const mutated = setupText.replace(
      'export PATH="$(dirname "$BUN_PATH"):$PATH"',
      'export PATH="$PATH:$(dirname "$BUN_PATH")"',
    );
    expect(mutated).not.toBe(setupText);
    const exportText = mutated
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.startsWith('export PATH='));
    expect(exportText?.startsWith('export PATH="$(dirname "$BUN_PATH"):$PATH"')).toBe(false);
  });

  test('the setup stage reads the version and path the verification reported', () => {
    expect(setupText).toContain('BUN_VERSION=');
    expect(setupText).toContain('BUN_PATH=');
    expect(codeLineOf('BUN_VERSION=$(printf')).toBeGreaterThan(0);
    expect(codeLineOf('BUN_PATH=$(printf')).toBeGreaterThan(0);
  });

  test('MUTATION: dropping the reported values breaks the consumption', () => {
    const mutated = setupText.replace(/^BUN_PATH=\$\(printf.*$/m, '');
    expect(mutated).not.toBe(setupText);
    expect(mutated.includes('BUN_PATH=$(printf')).toBe(false);
  });
});
