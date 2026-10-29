/**
 * Doc-sync guard for the attach-adoption contract + the shipped behavior itself.
 *
 * Attach adopts the FIRST tab of the FIRST browser context — `lifecycle.ts`'
 * `browser.contexts()[0] ?? (await browser.newContext())`, then
 * `context.pages()[0] ?? (await context.newPage())` — and never by active tab
 * or URL. That policy is a promise to the reader of `docs/idea/adapters.md`
 * (an attach run takes over a tab you did not choose, in a browser you did not
 * start), so the paragraph names the exact lines it documents and this guard
 * holds the two together:
 *
 *  - the paragraph keeps the policy wording, verbatim;
 *  - it embeds the `src/adapters/browser/lifecycle.ts:<lines>` anchor EXACTLY
 *    once, and the anchored span still holds BOTH first-element expressions —
 *    an edit that moves the adoption must move the anchor to pass;
 *  - the behavior the paragraph documents still ships: with two contexts and
 *    two pages in the first, `BrowserAdapter.create` adopts the first
 *    context's first page, not a target-URL decoy, creating nothing.
 *
 * Shape copied from `src/config/doc-defaults.test.ts`: the assert function
 * takes the doc text and the code lines as parameters, so every rejection test
 * feeds it a mutated copy and watches it throw — a guard that cannot fail
 * guards nothing.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { WebTarget } from '../../config/schema.js';
import { BrowserAdapter } from './browser-adapter.js';

/** The injectable `chromium` seam's type, lifted off `BrowserAdapter.create` itself. */
type Launcher = NonNullable<Parameters<typeof BrowserAdapter.create>[0]['chromium']>;

// This file sits two levels under the repo root (`src/adapters/browser/`) — one
// deeper than `doc-defaults.test.ts`, whose `../..` root it copies.
const ROOT = join(import.meta.dir, '../../..');
const DOC = 'docs/idea/adapters.md';
const CODE = 'src/adapters/browser/lifecycle.ts';

/** The policy wording the attach paragraph must keep, verbatim. */
const POLICY = [
  'first tab in the first available browser context',
  'not active-tab or URL-based',
] as const;

/** The doc's pin on the code: a `file:line` or `file:start-end` span, in backticks. */
const ANCHOR = /`src\/adapters\/browser\/lifecycle\.ts:(\d+)(?:-(\d+))?`/g;

/** The single-anchor form, for splicing mutations into a copy of the doc. */
const ANCHOR_ONE = /`src\/adapters\/browser\/lifecycle\.ts:\d+(?:-\d+)?`/;

/** The adoption expressions the anchored span of the code must still hold. */
const ADOPTION = [/browser\.contexts\(\)\[0\]/, /context\.pages\(\)\[0\]/] as const;

function readDoc(): string {
  return readFileSync(join(ROOT, DOC), 'utf8');
}

function codeLines(): string[] {
  return readFileSync(join(ROOT, CODE), 'utf8').split('\n');
}

/**
 * Assert the attach-adoption paragraph pins the adoption the code ships.
 *
 * Throws on drift: a lost policy phrase, a lost or duplicated anchor, an
 * anchor outside the file, or an anchored span that no longer holds BOTH
 * first-element expressions. Parameters, not file reads — the rejection tests
 * feed mutated copies and watch this throw.
 */
function assertAdoptionDoc(docText: string, lines: readonly string[]): void {
  for (const phrase of POLICY) {
    if (!docText.includes(phrase)) {
      throw new Error(`${DOC}: lost the attach-adoption policy wording "${phrase}"`);
    }
  }
  const matches = [...docText.matchAll(ANCHOR)];
  if (matches.length === 0) {
    throw new Error(
      `${DOC}: embeds no \`src/adapters/browser/lifecycle.ts:<lines>\` anchor — the adoption policy is unpinned`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `${DOC}: embeds the lifecycle.ts anchor ${matches.length} times — ambiguous which lines it pins`,
    );
  }
  for (const match of matches) {
    const start = Number(match[1]);
    const end = match[2] === undefined ? start : Number(match[2]);
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 1 ||
      end < start ||
      end > lines.length
    ) {
      throw new Error(
        `${DOC}: anchors lifecycle.ts:${match[1]}${match[2] === undefined ? '' : `-${match[2]}`}` +
          ` — outside the file's ${lines.length} lines`,
      );
    }
    const span = lines.slice(start - 1, end).join('\n');
    for (const expression of ADOPTION) {
      if (!expression.test(span)) {
        throw new Error(
          `${DOC}: anchors lifecycle.ts:${start}-${end}, which no longer holds the adoption ` +
            `(${expression}) — move the anchor or restore the code`,
        );
      }
    }
  }
}

// --- the real doc against the real code -----------------------------------------

test('the attach-adoption paragraph pins the adoption lifecycle.ts ships', () => {
  expect(() => assertAdoptionDoc(readDoc(), codeLines())).not.toThrow();
});

// --- mutated docs: the guard must reject every drift -----------------------------

test('the guard rejects a doc that loses the first-tab policy wording', () => {
  const docText = readDoc();
  const lines = codeLines();
  for (const phrase of POLICY) {
    const mutated = docText.split(phrase).join('');
    expect(mutated).not.toBe(docText);
    expect(() => assertAdoptionDoc(mutated, lines)).toThrow(/policy wording/);
  }
});

test('the guard rejects a doc that drops the code anchor', () => {
  const docText = readDoc();
  const mutated = docText.replace(ANCHOR_ONE, '`lifecycle.ts`');
  expect(mutated).not.toBe(docText);
  expect(() => assertAdoptionDoc(mutated, codeLines())).toThrow(/embeds no .*anchor/);
});

test('the guard rejects a doc that states the anchor twice', () => {
  const docText = readDoc();
  const mutated = docText.replace(ANCHOR_ONE, (anchor) => `${anchor} (repeated: ${anchor})`);
  expect(mutated).not.toBe(docText);
  expect(() => assertAdoptionDoc(mutated, codeLines())).toThrow(/ambiguous/);
});

test('the guard rejects an anchor that drifted off the adoption lines', () => {
  const docText = readDoc();
  const mutated = docText.replace('lifecycle.ts:138-139', 'lifecycle.ts:150-151');
  expect(mutated).not.toBe(docText);
  // +12 lands in range, so this exercises the CONTENT check: lines 150-151 hold
  // neither first-element expression.
  expect(() => assertAdoptionDoc(mutated, codeLines())).toThrow(/no longer holds the adoption/);
});

test('the guard rejects an anchor pointing outside lifecycle.ts', () => {
  const docText = readDoc();
  const mutated = docText.replace('lifecycle.ts:138-139', 'lifecycle.ts:999-1000');
  expect(mutated).not.toBe(docText);
  expect(() => assertAdoptionDoc(mutated, codeLines())).toThrow(/outside the file/);
});

test('the guard rejects code that drifted off first-element adoption', () => {
  const docText = readDoc();
  const original = codeLines();
  for (const [from, to] of [
    ['browser.contexts()[0]', 'browser.contexts()[1]'],
    ['context.pages()[0]', 'context.pages()[1]'],
  ] as const) {
    const mutated = original.map((line) => line.split(from).join(to));
    expect(mutated.join('\n')).not.toBe(original.join('\n'));
    expect(() => assertAdoptionDoc(docText, mutated)).toThrow(/no longer holds the adoption/);
  }
});

// --- the shipped behavior the paragraph documents --------------------------------

const TARGET_URL = 'http://localhost:5173';

const webTarget = (over: Partial<WebTarget> = {}): WebTarget => ({
  adapter: 'browser',
  url: TARGET_URL,
  headless: true,
  ...over,
});

/**
 * Minimal Playwright `Page` stand-in — same shape `attach-restore.test.ts`
 * uses: mutable address, `goto` spy, inert listeners.
 */
function fakePage(url: string, events: string[]) {
  const state = {
    url,
    /** Every `goto` the adapter made on this page, in order. */
    gotos: [] as Array<{ url: string }>,
  };
  const page = {
    on: () => undefined,
    off: () => undefined,
    bringToFront: async () => undefined, // selectTab asks the driven tab to front
    url: () => state.url,
    goto: async (target: string) => {
      state.gotos.push({ url: target });
      state.url = target; // a real `goto` changes the address
      events.push(`goto:${target}`);
    },
  };
  return { page, state };
}

test('attach adopts the first context’s first page — target-URL decoys are untouched, nothing is created', async () => {
  const events: string[] = [];
  // The adopted tab sits on its own pre-run address, NOT the target's.
  const adopted = fakePage('http://127.0.0.1:9222/dashboard', events);
  // Both decoys sit ON the target's URL: URL-based selection would pick one of
  // these instead of the tab attach is documented to take. One is a LATER tab
  // of the first context, one lives in the SECOND context.
  const laterTabDecoy = fakePage(`${TARGET_URL}/`, events);
  const secondContextDecoy = fakePage(`${TARGET_URL}/`, events);
  let newContextCalls = 0;
  let newPageCalls = 0;
  const first = {
    pages: () => [adopted.page, laterTabDecoy.page],
    newPage: async () => {
      newPageCalls += 1;
      return laterTabDecoy.page;
    },
  };
  const second = {
    pages: () => [secondContextDecoy.page],
    newPage: async () => {
      newPageCalls += 1;
      return secondContextDecoy.page;
    },
  };
  const browser = {
    contexts: () => [first, second],
    newContext: async () => {
      newContextCalls += 1;
      return second;
    },
    close: async () => undefined,
  };
  const chromium = {
    connectOverCDP: async () => browser,
  } as unknown as Launcher;

  const adapter = await BrowserAdapter.create({
    config: webTarget({ cdpUrl: 'http://127.0.0.1:9222' }),
    profileDir: '/tmp/unused-profile',
    chromium,
  });

  // The run's first navigation goes to the ADOPTED tab — the first context's
  // first page, whatever its address.
  await adapter.open('/inbox');

  expect(adopted.state.gotos).toEqual([{ url: 'http://localhost:5173/inbox' }]);
  // The decoys were never navigated — attach did not hunt by URL or tab order.
  expect(laterTabDecoy.state.gotos).toEqual([]);
  expect(secondContextDecoy.state.gotos).toEqual([]);
  // Adoption created nothing: the context and the tab already existed.
  expect(newContextCalls).toBe(0);
  expect(newPageCalls).toBe(0);
});
