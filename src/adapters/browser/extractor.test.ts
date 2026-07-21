/**
 * {@link NODE_EXTRACTOR} — the in-page element → {@link RawNode} extractor. Exercised
 * directly here (not through a real browser) via a minimal fake DOM matching the
 * `DomEl`/`DomDocument` shapes it actually touches, plus a stubbed global
 * `getComputedStyle` (the extractor is serialized into the page, so it reads that as
 * a free identifier — see `extractor.ts`'s own comment on this).
 *
 * Covers: accessible-name precedence chain, the `implicitRole` tag→role table,
 * `testid` surfacing, and the contrast/style computation path (background-walk,
 * canvas-probe fallback, alpha blending). The one enabled/readonly case previously
 * in `browser-adapter.lifecycle.test.ts` lives here too — same function under test.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { NODE_EXTRACTOR } from './extractor.js';

type FakeElement = Parameters<typeof NODE_EXTRACTOR>[0][number];

interface ComputedStyleShape {
  display: string;
  visibility: string;
  color: string;
  backgroundColor: string;
}

interface ElementSpec {
  tagName: string;
  attrs?: Record<string, string>;
  textContent?: string | null;
  readOnly?: boolean;
  labels?: FakeElement[] | null;
  parentElement?: FakeElement | null;
  disabled?: boolean;
  hidden?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
  bg?: string;
  color?: string;
  display?: string;
  visibility?: string;
}

const computedStyles = new WeakMap<FakeElement, ComputedStyleShape>();

/** One shared fake `document` + element factory, so `getElementById`/canvas-probe calls
 * land on a single owner document across every element created for a test. */
function createWorld() {
  const registry = new Map<string, FakeElement>();
  const appendChildCalls: FakeElement[] = [];
  const removeChildCalls: FakeElement[] = [];
  let createElementCalls = 0;

  const doc = {
    getElementById: (id: string) => registry.get(id) ?? null,
    documentElement: undefined as unknown as FakeElement,
    createElement: (tag: string) => {
      createElementCalls += 1;
      return makeEl({ tagName: tag });
    },
  };

  function makeEl(spec: ElementSpec): FakeElement {
    const attrs = spec.attrs ?? {};
    const el = {
      tagName: spec.tagName,
      textContent: spec.textContent ?? null,
      readOnly: spec.readOnly,
      labels: spec.labels ?? null,
      parentElement: spec.parentElement ?? null,
      ownerDocument: doc,
      style: { backgroundColor: spec.bg ?? 'rgba(0, 0, 0, 0)' },
      matches: (selector: string) => (selector === ':disabled' ? Boolean(spec.disabled) : false),
      getAttribute: (name: string) => attrs[name] ?? null,
      hasAttribute: (name: string) => (name === 'hidden' ? Boolean(spec.hidden) : name in attrs),
      getBoundingClientRect: () => spec.rect ?? { x: 0, y: 0, width: 10, height: 10 },
      appendChild: (child: FakeElement) => {
        appendChildCalls.push(child);
      },
      removeChild: (child: FakeElement) => {
        removeChildCalls.push(child);
      },
    } as unknown as FakeElement;
    computedStyles.set(el, {
      display: spec.display ?? 'block',
      visibility: spec.visibility ?? 'visible',
      color: spec.color ?? 'rgb(0, 0, 0)',
      backgroundColor: spec.bg ?? 'rgba(0, 0, 0, 0)',
    });
    if (attrs.id) registry.set(attrs.id, el);
    return el;
  }

  doc.documentElement = makeEl({ tagName: 'html' });

  return {
    el: makeEl,
    get createElementCalls() {
      return createElementCalls;
    },
    appendChildCalls,
    removeChildCalls,
  };
}

/** What the browser resolves the CSS system `Canvas` color to, for the probe path. */
let canvasResolution = 'rgb(255, 255, 255)';

let restoreComputedStyle: (() => void) | undefined;

beforeEach(() => {
  canvasResolution = 'rgb(255, 255, 255)';
  const globals = globalThis as Record<string, unknown>;
  const previous = globals.getComputedStyle;
  globals.getComputedStyle = (el: FakeElement): ComputedStyleShape => {
    if (el.style.backgroundColor === 'Canvas') {
      return {
        display: 'block',
        visibility: 'visible',
        color: 'rgb(0, 0, 0)',
        backgroundColor: canvasResolution,
      };
    }
    const meta = computedStyles.get(el);
    if (!meta) throw new Error('test bug: no computed-style fixture registered for this element');
    return meta;
  };
  restoreComputedStyle = () => {
    globals.getComputedStyle = previous;
  };
});

afterEach(() => {
  restoreComputedStyle?.();
});

// --- implicitRole table ------------------------------------------------------

test('implicitRole: maps tag (and input type) to the expected ARIA role', () => {
  const world = createWorld();
  const cases: Array<[ElementSpec, string]> = [
    [{ tagName: 'a', attrs: { href: '/x' } }, 'link'],
    [{ tagName: 'a' }, 'generic'],
    [{ tagName: 'select' }, 'combobox'],
    [{ tagName: 'textarea' }, 'textbox'],
    [{ tagName: 'input' }, 'textbox'],
    [{ tagName: 'input', attrs: { type: 'email' } }, 'textbox'],
    [{ tagName: 'input', attrs: { type: 'checkbox' } }, 'checkbox'],
    [{ tagName: 'input', attrs: { type: 'radio' } }, 'radio'],
    [{ tagName: 'input', attrs: { type: 'range' } }, 'slider'],
    [{ tagName: 'input', attrs: { type: 'button' } }, 'button'],
    [{ tagName: 'input', attrs: { type: 'submit' } }, 'button'],
    [{ tagName: 'input', attrs: { type: 'reset' } }, 'button'],
    [{ tagName: 'input', attrs: { type: 'image' } }, 'button'],
    [{ tagName: 'button' }, 'button'],
    [{ tagName: 'img' }, 'img'],
    [{ tagName: 'nav' }, 'navigation'],
    [{ tagName: 'main' }, 'main'],
    [{ tagName: 'form' }, 'form'],
    [{ tagName: 'h1' }, 'heading'],
    [{ tagName: 'h6' }, 'heading'],
    [{ tagName: 'div' }, 'div'],
    [{ tagName: 'span' }, 'span'],
  ];
  const nodes = NODE_EXTRACTOR(cases.map(([spec]) => world.el(spec)));
  expect(nodes.map((n) => n.role)).toEqual(cases.map(([, role]) => role));
});

test('implicitRole: an explicit role attribute overrides the tag-based default', () => {
  const world = createWorld();
  const [n] = NODE_EXTRACTOR([world.el({ tagName: 'button', attrs: { role: 'tab' } })]);
  expect(n?.role).toBe('tab');
});

// --- accessible name precedence chain ----------------------------------------

test('accessible name: aria-label wins over every other source', () => {
  const world = createWorld();
  const el = world.el({
    tagName: 'input',
    attrs: { 'aria-label': 'Search', placeholder: 'ignored', alt: 'ignored', value: 'ignored' },
    textContent: 'ignored',
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('Search');
});

test('accessible name: aria-labelledby (joining multiple referenced ids) wins over <label>/placeholder/alt/text/value/title', () => {
  const world = createWorld();
  world.el({ tagName: 'span', attrs: { id: 'l1' }, textContent: 'Billing' });
  world.el({ tagName: 'span', attrs: { id: 'l2' }, textContent: 'address' });
  const label = world.el({ tagName: 'label', textContent: 'also ignored' });
  const el = world.el({
    tagName: 'input',
    attrs: { 'aria-labelledby': 'l1 l2', placeholder: 'ignored', alt: 'ignored', value: 'ignored' },
    textContent: 'ignored',
    labels: [label],
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('Billing address');
});

test('accessible name: an associated <label> wins over placeholder/alt/text/value/title', () => {
  const world = createWorld();
  const label = world.el({ tagName: 'label', textContent: 'Email address' });
  const el = world.el({
    tagName: 'input',
    attrs: { placeholder: 'ignored', alt: 'ignored', value: 'ignored' },
    textContent: 'ignored',
    labels: [label],
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('Email address');
});

test('accessible name: placeholder wins over alt/text/value/title', () => {
  const world = createWorld();
  const el = world.el({
    tagName: 'input',
    attrs: { placeholder: 'you@example.com', alt: 'ignored', value: 'ignored' },
    textContent: 'ignored',
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('you@example.com');
});

test('accessible name: alt wins over textContent/value/title', () => {
  const world = createWorld();
  const el = world.el({
    tagName: 'img',
    attrs: { alt: 'Company logo', value: 'ignored' },
    textContent: 'ignored',
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('Company logo');
});

test('accessible name: textContent wins over value/title', () => {
  const world = createWorld();
  const el = world.el({
    tagName: 'button',
    attrs: { value: 'ignored', title: 'ignored' },
    textContent: '  Save   now  \n',
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('Save now'); // clean() also collapses/trims whitespace
});

test('accessible name: value wins over title', () => {
  const world = createWorld();
  const el = world.el({ tagName: 'input', attrs: { value: 'submitted', title: 'ignored' } });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('submitted');
});

test('accessible name: title is the last resort', () => {
  const world = createWorld();
  const el = world.el({ tagName: 'div', attrs: { title: 'Tooltip text' } });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('Tooltip text');
});

test('accessible name: empty string when nothing in the chain is present', () => {
  const world = createWorld();
  const el = world.el({ tagName: 'div' });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.name).toBe('');
});

// --- testid -------------------------------------------------------------------

test('testid: data-testid is surfaced (and whitespace-cleaned) as node.testid', () => {
  const world = createWorld();
  const el = world.el({ tagName: 'button', attrs: { 'data-testid': '  save-btn  ' } });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.testid).toBe('save-btn');
});

test('testid: absent entirely (not just falsy) when there is no data-testid attribute', () => {
  const world = createWorld();
  const el = world.el({ tagName: 'button' });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.testid).toBeUndefined();
  expect(Object.hasOwn(n ?? {}, 'testid')).toBe(false);
});

// --- enabled (readonly) contract, moved from browser-adapter.lifecycle.test.ts ----

test('enabled: a readonly input reads enabled:false; a plain one reads enabled:true', () => {
  const world = createWorld();
  const [plain, locked] = NODE_EXTRACTOR([
    world.el({ tagName: 'input' }),
    world.el({ tagName: 'input', readOnly: true }),
  ]);
  expect(plain?.enabled).toBe(true);
  expect(locked?.enabled).toBe(false);
});

// --- contrast/style path -------------------------------------------------------

test('style: omitted entirely when the element has no text content', () => {
  const world = createWorld();
  const [n] = NODE_EXTRACTOR([world.el({ tagName: 'div', textContent: '' })]);
  expect(n?.style).toBeUndefined();
});

test('style: omitted when the computed color is unparseable', () => {
  const world = createWorld();
  const el = world.el({ tagName: 'p', textContent: 'hi', color: 'currentcolor' });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.style).toBeUndefined();
});

test("style: uses the element's own opaque background when present (black-on-white = 21:1)", () => {
  const world = createWorld();
  const el = world.el({
    tagName: 'p',
    textContent: 'hi',
    color: 'rgb(0, 0, 0)',
    bg: 'rgb(255, 255, 255)',
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.style).toEqual({
    color: 'rgb(0, 0, 0)',
    backgroundColor: 'rgb(255, 255, 255)',
    contrast: 21,
  });
});

test('style: walks up to the nearest opaque ancestor background when the element itself is transparent', () => {
  const world = createWorld();
  const parent = world.el({ tagName: 'div', bg: 'rgb(20, 20, 20)' });
  const child = world.el({
    tagName: 'p',
    textContent: 'hi',
    color: 'rgb(255, 255, 255)',
    bg: 'rgba(0, 0, 0, 0)',
    parentElement: parent,
  });
  const [n] = NODE_EXTRACTOR([child]);
  expect(n?.style?.backgroundColor).toBe('rgb(20, 20, 20)');
});

test('style: falls back to the canvas probe background when no ancestor is opaque', () => {
  const world = createWorld();
  canvasResolution = 'rgb(240, 240, 240)';
  const el = world.el({ tagName: 'p', textContent: 'hi', bg: 'rgba(0, 0, 0, 0)' });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.style?.backgroundColor).toBe('rgb(240, 240, 240)');
  expect(world.appendChildCalls).toHaveLength(1);
  expect(world.removeChildCalls).toHaveLength(1);
});

test('style: the canvas probe is created once per extraction, not once per node', () => {
  const world = createWorld();
  const a = world.el({ tagName: 'p', textContent: 'a', bg: 'rgba(0, 0, 0, 0)' });
  const b = world.el({ tagName: 'p', textContent: 'b', bg: 'rgba(0, 0, 0, 0)' });
  NODE_EXTRACTOR([a, b]);
  expect(world.createElementCalls).toBe(1);
});

test('style: canvas fallback degrades to white when Canvas resolves to something non-opaque/unparseable', () => {
  const world = createWorld();
  canvasResolution = 'transparent';
  const el = world.el({ tagName: 'p', textContent: 'hi', bg: 'rgba(0, 0, 0, 0)' });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.style?.backgroundColor).toBe('rgb(255, 255, 255)');
});

test('style: a fully-transparent foreground blends down to exactly the background (alpha applied, not ignored)', () => {
  const world = createWorld();
  // fg alpha 0 → blended color must equal bg exactly → contrast against itself is 1.
  // If alpha were ignored, this red-on-black pair would report a much higher ratio.
  const el = world.el({
    tagName: 'p',
    textContent: 'hi',
    color: 'rgba(255, 0, 0, 0)',
    bg: 'rgb(0, 0, 0)',
  });
  const [n] = NODE_EXTRACTOR([el]);
  expect(n?.style?.color).toBe('rgba(255, 0, 0, 0)');
  expect(n?.style?.contrast).toBe(1);
});

test('style: a partially-translucent foreground changes the contrast ratio from the fully-opaque case', () => {
  const world = createWorld();
  const el = world.el({
    tagName: 'p',
    textContent: 'hi',
    color: 'rgba(255, 255, 255, 0.5)',
    bg: 'rgb(0, 0, 0)',
  });
  const [n] = NODE_EXTRACTOR([el]);
  // Fully-opaque white-on-black would be 21:1; blending the 50%-alpha fg toward
  // black must pull the ratio down, but it's still lighter than the background.
  expect(n?.style?.contrast).toBeGreaterThan(1);
  expect(n?.style?.contrast).toBeLessThan(21);
});
