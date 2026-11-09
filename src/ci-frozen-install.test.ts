import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// CI and release must never rewrite bun.lock: every dependency install is
// `--frozen-lockfile`, so a drifted lockfile fails the job. Structure is
// parsed, not substring-matched: comments are dropped first, and commands are
// found as tokens inside `&&` / `||` / `;` / `|` chains.
//
// The scan covers EVERY code line of EVERY workflow file, not only the jobs
// named below: a job added later — in ci.yml, in release.yml or in a workflow
// file that does not exist yet — must not be able to install unfrozen. The
// per-job minimums stay: they pin how many installs each known job runs, so a
// commented-out install cannot satisfy a count.

const WORKFLOW_DIR = join(import.meta.dirname, '../.github/workflows');
const read = (file: string) => readFileSync(join(WORKFLOW_DIR, file), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');

/** Every workflow file in the repo — a workflow added later is covered too. */
const workflows = readdirSync(WORKFLOW_DIR)
  .filter((file) => file.endsWith('.yml') || file.endsWith('.yaml'))
  .map((file) => ({ file, text: read(file) }));

/** Every code line of a workflow: blanks and comments removed. */
function codeLines(workflow: string): string[] {
  return workflow
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ''));
}

/** The lines of one two-space-indented job, comments and blanks removed. */
function jobCode(workflow: string, job: string): string[] {
  const lines = codeLines(workflow);
  const start = lines.findIndex((line) => line === `  ${job}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {2}[\w-]+:/.test(line) || /^\S/.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

type BunCommand = { verb: string; flags: string[] };

const MUTATING = new Set(['add', 'a', 'update', 'up', 'upgrade', 'remove', 'rm']);
const INSTALLING = new Set(['install', 'i', ...MUTATING]);

/** Every `bun <install|i|add|update|…>` command on the code lines. */
function bunCommands(code: string[]): BunCommand[] {
  const found: BunCommand[] = [];
  for (const line of code) {
    for (const segment of line.split(/&&|\|\||;|\|/)) {
      const m = segment.match(/(?:^|\s)bun\s+([a-z]+)(?=\s|$)(.*)$/);
      if (m?.[1] && INSTALLING.has(m[1])) {
        found.push({ verb: m[1], flags: (m[2] ?? '').trim().split(/\s+/) });
      }
    }
  }
  return found;
}

/**
 * Every install on these code lines is frozen, and there are at least
 * `minInstalls` of them — so a commented-out install satisfies no count.
 */
function assertFrozen(code: string[], minInstalls = 0) {
  const commands = bunCommands(code);
  expect(commands.length).toBeGreaterThanOrEqual(minInstalls);
  for (const { verb, flags } of commands) {
    expect(MUTATING.has(verb)).toBe(false);
    expect(flags).toContain('--frozen-lockfile');
  }
}

describe('workflow installs are frozen', () => {
  test('ci.yml bun job: root + dummy/web installs', () => {
    const code = jobCode(ci, 'bun');
    assertFrozen(code, 2);
    // One of them is the dummy/web install, chained with its build.
    expect(code).toContain('        working-directory: dummy/web');
  });

  test('ci.yml pack-smoke job', () => {
    assertFrozen(jobCode(ci, 'pack-smoke'), 1);
  });

  test('release.yml publish job', () => {
    assertFrozen(jobCode(release, 'publish'), 1);
  });
});

describe('every install in every workflow is frozen', () => {
  test('every workflow file is scanned, and the set is not empty', () => {
    const files = workflows.map((entry) => entry.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files).toContain('ci.yml');
    expect(files).toContain('release.yml');
  });

  for (const { file, text } of workflows) {
    test(`${file}: every code line, not only the jobs above`, () => {
      assertFrozen(codeLines(text));
    });
  }
});

describe('the guard fails on mutated workflows', () => {
  const bare = 'run: bun install --frozen-lockfile\n';
  const mutate = (replacement: string) => {
    const mutated = ci.replace(bare, replacement);
    expect(mutated).not.toBe(ci);
    return jobCode(mutated, 'bun');
  };

  test('baseline passes', () => {
    expect(() => assertFrozen(jobCode(ci, 'bun'), 2)).not.toThrow();
  });

  test('a bare `bun install` fails', () => {
    expect(() => assertFrozen(mutate('run: bun install\n'), 2)).toThrow();
  });

  test('a bare `bun install` chained after && fails', () => {
    expect(() => assertFrozen(mutate('run: bun run lint && bun install\n'), 2)).toThrow();
  });

  test('a bare `bun i` fails', () => {
    expect(() => assertFrozen(mutate('run: bun i\n'), 2)).toThrow();
  });

  test('--no-frozen-lockfile fails', () => {
    expect(() => assertFrozen(mutate('run: bun install --no-frozen-lockfile\n'), 2)).toThrow();
  });

  test('a commented-out frozen install beside a bare one fails', () => {
    const code = mutate('run: bun install # --frozen-lockfile\n');
    expect(() => assertFrozen(code, 2)).toThrow();
    const above = mutate('# run: bun install --frozen-lockfile\n        run: bun install\n');
    expect(() => assertFrozen(above, 2)).toThrow();
  });

  test('`bun add` / `bun update` fails even when frozen', () => {
    expect(() => assertFrozen(mutate('run: bun add left-pad --frozen-lockfile\n'), 2)).toThrow();
    expect(() => assertFrozen(mutate('run: bun update --frozen-lockfile\n'), 2)).toThrow();
  });

  test('a commented-out install leaves too few installs and fails', () => {
    expect(() => assertFrozen(mutate('# run: bun install --frozen-lockfile\n'), 2)).toThrow();
  });

  test('a bare install in release.yml fails', () => {
    const mutated = release.replace(bare, 'run: bun install\n');
    expect(mutated).not.toBe(release);
    expect(() => assertFrozen(jobCode(mutated, 'publish'), 1)).toThrow();
  });
});

describe('the whole-workflow guard fails on a job the per-job slices miss', () => {
  /** A job added after the fact, installing without the frozen flag. */
  const NEW_JOB = [
    '  extra-job:',
    '    runs-on: ubuntu-22.04',
    '    steps:',
    '      - name: install',
    '        run: bun install',
    '',
  ].join('\n');

  const withNewJob = (workflow: string): string => {
    const mutated = workflow.replace('\njobs:\n', `\njobs:\n${NEW_JOB}`);
    expect(mutated).not.toBe(workflow);
    return mutated;
  };

  test('baseline passes', () => {
    expect(() => assertFrozen(codeLines(ci))).not.toThrow();
    expect(() => assertFrozen(codeLines(release))).not.toThrow();
  });

  test('a new ci.yml job with a bare `bun install` fails', () => {
    const mutated = withNewJob(ci);
    // The per-job slice the old guard used cannot see the new job — the
    // whole-file scan is what catches it.
    expect(() => assertFrozen(jobCode(mutated, 'bun'), 2)).not.toThrow();
    expect(() => assertFrozen(codeLines(mutated))).toThrow();
  });

  test('a new release.yml job with a bare `bun install` fails', () => {
    const mutated = withNewJob(release);
    expect(() => assertFrozen(jobCode(mutated, 'publish'), 1)).not.toThrow();
    expect(() => assertFrozen(codeLines(mutated))).toThrow();
  });
});
