/**
 * Doc-claims guard: the documents that describe what the adapters READ must not
 * promise an automatic vision/OCR fallback — the shipped desktop/android
 * adapters are accessibility-only.
 *
 * What ships: web reads the DOM (CDP), desktop the AT-SPI2 a11y tree, android
 * the uiautomator view hierarchy. There is no OCR, no pixel detector and no
 * set-of-marks route inside an adapter, so a document promising an automatic
 * vision/OCR fallback describes behaviour that does not exist. The one vision
 * path is the agent-level `look` — the driver hands a captured frame to the
 * vision model — and that is a BELT tool, not an adapter fallback.
 *
 * The matcher is plain text over the four documents that carry these claims AND
 * over the adapter source files whose DOC COMMENTS carry the same promise — a
 * promise in a docblock is as false as a promise in a README, and the source is
 * what the next reader opens. Its positive controls feed it the PRE-FIX wording
 * (verbatim excerpts and full pre-fix lines restored into the real files), so a
 * matcher that quietly stopped matching fails a control instead of passing the
 * guard vacuously.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');

/** The documents that describe what the adapters read. */
const DOCS = [
  'CLAUDE.md',
  'README.md',
  'docs/idea/adapters.md',
  'docs/idea/desktop-control.md',
] as const;

/**
 * The adapter source files whose DOC COMMENTS describe what the adapters read.
 *
 * The same forbidden wording is rejected here: a promise in a docblock is as
 * false as a promise in a document, and the source is what the next reader
 * opens. Each of these files must ALSO carry the shipped limit and name the
 * one vision path — a docblock that only DROPS the promise says nothing about
 * what happens instead.
 */
const SOURCES = [
  'src/adapters/contract.ts',
  'src/adapters/desktop/atspi.ts',
  'src/adapters/android/uiautomator.ts',
  'src/adapters/desktop/desktop-adapter.ts',
] as const;

/**
 * Wording that promises an automatic adapter vision/OCR fallback — matched
 * case-insensitively.
 */
const FORBIDDEN = [
  'a11y tree / vision',
  'view hierarchy / vision',
  'else vision',
  'else ocr',
  'fall back to vision',
  'falls back to vision',
  'falling back to vision',
  'vision fallback',
  'vision as the universal fallback',
  'detector + ocr',
  'ocr → set-of-marks',
  'ocr -> set-of-marks',
] as const;

/** The phrase every one of these documents must carry. */
const REQUIRED = 'no automatic vision/OCR fallback';

/** The agent-level vision tool, in backticks. */
const LOOK = '`look`';

/**
 * The PRE-FIX wording — verbatim excerpts of the lines these documents used to
 * carry, each with the promise it made. The positive control below requires the
 * matcher to flag exactly that promise.
 */
const PRE_FIX: ReadonlyArray<readonly [string, string]> = [
  ['| desktop | a11y tree / vision |', 'a11y tree / vision'],
  ['| mobile  | view hierarchy / vision |', 'view hierarchy / vision'],
  ['| a11y node, else vision |', 'else vision'],
  ['| AT-SPI a11y tree, else OCR |', 'else ocr'],
  ['vision as the universal fallback', 'vision as the universal fallback'],
  ['fall back to vision/screenshots', 'fall back to vision'],
  ['detector + OCR → set-of-marks', 'detector + ocr'],
  [
    'Reads/clicks key off AT-SPI screen extents; vision fallback is future work.',
    'vision fallback',
  ],
];

/** Collapse whitespace + case so a phrase split across wrapped lines still matches. */
function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Strip the JSDoc continuation markers (` * `) from a source file.
 *
 * The marker is comment furniture, not content: without stripping it, a phrase
 * that wraps across two comment lines keeps a `*` in the middle of it
 * ("vision/OCR * fallback") and never matches. The markdown documents never
 * go through this — a `*` there is a list bullet, and the documents carry the
 * phrase on one line already.
 */
function stripCommentMarkers(text: string): string {
  return text.replace(/^[ \t]*\*[ \t]?/gm, '');
}

/** The forbidden promises in `text`, verbatim — empty when there are none. */
function forbiddenPromises(text: string): string[] {
  const flat = normalize(text);
  return FORBIDDEN.filter((phrase) => flat.includes(phrase));
}

/**
 * Every claim problem in `text`: a forbidden promise, a missing required
 * phrase, or a missing mention of the agent-level `look`.
 */
function findProblems(label: string, text: string): string[] {
  const flat = normalize(text);
  const problems = forbiddenPromises(text).map((phrase) => `${label}: promises "${phrase}"`);
  if (!flat.includes(REQUIRED.toLowerCase())) {
    problems.push(`${label}: missing the phrase "${REQUIRED}"`);
  }
  if (!flat.includes(LOOK)) problems.push(`${label}: does not name the agent-level ${LOOK}`);
  return problems;
}

test('the adapter docs promise no automatic vision/OCR fallback', () => {
  // The anchor: an empty DOCS list must FAIL, not pass vacuously.
  expect(DOCS.length, 'the guard reads no document').toBe(4);
  for (const doc of DOCS) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    expect(text.length, `${doc}: the document is empty`).toBeGreaterThan(0);
    const problems = findProblems(doc, text);
    expect(problems, `${doc}: ${problems.join(' | ')}`).toEqual([]);
  }
});

test('the adapter docblocks promise no automatic vision/OCR fallback', () => {
  // The anchor: an empty SOURCES list must FAIL, not pass vacuously.
  expect(SOURCES.length, 'the guard reads no source file').toBe(4);
  for (const file of SOURCES) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    expect(text.length, `${file}: the file is empty`).toBeGreaterThan(0);
    const problems = findProblems(file, stripCommentMarkers(text));
    expect(problems, `${file}: ${problems.join(' | ')}`).toEqual([]);
  }
});

test('the adapter docblocks that regain the pre-fix promise are reported', () => {
  // The pre-fix wording, restored into the real files: a docblock promising a
  // '(future) vision fallback' must not pass the gate.
  const atspi = readFileSync(join(ROOT, 'src/adapters/desktop/atspi.ts'), 'utf8');
  const mutatedAtspi = atspi.replace(
    '--force-renderer-accessibility',
    '--force-renderer-accessibility; vision fallback (future)',
  );
  expect(mutatedAtspi, 'atspi.ts has no anchor to mutate').not.toBe(atspi);
  expect(forbiddenPromises(mutatedAtspi)).toContain('vision fallback');

  const desktop = readFileSync(join(ROOT, 'src/adapters/desktop/desktop-adapter.ts'), 'utf8');
  const mutatedDesktop = desktop.replace(
    'Reads/clicks/type key off the AT-SPI tree',
    'Reads/clicks/type key off the AT-SPI tree; vision fallback is future work',
  );
  expect(mutatedDesktop, 'desktop-adapter.ts has no anchor to mutate').not.toBe(desktop);
  expect(forbiddenPromises(mutatedDesktop)).toContain('vision fallback');
});

test('the adapter docblock that loses the shipped limit is reported', () => {
  const atspi = readFileSync(join(ROOT, 'src/adapters/desktop/atspi.ts'), 'utf8');
  const mutated = atspi.replace('no automatic vision/OCR fallback', 'no automatic fallback');
  expect(mutated, 'atspi.ts carries no phrase to mutate').not.toBe(atspi);
  expect(findProblems('src/adapters/desktop/atspi.ts', mutated).join('\n')).toContain(REQUIRED);
});

test('the matcher flags the pre-fix wording it replaced (positive control)', () => {
  for (const [fragment, promise] of PRE_FIX) {
    const flagged = forbiddenPromises(fragment);
    expect(flagged, `pre-fix wording not flagged: ${fragment}`).toContain(promise);
  }
});

test('every forbidden pattern is matched (mutation)', () => {
  for (const phrase of FORBIDDEN) {
    const flagged = forbiddenPromises(`a line promising ${phrase} here`);
    expect(flagged.length, `not matched: ${phrase}`).toBeGreaterThan(0);
  }
});

test('the README that regains the pre-fix table row is reported (mutation)', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // A regex, not an exact cell: re-aligning the table must not break the guard.
  const mutated = readme.replace(/\|(\s*)a11y tree(\s*)\|/, '|$1a11y tree / vision$2|');
  expect(mutated, 'README.md has no "a11y tree" cell to mutate').not.toBe(readme);
  const problems = findProblems('README.md', mutated);
  expect(problems.join('\n')).toContain('a11y tree / vision');
});

test('the adapters doc that regains the pre-fix contract row is reported (mutation)', () => {
  const adapters = readFileSync(join(ROOT, 'docs/idea/adapters.md'), 'utf8');
  const mutated = adapters.replace(
    /\|(\s*)AT-SPI a11y tree(\s*)\|/,
    '|$1AT-SPI a11y tree, else OCR$2|',
  );
  expect(mutated, 'docs/idea/adapters.md has no readState cell to mutate').not.toBe(adapters);
  const problems = findProblems('docs/idea/adapters.md', mutated);
  expect(problems.join('\n')).toContain('else ocr');
});

test('a doc without the required phrase or the agent-level look is reported', () => {
  const problems = findProblems('fixture', 'Desktop reads the a11y tree.');
  expect(problems.join('\n')).toContain(REQUIRED);
  expect(problems.join('\n')).toContain(LOOK);
});
