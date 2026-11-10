/**
 * Doc-path guard: no markdown file may point at a relative path that resolves
 * OUTSIDE the repository root.
 *
 * A doc that names `../ai-task-master` points at a SIBLING CHECKOUT — a path
 * that exists on the machine that wrote the doc and nowhere else. A reader on a
 * fresh clone follows it, finds nothing, and the pointer rots silently. The
 * pointer that does not rot is a public URL; this guard is what keeps the fix
 * from rotting back.
 *
 * The check is ESCAPE-ONLY. Every relative path is resolved against the FILE's
 * own directory; a path that lands outside the repo root is reported. There is
 * NO existence check: the docs name runtime paths that are not repo files
 * (`services/login.ts`, `.dz/ui-debugger/ui-debugger-mcp.json`,
 * `./tmp/ui-debugger-mcp/<project>/`) and those must stay legal.
 *
 * A path is resolved AS WRITTEN — `foo/../../outside.md` is ONE path, not its
 * `../` tail — and it is read ONCE: a link target belongs to the link branch,
 * which strips its anchor, and never to the general scan as well.
 *
 * Its positive controls feed it the PRE-FIX wording — the sibling-checkout
 * bullet, restored into the real CLAUDE.md — so a matcher that quietly stopped
 * matching fails a control instead of passing the guard vacuously.
 */

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** The repository root — the boundary every path in the corpus is measured against. */
const ROOT = resolve(import.meta.dir, '..');

/**
 * Directories the walk never enters — deps, VCS, build output, scratch, and the
 * machine-local tooling dirs `.gitignore` keeps out of the repo. Their markdown
 * is not the repo's markdown, and a stale local index must not fail the guard.
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'tmp',
  'dist',
  'build',
  'coverage',
  '.codegraph',
  '.claude-task-master',
  '.ai-task-master',
]);

/** A URL span — stripped before the scan: a URL is not a filesystem path. */
const URL_SPAN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s)]+/gi;

/** A mailto span — same, not a filesystem path. */
const MAILTO_SPAN = /\bmailto:[^\s)]+/gi;

/** A markdown link or image target — `](target)`. */
const LINK_TARGET = /\]\(\s*([^)\s]+)/g;

/**
 * A relative path token — the run of path characters a path is written with,
 * matched AS WRITTEN. `foo/../../outside.md` is ONE token: matching only its
 * `../` tail drops the leading segments, resolves the path one level too high
 * and reports a path that lands INSIDE the repo as an escape.
 */
const RELATIVE_TOKEN = /[^\s`'"()[\]<>|]+/g;

/**
 * A `..` segment with more path behind it — the only shape that can leave the
 * repo root. A bare `..` in prose is not a path.
 */
const PARENT_SEGMENT = /\.\.\//;

/** Trailing prose punctuation that is not part of a path. */
const TRAILING_NOISE = /[.,;:!?*]+$/;

/**
 * The PRE-FIX reference-repo bullet — the sibling-checkout pointer this guard
 * exists for, verbatim. Restored into the real CLAUDE.md by the mutation
 * control below.
 */
const PRE_FIX_BULLET =
  '- `../ai-task-master` — build template: Bun + TS + Vercel AI SDK, subagent-as-tool, MCP, Zod, Biome.';

/** Every markdown file in the repo — the corpus the guard scans. */
function markdownFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...markdownFiles(path));
      continue;
    }
    if (entry.name.endsWith('.md')) found.push(path);
  }
  return found.sort();
}

/** The 1-based line a character offset sits on. */
function lineOf(text: string, index: number): number {
  return text.slice(0, index).split('\n').length;
}

/** Does a path, resolved against the file's own directory, leave the repo root? */
function escapesRoot(file: string, candidate: string): boolean {
  const resolved = resolve(dirname(file), candidate);
  return resolved !== ROOT && !resolved.startsWith(ROOT + sep);
}

/** Is this link target a file path — not a URL, not an anchor, not root-absolute? */
function isFileTarget(target: string): boolean {
  if (target === '') return false;
  if (target.startsWith('#')) return false;
  if (target.startsWith('/')) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false;
  return true;
}

/** A path in a document that leaves the repo root. */
interface Escape {
  /** 1-based line the path sits on. */
  readonly line: number;
  /** The path as written. */
  readonly path: string;
}

/** A span of a text — an offset and a length. */
interface Span {
  /** 0-based offset of the first character. */
  readonly start: number;
  /** How many characters the span covers. */
  readonly length: number;
}

/** The link-target spans of `text` — the path each `](target)` names. */
function linkTargetSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(LINK_TARGET)) {
    const target = match[1] ?? '';
    if (target === '') continue;
    spans.push({
      start: (match.index ?? 0) + match[0].length - target.length,
      length: target.length,
    });
  }
  return spans;
}

/** `text` with the given spans blanked — the length is kept, so offsets hold. */
function blankSpans(text: string, spans: Span[]): string {
  let out = text;
  for (const span of spans) {
    out = out.slice(0, span.start) + ' '.repeat(span.length) + out.slice(span.start + span.length);
  }
  return out;
}

/** Every path in `text` that leaves the repo root when resolved against `file`. */
function findEscapes(file: string, text: string): Escape[] {
  const escapes: Escape[] = [];
  const seen = new Set<string>();

  const report = (candidate: string, index: number): void => {
    const path = candidate.replace(TRAILING_NOISE, '');
    if (path === '') return;
    if (seen.has(path)) return;
    if (!escapesRoot(file, path)) return;
    seen.add(path);
    escapes.push({ line: lineOf(text, index), path });
  };

  // A stripped span keeps its LENGTH, so the offsets below stay the original
  // ones and the reported line is the line the path is written on.
  const plain = text
    .replace(URL_SPAN, (match) => ' '.repeat(match.length))
    .replace(MAILTO_SPAN, (match) => ' '.repeat(match.length));

  // The general scan skips link targets: a target is read ONCE, by the link
  // branch below, which resolves it as written and strips its anchor.
  const general = blankSpans(plain, linkTargetSpans(plain));
  for (const match of general.matchAll(RELATIVE_TOKEN)) {
    if (!PARENT_SEGMENT.test(match[0])) continue;
    report(match[0], match.index ?? 0);
  }
  for (const match of plain.matchAll(LINK_TARGET)) {
    const target = match[1] ?? '';
    if (!isFileTarget(target)) continue;
    const path = target.split('#')[0]?.split('?')[0] ?? '';
    if (path === '') continue;
    report(path, match.index ?? 0);
  }
  return escapes;
}

test('no markdown file points outside the repository root', () => {
  const files = markdownFiles(ROOT);
  // The anchor: a walk that found nothing must FAIL, not pass vacuously.
  expect(files.length, 'the walk found no markdown file').toBeGreaterThan(10);
  const corpus = files.map((file) => relative(ROOT, file));
  for (const expected of [
    'CLAUDE.md',
    'README.md',
    'docs/idea/models.md',
    'docs/reference.md',
    '.claude/commands/feature.md',
  ]) {
    expect(corpus, `the walk missed ${expected}`).toContain(expected);
  }

  const problems: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    for (const hit of findEscapes(file, text)) {
      const where = relative(ROOT, file);
      problems.push(`${where}:${hit.line}: "${hit.path}" resolves outside the repo root`);
    }
  }
  expect(problems.join('\n')).toBe('');
});

test('the current CLAUDE.md names no path outside the repo root', () => {
  const file = join(ROOT, 'CLAUDE.md');
  const escapes = findEscapes(file, readFileSync(file, 'utf8'));
  expect(escapes.map((hit) => hit.path)).toEqual([]);
});

test('the pre-fix CLAUDE.md bullet is reported (mutation)', () => {
  const file = join(ROOT, 'CLAUDE.md');
  const text = readFileSync(file, 'utf8');
  // A regex, not an exact line: rewording the bullet must not break the guard.
  const mutated = text.replace(/^- .*ai-task-master.*$/m, PRE_FIX_BULLET);
  expect(mutated, 'CLAUDE.md has no reference-repo bullet to mutate').not.toBe(text);
  const escapes = findEscapes(file, mutated);
  expect(escapes.map((hit) => hit.path)).toContain('../ai-task-master');
});

test('a nested file is measured against its own directory', () => {
  const file = join(ROOT, 'docs/idea/models.md');
  // From docs/idea/, `../../../outside` leaves the repo — `../idea/notes.md` does not.
  const escaping = findEscapes(file, 'see `../../../outside/notes.md`').map((hit) => hit.path);
  expect(escaping).toContain('../../../outside/notes.md');
  const inside = findEscapes(file, 'see `../idea/notes.md`').map((hit) => hit.path);
  expect(inside).toEqual([]);
});

test('in-repo ../ links are not reported', () => {
  const cases = [
    ['docs/reference.md', '../PUBLISHING.md'],
    ['docs/adapters-howto.md', '../src/adapters/contract.ts'],
    ['.claude/commands/feature.md', '../../CLAUDE.md'],
    ['.claude/commands/feature.md', '../../docs/idea/architecture.md'],
  ] as const;
  for (const [doc, link] of cases) {
    const file = join(ROOT, doc);
    const text = readFileSync(file, 'utf8');
    expect(text, `${doc} lost its in-repo link`).toContain(link);
    const escapes = findEscapes(file, text).map((hit) => hit.path);
    expect(escapes, `${doc}: "${link}" was reported`).toEqual([]);
  }
});

test('a path is resolved as written, not on its truncated tail', () => {
  // `foo/../../outside.md` from docs/ lands at <root>/outside.md — INSIDE the
  // repo. Resolving only its `../` tail lands one level too high.
  const file = join(ROOT, 'docs/reference.md');
  const escapes = findEscapes(file, 'see `foo/../../outside.md` for details').map(
    (hit) => hit.path,
  );
  expect(escapes).toEqual([]);
});

test('a link target that leaves the repo root is reported', () => {
  // A bare `../` from a root-level doc leaves the repo. Only the link branch
  // sees it — the general scan skips link targets.
  const file = join(ROOT, 'README.md');
  const escapes = findEscapes(file, 'see [x](../) for details').map((hit) => hit.path);
  expect(escapes).toEqual(['../']);
});

test('a link target is read once, with its anchor stripped', () => {
  // The general scan skips link targets, so the link branch owns them: one
  // report, and the anchor is not part of the path.
  const file = join(ROOT, 'README.md');
  const escapes = findEscapes(file, 'see [x](../foo.md#section) for details').map(
    (hit) => hit.path,
  );
  expect(escapes).toEqual(['../foo.md']);
});

test('a link target with an inner .. is resolved as written', () => {
  // `foo/../../outside.md` from docs/ lands at <root>/outside.md — inside.
  const file = join(ROOT, 'docs/reference.md');
  const escapes = findEscapes(file, 'see [x](foo/../../outside.md) for details').map(
    (hit) => hit.path,
  );
  expect(escapes).toEqual([]);
});
