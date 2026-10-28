/**
 * The repo's `.gitignore` must keep the CLI suite's scratch dirs out of the
 * working tree — and must not swallow the real CLI sources.
 *
 * `src/cli/chromium-libs.test.ts` and `src/cli/init.test.ts` create their
 * scratch dirs INSIDE the source tree (`join(import.meta.dir, '__test_*_tmp__')`).
 * They clean up after themselves, but an interrupted or failed run leaves them
 * behind, and the pre-existing `tmp/` rule does NOT cover them: gitignore(5)
 * matches `tmp/` against a path component named exactly `tmp`, while these are
 * named `__test_chromium_libs_tmp__` / `__test_init_tmp__`. The leftovers then
 * surface as untracked artifacts in `git status`.
 *
 * The oracle here is REAL git, not a parser: the repo's own `.gitignore` bytes
 * are copied into a throwaway repo under `os.tmpdir()` and `git check-ignore`
 * decides. Exit statuses are pinned exactly — 0 means ignored, ONLY 1 means not
 * ignored, anything else throws, so a usage/protocol error can never be read
 * as a pass.
 *
 * EVERY git call runs HERMETIC: no system config, no inherited pointer to a
 * global config, and a HOME/XDG dir holding neither `~/.gitconfig` nor a
 * global excludes file. A developer's global ignore (core.excludesFile) would
 * otherwise answer for the negative controls — the guard must assert what the
 * REPO's rules say. `git init` and `git check-ignore` get the SAME env:
 * hermetic for one of them only leaves the other reading the ambient one.
 *
 * A missing `git` binary fails loud — a silent skip would let this file pass
 * green with zero `check-ignore` calls.
 */

import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

/** Scratch dirs the CLI suite creates inside the source tree. */
const SCRATCH_DIRS = ['src/cli/__test_chromium_libs_tmp__', 'src/cli/__test_init_tmp__'] as const;

/** The real CLI sources + tests the ignore rules must never swallow. */
const CLI_SOURCES = [
  'src/cli/init.ts',
  'src/cli/init.test.ts',
  'src/cli/chromium-libs.ts',
  'src/cli/chromium-libs.test.ts',
] as const;

/** The same dir names outside `src/cli/` — an unanchored rule would hit these. */
const OFF_PATH_PROBES = [
  'vendor/__test_chromium_libs_tmp__/probe.txt',
  'vendor/__test_init_tmp__/probe.txt',
] as const;

/**
 * Inherited pointers to a global/system config file. They re-open the hole
 * that HOME/XDG close — a global config can carry `core.excludesFile`, and
 * that file would decide the negative controls.
 */
const INHERITED_CONFIG_POINTERS = ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT'];

/** True only when a real `git` binary is on PATH — the oracle is present. */
function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * The oracle is a REAL git binary. Without one this guard proves nothing, so
 * fail loud — a silent skip would let the file pass green with zero
 * `check-ignore` calls.
 */
function requireGit(): void {
  if (!gitAvailable()) {
    throw new Error('no git binary on PATH — the .gitignore guard cannot verify anything');
  }
}

/**
 * A hermetic git env: no system config, no inherited pointer to a global
 * config, and a HOME/XDG dir holding neither `~/.gitconfig` nor a global
 * excludes file — a developer's global ignore must not decide what this guard
 * asserts.
 */
function hermeticEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (INHERITED_CONFIG_POINTERS.includes(key)) continue;
    env[key] = value;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.HOME = home;
  env.XDG_CONFIG_HOME = home;
  return env;
}

/**
 * A throwaway git repo under `os.tmpdir()`, seeded with the repo's OWN
 * `.gitignore` bytes. Never inside the checkout — this guard must not create
 * the very artifacts it guards against. `env` is the hermetic env EVERY git
 * call in this file must use.
 */
function fixtureRepo(): { dir: string; repo: string; env: NodeJS.ProcessEnv } {
  const dir = mkdtempSync(join(tmpdir(), 'gitignore-guard-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo, { recursive: true });
  // Hermetic: no system config, and a HOME/XDG dir holding neither
  // ~/.gitconfig nor a global excludes file — a developer's global ignore must
  // not decide what this guard asserts.
  const env = hermeticEnv(dir);
  execFileSync('git', ['init', '-q'], {
    cwd: repo,
    stdio: 'ignore',
    env,
  });
  writeFileSync(join(repo, '.gitignore'), readFileSync(join(REPO_ROOT, '.gitignore')));
  return { dir, repo, env };
}

/**
 * `git check-ignore -q -- <p>` in `repo`: true on exit 0 (ignored), false ONLY
 * on exit 1 (not ignored), throws on anything else — an unrelated failure must
 * never be read as a pass. `env` is passed EXPLICITLY: inherited, the ambient
 * global ignore would answer for the negative controls.
 */
function gitIgnores(env: NodeJS.ProcessEnv, repo: string, relPath: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', relPath], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    return true;
  } catch (e) {
    if ((e as { status?: number | null }).status === 1) return false;
    throw e;
  }
}

/** Materialize `relPath` inside `repo` so check-ignore sees a real file. */
function touch(repo: string, relPath: string): void {
  const abs = join(repo, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'x\n', 'utf8');
}

/** Run `body` against a throwaway repo; always remove the fixture afterwards. */
function withFixtureRepo(body: (repo: string, env: NodeJS.ProcessEnv) => void): void {
  const { dir, repo, env } = fixtureRepo();
  try {
    body(repo, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Restore an env var exactly — an unset var must not become the string "undefined". */
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

test('REAL git: a file inside each CLI scratch dir is ignored', () => {
  requireGit(); // the oracle must be present — never a silent skip
  withFixtureRepo((repo, env) => {
    const results = SCRATCH_DIRS.map((scratch) => {
      const probe = `${scratch}/probe.txt`;
      touch(repo, probe);
      return { path: probe, ignored: gitIgnores(env, repo, probe) };
    });
    expect(results).toEqual(
      SCRATCH_DIRS.map((scratch) => ({ path: `${scratch}/probe.txt`, ignored: true })),
    );
  });
});

test('REAL git: the scratch-dir rules are anchored to the repo root', () => {
  requireGit(); // the oracle must be present — never a silent skip
  withFixtureRepo((repo, env) => {
    const results = OFF_PATH_PROBES.map((probe) => {
      touch(repo, probe);
      return { path: probe, ignored: gitIgnores(env, repo, probe) };
    });
    expect(results).toEqual(OFF_PATH_PROBES.map((probe) => ({ path: probe, ignored: false })));
  });
});

test('REAL git: the real CLI sources and tests are not ignored', () => {
  requireGit(); // the oracle must be present — never a silent skip
  withFixtureRepo((repo, env) => {
    const results = CLI_SOURCES.map((src) => {
      touch(repo, src);
      return { path: src, ignored: gitIgnores(env, repo, src) };
    });
    expect(results).toEqual(CLI_SOURCES.map((src) => ({ path: src, ignored: false })));
  });
});

test('REAL git: a global ignore in the ambient HOME cannot decide the negative control', () => {
  requireGit(); // the oracle must be present — never a silent skip
  const poison = mkdtempSync(join(tmpdir(), 'gitignore-poison-'));
  const saved = { home: process.env.HOME, xdg: process.env.XDG_CONFIG_HOME };
  try {
    // A developer's global excludes file, in every default location git may
    // read it from, plus a global config pointing at one explicitly.
    const globalIgnores = [
      join(poison, 'git', 'ignore'),
      join(poison, '.config', 'git', 'ignore'),
      join(poison, 'core-ignore'),
    ];
    for (const file of globalIgnores) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '*.ts\n', 'utf8');
    }
    writeFileSync(
      join(poison, '.gitconfig'),
      `[core]\n\texcludesFile = ${join(poison, 'core-ignore')}\n`,
      'utf8',
    );
    process.env.HOME = poison;
    process.env.XDG_CONFIG_HOME = poison;

    withFixtureRepo((repo, env) => {
      const probe = 'src/cli/init.ts';
      touch(repo, probe);
      // The poison is LIVE: an ambient check-ignore asks the global ignore file
      // and reports the CLI source as ignored.
      expect(gitIgnores(process.env, repo, probe)).toBe(true);
      // The guard's own oracle is hermetic — the same file stays unignored.
      const results = CLI_SOURCES.map((src) => {
        touch(repo, src);
        return { path: src, ignored: gitIgnores(env, repo, src) };
      });
      expect(results).toEqual(CLI_SOURCES.map((src) => ({ path: src, ignored: false })));
    });
  } finally {
    restoreEnv('HOME', saved.home);
    restoreEnv('XDG_CONFIG_HOME', saved.xdg);
    rmSync(poison, { recursive: true, force: true });
  }
});
