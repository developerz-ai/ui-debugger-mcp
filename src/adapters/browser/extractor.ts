/**
 * Browser-side element → {@link RawNode} extraction. Split out of `browser-adapter.ts`
 * to keep that file under the 500-LOC cap — no behavior change.
 */

import type { Node } from '../contract.js';

/** A {@link Node} plus the computed `visible` flag backing the `visible_eq` filter. */
export interface RawNode extends Node {
  visible: boolean;
}

/**
 * Minimal in-page element shape. The DOM lib is off project-wide (Node/Bun only),
 * so we type the handful of members the extractor touches; annotations are erased
 * at runtime, so this never reaches the browser.
 */
interface DomDocument {
  getElementById(id: string): DomEl | null;
  documentElement: DomEl;
  createElement(tag: string): DomEl;
}

interface DomEl {
  tagName: string;
  textContent: string | null;
  readOnly?: boolean;
  labels?: ArrayLike<DomEl> | null;
  parentElement: DomEl | null;
  ownerDocument: DomDocument;
  style: { backgroundColor: string };
  matches(selector: string): boolean;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  appendChild(child: DomEl): void;
  removeChild(child: DomEl): void;
}

/**
 * In-page `window.getComputedStyle`, typed locally (the DOM lib is off project-wide).
 * Resolves to the page global at runtime — the extractor below is serialized into
 * the page, so this stays a free identifier, never a module reference.
 */
declare function getComputedStyle(el: DomEl): {
  display: string;
  visibility: string;
  color: string;
  backgroundColor: string;
};

/**
 * Browser-side element → {@link RawNode} extractor. Playwright serializes this and
 * runs it in the page, so it MUST stay self-contained: no module references, only
 * its params and nested locals. One batched call powers both `find` and
 * `readState`.
 */
export const NODE_EXTRACTOR = (elements: DomEl[]): RawNode[] => {
  const clean = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();

  interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
  }

  const parseColor = (value: string | null | undefined): Rgba | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(
      value ?? '',
    );
    if (!m?.[1] || !m[2] || !m[3]) return null;
    const rawAlpha = m[4];
    const a =
      rawAlpha === undefined
        ? 1
        : rawAlpha.endsWith('%')
          ? Number.parseFloat(rawAlpha) / 100
          : Number.parseFloat(rawAlpha);
    return {
      r: Number.parseFloat(m[1]),
      g: Number.parseFloat(m[2]),
      b: Number.parseFloat(m[3]),
      a,
    };
  };

  // The viewport canvas ("backplate") — the fallback background when no opaque
  // ancestor paints one. Browsers DARKEN this backplate for pages that opt into
  // `color-scheme: dark`, so hard-coding white would mis-judge contrast there.
  // Resolve the CSS system `Canvas` color under the root's used color scheme via
  // a throwaway probe (appended + removed in the same synchronous turn — never
  // painted), degrading to white when `Canvas` is unsupported. Cached: one probe
  // per extraction, not per node.
  let canvasFallback: Rgba | undefined;
  const canvasBackground = (doc: DomDocument): Rgba => {
    if (canvasFallback) return canvasFallback;
    const probe = doc.createElement('div');
    probe.style.backgroundColor = 'Canvas';
    doc.documentElement.appendChild(probe);
    const resolved = parseColor(getComputedStyle(probe).backgroundColor);
    doc.documentElement.removeChild(probe);
    canvasFallback = resolved && resolved.a >= 0.99 ? resolved : { r: 255, g: 255, b: 255, a: 1 };
    return canvasFallback;
  };

  // Nearest opaque ancestor background; else the actual viewport canvas color.
  const effectiveBackground = (el: DomEl): Rgba => {
    let node: DomEl | null = el;
    while (node) {
      const bg = parseColor(getComputedStyle(node).backgroundColor);
      if (bg && bg.a >= 0.99) return bg;
      node = node.parentElement;
    }
    return canvasBackground(el.ownerDocument);
  };

  const luminance = (c: Rgba): number => {
    const chan = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  };

  // WCAG ratio (1–21), with a translucent foreground blended over the background.
  const contrastRatio = (fg: Rgba, bg: Rgba): number => {
    const blended: Rgba =
      fg.a >= 1
        ? fg
        : {
            r: fg.r * fg.a + bg.r * (1 - fg.a),
            g: fg.g * fg.a + bg.g * (1 - fg.a),
            b: fg.b * fg.a + bg.b * (1 - fg.a),
            a: 1,
          };
    const l1 = luminance(blended);
    const l2 = luminance(bg);
    const hi = Math.max(l1, l2);
    const lo = Math.min(l1, l2);
    return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };

  const implicitRole = (el: DomEl): string => {
    const tag = el.tagName.toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'select') return 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'input') {
      const type = (el.getAttribute('type') ?? 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'range') return 'slider';
      if (type === 'button' || type === 'submit' || type === 'reset' || type === 'image') {
        return 'button';
      }
      return 'textbox';
    }
    if (tag === 'button') return 'button';
    if (tag === 'img') return 'img';
    if (tag === 'nav') return 'navigation';
    if (tag === 'main') return 'main';
    if (tag === 'form') return 'form';
    if (
      tag === 'h1' ||
      tag === 'h2' ||
      tag === 'h3' ||
      tag === 'h4' ||
      tag === 'h5' ||
      tag === 'h6'
    ) {
      return 'heading';
    }
    return tag;
  };

  const accessibleName = (el: DomEl): string => {
    const label = clean(el.getAttribute('aria-label'));
    if (label) return label;
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const text = clean(
        labelledby
          .split(/\s+/)
          .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    if (el.labels && el.labels.length > 0) {
      const text = clean(
        Array.from(el.labels)
          .map((l) => l.textContent ?? '')
          .join(' '),
      );
      if (text) return text;
    }
    const placeholder = clean(el.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    const alt = clean(el.getAttribute('alt'));
    if (alt) return alt;
    const text = clean(el.textContent);
    if (text) return text;
    const value = clean(el.getAttribute('value'));
    if (value) return value;
    return clean(el.getAttribute('title'));
  };

  // Contract: `enabled` is "interactable" — false when disabled OR readonly.
  //   - `:disabled` catches the INHERITED state a `disabled` property misses:
  //     controls inside `fieldset[disabled]` (bar its first `<legend>`), options
  //     under a disabled `<optgroup>`.
  //   - `readonly` blocks input without disabling the element, so the driver must
  //     see it as not-interactable too (typing there is a no-op it can't explain).
  //     Assumption: `readOnly` set on a control where HTML ignores it (checkbox,
  //     button) is an authoring mistake — we report it as such rather than guess.
  //   - ARIA equivalents cover custom widgets (`div role="textbox"`), which carry
  //     no native disabled/readonly state at all.
  const interactable = (el: DomEl): boolean =>
    !el.matches(':disabled') &&
    el.getAttribute('aria-disabled') !== 'true' &&
    el.readOnly !== true &&
    el.getAttribute('aria-readonly') !== 'true';

  return elements.map((el) => {
    const r = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    const testid = clean(el.getAttribute('data-testid'));
    const text = clean(el.textContent);
    const node: RawNode = {
      role: clean(el.getAttribute('role')) || implicitRole(el),
      name: accessibleName(el),
      bounds: {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height),
      },
      enabled: interactable(el),
      visible:
        r.width > 0 &&
        r.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        !el.hasAttribute('hidden') &&
        el.getAttribute('aria-hidden') !== 'true',
    };
    if (testid) node.testid = testid;
    if (text) {
      const fg = parseColor(style.color);
      if (fg) {
        const bg = effectiveBackground(el);
        node.style = {
          color: style.color,
          backgroundColor: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
          contrast: contrastRatio(fg, bg),
        };
      }
    }
    return node;
  });
};
