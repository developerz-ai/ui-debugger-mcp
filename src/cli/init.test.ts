import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ConfigSchema } from '../config/schema.js';
import { InitError } from '../errors.js';
import { runInit } from './init.js';

const TMP = join(import.meta.dir, '__test_init_tmp__');

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

test('creates workspace dir', () => {
  runInit(TMP);
  expect(existsSync(join(TMP, 'tmp', 'ui-debugger-mcp'))).toBe(true);
});

test('writes .ui-debugger-mcp.json when absent', () => {
  runInit(TMP);
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  expect(existsSync(configPath)).toBe(true);
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(parsed).toHaveProperty('models');
  expect(parsed).toHaveProperty('targets.web');
  expect(parsed.targets.web.adapter).toBe('browser');
});

test('the starter config validates against ConfigSchema', () => {
  runInit(TMP);
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  expect(ConfigSchema.safeParse(parsed).success).toBe(true);
});

test('does not overwrite existing .ui-debugger-mcp.json', () => {
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  const original = '{"custom":true}\n';
  writeFileSync(configPath, original, 'utf8');
  runInit(TMP);
  expect(readFileSync(configPath, 'utf8')).toBe(original);
});

test('adds tmp/ to .gitignore when absent', () => {
  runInit(TMP);
  const content = readFileSync(join(TMP, '.gitignore'), 'utf8');
  // Byte-identical: deleting the DEFAULT_WORKSPACE early return would emit the
  // fully-qualified `tmp/ui-debugger-mcp/` here and must fail this.
  expect(content).toBe('tmp/\n');
});

test('does not duplicate tmp/ in existing .gitignore', () => {
  const gitignorePath = join(TMP, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\ntmp/\n', 'utf8');
  runInit(TMP);
  const content = readFileSync(gitignorePath, 'utf8');
  const count = content.split('\n').filter((l) => l.trim() === 'tmp/').length;
  expect(count).toBe(1);
});

test('appends to existing .gitignore without clobbering', () => {
  const gitignorePath = join(TMP, '.gitignore');
  writeFileSync(gitignorePath, 'node_modules/\n', 'utf8');
  runInit(TMP);
  const content = readFileSync(gitignorePath, 'utf8');
  expect(content).toContain('node_modules/');
  expect(content).toContain('tmp/');
});

test('is idempotent (second init is a no-op)', () => {
  runInit(TMP);
  const configBefore = readFileSync(join(TMP, '.ui-debugger-mcp.json'), 'utf8');
  const gitignoreBefore = readFileSync(join(TMP, '.gitignore'), 'utf8');
  runInit(TMP);
  expect(readFileSync(join(TMP, '.ui-debugger-mcp.json'), 'utf8')).toBe(configBefore);
  expect(readFileSync(join(TMP, '.gitignore'), 'utf8')).toBe(gitignoreBefore);
});

test('respects an existing config workspace for mkdir instead of the tmp/ default', () => {
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  writeFileSync(configPath, JSON.stringify({ workspace: './custom-ws', targets: {} }), 'utf8');
  runInit(TMP);
  expect(existsSync(join(TMP, 'custom-ws'))).toBe(true);
  expect(existsSync(join(TMP, 'tmp', 'ui-debugger-mcp'))).toBe(false);
});

test('respects an existing config workspace for gitignore instead of tmp/', () => {
  const configPath = join(TMP, '.ui-debugger-mcp.json');
  writeFileSync(configPath, JSON.stringify({ workspace: './custom-ws', targets: {} }), 'utf8');
  runInit(TMP);
  const content = readFileSync(join(TMP, '.gitignore'), 'utf8');
  expect(content).toContain('custom-ws/');
});

// --- custom workspace names that are gitignore syntax: gitignore(5) reads a
// leading `#` as a comment, a leading `!` as a negation, `*?[]` as globs and
// trims trailing spaces — so the line for such a workspace must be the
// backslash-escaped LITERAL path, or it ignores the wrong things.

test('escapes gitignore metacharacters in a custom workspace .gitignore line', () => {
  const cases: Array<[workspace: string, expectedLine: string]> = [
    ['./#ws', '\\#ws/'], // raw `#ws/` is a comment — matches nothing
    ['./!ws', '\\!ws/'], // raw `!ws/` is a negation — ignores nothing
    ['./ws*x', 'ws\\*x/'], // raw `ws*x/` glob-matches wsXYZx, ws123x, ...
    ['./a?b', 'a\\?b/'], // raw `a?b/` glob-matches axb, a?b, ...
    ['./a\\b', 'a\\\\b/'], // raw `a\b/` reads \b as an escaped b — matches dir ab
    ['./ws[x', 'ws\\[x/'], // raw `ws[x/` reads [ as a glob class opener
    ['./my ws', 'my\\ ws/'], // a raw trailing space gets trimmed by git
  ];
  cases.forEach(([workspace, expectedLine], i) => {
    const dir = join(TMP, `case-${i}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '.ui-debugger-mcp.json'),
      JSON.stringify({ workspace, targets: {} }),
      'utf8',
    );
    captureInit(dir);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').trim().split('\n')).toEqual([
      expectedLine,
    ]);
  });
});

test('fails loud instead of writing a corrupt .gitignore for a workspace with a line break', () => {
  // gitignore(5) is line-based: a workspace path containing \n (legal JSON)
  // would append two unrelated rules (`a`, `b/`) while the real workspace stays
  // tracked. Init must throw InitError naming the workspace, BEFORE any
  // .gitignore is written.
  writeFileSync(
    join(TMP, '.ui-debugger-mcp.json'),
    JSON.stringify({ workspace: './a\nb', targets: {} }),
    'utf8',
  );
  expect(() => runInit(TMP)).toThrow(InitError);
  expect(() => runInit(TMP)).toThrow('"./a\\nb"');
  expect(existsSync(join(TMP, '.gitignore'))).toBe(false);
});

// --- REAL git check-ignore ---------------------------------------------------
//
// chromium-libs style: drive the real binary and return silently when the
// oracle is missing. Exit statuses are pinned exactly — 0 means ignored, ONLY
// 1 means not ignored, anything else throws, so a usage/protocol error can
// never be read as a pass.

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
 * `git check-ignore -q -- <p>` in `repo`: true on exit 0 (ignored), false ONLY
 * on exit 1 (not ignored), throws on anything else — an unrelated failure must
 * never be read as a pass.
 */
function gitIgnores(repo: string, p: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', '--', p], {
      cwd: repo,
      stdio: ['ignore', 'pipe', 'pipe'],
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

test('REAL git: the escaped workspace line ignores the literal dir, not the decoys the raw names would hit', () => {
  if (!gitAvailable()) return; // no git on PATH — oracle absent, skip silently

  // One fresh git repo per workspace; each config names ONE workspace.
  const repos: Array<{ ws: string; contents: string[]; decoys: string[] }> = [
    {
      ws: './#ws',
      contents: ['#ws/inner.txt'],
      decoys: ['ws/inner.txt', 'X#ws/inner.txt'],
    },
    { ws: './!ws', contents: ['!ws/inner.txt'], decoys: [] },
    {
      ws: './ws*x',
      contents: ['ws*x/f.txt'],
      decoys: ['wsXYZx/f.txt'],
    },
    { ws: './a?b', contents: ['a?b/f.txt'], decoys: [] },
    {
      ws: './a\\b',
      contents: ['a\\b/f.txt'],
      decoys: ['ab/f.txt'], // unescaped `a\b/` reads \b as b — this dir
    },
    {
      ws: './a[b]c',
      contents: ['a[b]c/f.txt'],
      decoys: ['abc/f.txt'], // unescaped `[b]` is a one-char class — this dir
    },
    { ws: './my ws', contents: ['my ws/inner.txt'], decoys: [] },
  ];

  for (const [i, { ws, contents, decoys }] of repos.entries()) {
    const repo = join(TMP, `repo-${i}`);
    mkdirSync(repo, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
    writeFileSync(
      join(repo, '.ui-debugger-mcp.json'),
      JSON.stringify({ workspace: ws, targets: {} }),
      'utf8',
    );
    captureInit(repo);

    for (const p of [...contents, ...decoys]) touch(repo, p);
    for (const p of contents) {
      expect(gitIgnores(repo, p)).toBe(true); // workspace contents ignored
    }
    for (const p of decoys) {
      expect(gitIgnores(repo, p)).toBe(false); // decoys stay unignored
    }
  }
});

test('does not write .mcp.json or any API key to disk (snippet is stdout-only)', () => {
  runInit(TMP);
  // The .mcp.json snippet is only printed, never written.
  expect(existsSync(join(TMP, '.mcp.json'))).toBe(false);
  // The project config written to disk contains no API key or secret.
  const config = readFileSync(join(TMP, '.ui-debugger-mcp.json'), 'utf8');
  expect(config).not.toContain('OPENAI_API_KEY');
  expect(config).not.toContain('sk-');
  // Placeholder in the snippet must remain a placeholder, not a real value.
  expect(config).not.toContain('<your-key-here>');
});

test('the printed .mcp.json snippet pins @latest — a bare spec sticks on a cached version', () => {
  // `npx -y <pkg>` reuses whatever is already in ~/.npm/_npx, so an unpinned spec
  // keeps booting the first version ever installed with no signal it is stale: a
  // client was observed still launching 1.4.0 days after 1.5.0 shipped. Nothing in
  // the server checks the registry, so the pin IS the update mechanism.
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    runInit(TMP);
  } finally {
    console.log = original;
  }
  const printed = lines.join('\n');
  expect(printed).toContain('"@developerz.ai/ui-debugger-mcp@latest"');
  expect(printed).not.toContain('"@developerz.ai/ui-debugger-mcp"');
});

// --- dual-candidate config: `.dz/ui-debugger/ui-debugger-mcp.json` first, root
// `.ui-debugger-mcp.json` as the legacy fallback.

const DZ_CONFIG = '.dz/ui-debugger/ui-debugger-mcp.json';

/** Write `contents` at a candidate-relative path under TMP, creating parents. */
function writeCandidate(rel: string, contents: string): void {
  const path = join(TMP, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf8');
}

/** Run init with console.log captured; returns the printed lines. */
function captureInit(dir: string = TMP): string[] {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.join(' '));
  try {
    runInit(dir);
  } finally {
    console.log = original;
  }
  return lines;
}

test('writes the starter config under .dz/ when the repo already has a .dz/ dir', () => {
  mkdirSync(join(TMP, '.dz'), { recursive: true });
  runInit(TMP);
  expect(existsSync(join(TMP, DZ_CONFIG))).toBe(true);
  // The legacy root file is not created alongside the .dz/ one.
  expect(existsSync(join(TMP, '.ui-debugger-mcp.json'))).toBe(false);
});

test('writes the starter config at the root when no .dz/ dir exists', () => {
  runInit(TMP);
  expect(existsSync(join(TMP, '.ui-debugger-mcp.json'))).toBe(true);
  expect(existsSync(join(TMP, '.dz'))).toBe(false);
});

test('the workspace read prefers the .dz/ copy when both exist', () => {
  writeCandidate(DZ_CONFIG, JSON.stringify({ workspace: './ws-dz', targets: {} }));
  writeFileSync(
    join(TMP, '.ui-debugger-mcp.json'),
    JSON.stringify({ workspace: './ws-root', targets: {} }),
    'utf8',
  );
  runInit(TMP);
  expect(existsSync(join(TMP, 'ws-dz'))).toBe(true);
  expect(existsSync(join(TMP, 'ws-root'))).toBe(false);
});

test('both present: .dz/ wins, is never overwritten, and exactly one notice names the ignored root file', () => {
  const dzContents = '{"workspace":"./ws-dz","targets":{}}\n';
  writeCandidate(DZ_CONFIG, dzContents);
  writeFileSync(
    join(TMP, '.ui-debugger-mcp.json'),
    '{"workspace":"./ws-root","targets":{}}',
    'utf8',
  );

  const lines = captureInit();

  expect(readFileSync(join(TMP, DZ_CONFIG), 'utf8')).toBe(dzContents);
  const notices = lines.filter((l) => l.includes('.ui-debugger-mcp.json') && l.includes('ignor'));
  expect(notices.length).toBe(1);
  expect(notices[0]).toContain(DZ_CONFIG);
});

test('only-if-absent honoured for the found candidate: an existing .dz/ copy is never overwritten', () => {
  const original = '{"custom":true}\n';
  writeCandidate(DZ_CONFIG, original);
  runInit(TMP);
  expect(readFileSync(join(TMP, DZ_CONFIG), 'utf8')).toBe(original);
});
