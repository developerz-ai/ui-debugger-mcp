/**
 * Resolving a selector against a page that has MORE THAN ONE document.
 *
 * `page.locator()` never crosses an iframe boundary, but `readState` does — it
 * reads every frame and tags what it found with `frame`. A driver that then acts
 * on (or waits for, or scopes to) such a target would otherwise be told it does
 * not exist. These three fall through the frames instead:
 *   - {@link locateAcrossFrames} — a locator from whichever frame holds it;
 *   - {@link waitAcrossFrames}   — a wait that any frame can satisfy;
 *   - {@link regionAcrossFrames} — a `within` scope as a page-coordinate rect.
 *
 * Split out of `browser-adapter.ts` to keep that file under the 500-LOC cap.
 */

import type { Locator, Page } from 'playwright-core';
import { AdapterError } from '../../errors.js';
import type { Bounds, NodeRef } from '../contract.js';
import { isFrameGone, isTimeout } from './geometry.js';
import { normalizeQuery } from './query.js';

/** Playwright's own `waitFor` default, restated so the cross-frame poll has a budget. */
const WAIT_TIMEOUT_MS = 30_000;

/** One frame's turn in that poll — short, so no frame's wait outlives the call. */
const WAIT_SLICE_MS = 250;

/**
 * A locator for `selector` in whichever frame actually contains it — the main
 * document first, then every child frame.
 *
 * Falling back through the frames keeps `act` working on a target the agent can
 * plainly see in the tree.
 */
export async function locateAcrossFrames(page: Page, selector: string): Promise<Locator> {
  const normalized = normalizeQuery(selector);
  for (const frame of page.frames()) {
    const locator = frame.locator(normalized).first();
    try {
      if ((await locator.count()) > 0) return locator;
    } catch {
      // Detached frame — try the next one.
    }
  }
  // Nothing matched anywhere: hand back the main-frame locator so the caller's
  // own action reports the miss with Playwright's message, as it always did.
  return page.locator(normalized).first();
}

/**
 * Wait until `query` is visible in ANY frame — whichever shows it first wins.
 *
 * Locating first is not enough here: `waitFor` exists for things that do not
 * exist YET, in any frame.
 *
 * Polls frame by frame in SLICES rather than starting one full-length wait per
 * frame in parallel. A Playwright wait cannot be cancelled, so the parallel form
 * leaves a poller hammering the page for every frame that never matches — long
 * after the wait it belonged to returned. Re-reading `frames()` each pass also
 * picks up frames that appear mid-wait.
 */
export async function waitAcrossFrames(page: Page, query: string, timeout?: number): Promise<void> {
  const selector = normalizeQuery(query);
  const budget = timeout ?? WAIT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  do {
    for (const frame of page.frames()) {
      const slice = Math.min(WAIT_SLICE_MS, Math.max(1, deadline - Date.now()));
      try {
        await frame.locator(selector).first().waitFor({ state: 'visible', timeout: slice });
        return;
      } catch (error) {
        // Not-here-yet (a slice timing out) and a frame that vanished are both
        // "try the next one"; a bad selector is the caller's mistake — fail loud.
        if (!isTimeout(error) && !isFrameGone(error, frame.isDetached())) throw error;
      }
    }
  } while (Date.now() < deadline);
  throw new AdapterError(
    `waitFor: ${JSON.stringify(query)} never became visible in any frame within ${budget}ms`,
  );
}

/**
 * Resolve a `within` scope to a rectangle in PAGE coordinates — {@link Node}
 * bounds as given, a selector via {@link locateAcrossFrames} so a scrollable
 * region (or a read scope) inside an iframe resolves like any other target.
 * Playwright's `boundingBox()` is main-frame-relative even for an in-frame
 * element, so a viewport guard downstream stays correct.
 */
export async function regionAcrossFrames(page: Page, within: NodeRef): Promise<Bounds> {
  if (typeof within !== 'string') return within.bounds;
  const box = await (await locateAcrossFrames(page, within)).boundingBox();
  if (!box) {
    throw new AdapterError(`\`within\` target not found or not visible: ${within}`);
  }
  return box;
}
