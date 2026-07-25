/**
 * Coordinates, frames and node shaping for the browser adapter — the pure
 * geometry the page-driving class leans on. Split out of `browser-adapter.ts`
 * to keep that file under the 500-LOC cap (same split `filters.ts` got), no
 * behavior change.
 *
 * Two themes:
 *   - **the viewport**: is a point actually on screen, which way does a wheel go;
 *   - **frames**: where a child document's viewport sits in PAGE coordinates,
 *     and whether a mid-read failure was a frame going away or a real error.
 */

import type { Frame } from 'playwright-core';
import { AdapterError } from '../../errors.js';
import type { Node, ScrollDirection } from '../contract.js';
import type { RawNode } from './extractor.js';

/**
 * True when `point` falls outside a non-null `viewport`. Coordinate clicks use
 * viewport-relative bounds (`getBoundingClientRect`), so an off-screen center
 * dispatches a CDP click that lands on nothing — silently. A null viewport means
 * the size could not be established AT ALL (see {@link BrowserAdapter.viewport},
 * which falls back to the page's own `innerWidth/Height` first) → never outside;
 * we can't judge.
 */
export function isOutsideViewport(
  point: { x: number; y: number },
  viewport: { width: number; height: number } | null,
): boolean {
  if (!viewport) return false;
  return point.x < 0 || point.x > viewport.width || point.y < 0 || point.y > viewport.height;
}

/**
 * Map a {@link ScrollDirection} + pixel `amount` onto Playwright wheel deltas
 * `[deltaX, deltaY]` (the viewport scrolls toward that edge). Fails loud on an
 * unrecognized direction — the switch is exhaustive over the union, so a bad
 * value can only arrive from an unchecked boundary.
 */
export function scrollDelta(direction: ScrollDirection, amount: number): [number, number] {
  switch (direction) {
    case 'up':
      return [0, -amount];
    case 'down':
      return [0, amount];
    case 'left':
      return [-amount, 0];
    case 'right':
      return [amount, 0];
    default: {
      const unreachable: never = direction;
      throw new AdapterError(`unknown scroll direction: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * In-page viewport probe — `innerWidth/Height` read off the page itself. Reaches
 * the globals through `globalThis` because the DOM lib is off project-wide; the
 * function is serialized into the page, so it must stay self-contained.
 */
export const VIEWPORT_PROBE = (): { width: number; height: number } => {
  const w = globalThis as unknown as { innerWidth: number; innerHeight: number };
  return { width: w.innerWidth, height: w.innerHeight };
};

/** Playwright's wording for "the document I was reading went away mid-read". */
const FRAME_GONE =
  /frame was detached|execution context was destroyed|frame got detached|target (page, context or browser )?has been closed|target closed/i;

/**
 * True when a per-frame read failed because that FRAME vanished (navigation, an
 * ad slot recycling itself), which is one document out of many and not an error.
 *
 * Anything else — an invalid selector above all, the jQuery-ism `div:contains(…)`
 * an LLM emits constantly — is the caller's own mistake and must surface: swallowed,
 * it reads back as `{count: 0}`, i.e. "the element does not exist", while `click()`
 * with the same selector reports the real reason. `detached` is the frame's own
 * live state, checked in addition to the message.
 */
export function isFrameGone(error: unknown, detached: boolean): boolean {
  if (detached) return true;
  return FRAME_GONE.test(error instanceof Error ? error.message : String(error));
}

/**
 * True when a Playwright call failed by RUNNING OUT OF TIME rather than by being
 * wrong — the one failure a cross-frame poll retries instead of surfacing.
 * Playwright brands those as `TimeoutError`.
 */
export function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === 'TimeoutError';
}

/** Drop the internal `visible` flag — the public contract returns plain {@link Node}s. */
export function toNode(node: RawNode): Node {
  const out: Node = {
    role: node.role,
    name: node.name,
    bounds: node.bounds,
    enabled: node.enabled,
  };
  if (node.testid) out.testid = node.testid;
  if (node.style) out.style = node.style;
  if (node.frame) out.frame = node.frame;
  // Empty string and `false` are real answers here ("the field is empty", "the box
  // is unchecked") — test for presence, never truthiness.
  if (node.value !== undefined) out.value = node.value;
  if (node.checked !== undefined) out.checked = node.checked;
  return out;
}

/**
 * The iframe element's own content origin relative to its border box: the
 * border + padding inset, typed locally (the DOM lib is off project-wide) and
 * serialized into the page by Playwright.
 */
interface FrameBox {
  x: number;
  y: number;
}
declare function getComputedStyle(el: unknown): {
  borderLeftWidth: string;
  borderTopWidth: string;
  paddingLeft: string;
  paddingTop: string;
};
const FRAME_INSET = (el: unknown): FrameBox => {
  const s = getComputedStyle(el);
  const px = (value: string): number => Number.parseFloat(value) || 0;
  return {
    x: px(s.borderLeftWidth) + px(s.paddingLeft),
    y: px(s.borderTopWidth) + px(s.paddingTop),
  };
};

/**
 * Where a frame's viewport sits in page coordinates: `{x:0,y:0}` for the main
 * document, the iframe element's CONTENT origin for a child, `null` when the
 * frame is gone or not rendered (detached, `display:none`) and must be skipped.
 *
 * `boundingBox()` is the iframe's BORDER box, while an in-frame
 * `getBoundingClientRect()` is relative to its content origin — so without the
 * border+padding inset every node inside an iframe carrying the UA's default
 * `2px inset` border is off by exactly that much.
 */
export async function frameOffset(frame: Frame): Promise<FrameBox | null> {
  if (frame.parentFrame() === null) return { x: 0, y: 0 };
  try {
    const element = await frame.frameElement();
    const box = await element.boundingBox();
    if (!box) return null;
    const inset = await element.evaluate(FRAME_INSET);
    return { x: box.x + inset.x, y: box.y + inset.y };
  } catch {
    return null; // detached between listing and reading
  }
}

/**
 * Translate a node read inside a frame into page coordinates and stamp which
 * frame it came from.
 *
 * Bounds arrive relative to the frame's own viewport; clicks dispatch against
 * the page. Without the shift, every click on embedded content would land at the
 * wrong place on the page — silently, since the coordinates stay plausible.
 */
export function placeInPage(
  node: RawNode,
  offset: { x: number; y: number },
  frame: Frame,
): RawNode {
  if (frame.parentFrame() === null) return node;
  return {
    ...node,
    bounds: {
      ...node.bounds,
      x: node.bounds.x + offset.x,
      y: node.bounds.y + offset.y,
    },
    frame: frame.url(),
  };
}
