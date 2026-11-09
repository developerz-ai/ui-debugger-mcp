import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// CI and release must never rewrite bun.lock: every dependency install is
// `--frozen-lockfile`, so a drifted lockfile fails the job. Structure is
// parsed, not substring-matched: comments are dropped first, and commands are
// found as tokens inside `&&` / `||` / `;` / `|` chains.

const read = (file: string) =>
  readFileSync(join(import.meta.dirname, '../.github/workflows', file), 'utf8');
const ci = read('ci.yml');
const release = read('release.yml');

/** The lines of one two-space-indented job, comments and blanks removed. */
function jobCode(workflow: string, job: string): string[] {
  const lines = workflow
    .split('\n')
    .filter((line) => line.trim() !== '' && !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ''));
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

function assertFrozen(code: string[], minInstalls: number) {
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
