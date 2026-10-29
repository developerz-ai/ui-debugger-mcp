/**
 * Tab identity for one browser run — the registry that NAMES a tab.
 *
 * A browser tab is named by a stable label (`tab-1`, `tab-2`, …) that follows
 * the PAGE, never its position in the tab list. Positions do not survive the
 * run: `switch_tab` takes an index, closing an earlier tab shifts every later
 * index down, and a row captured before the shift would land under the wrong
 * tab. So a label is handed out on FIRST SIGHT of a page and is never
 * renumbered and never reused — a closed tab's label is never handed to some
 * other page later in the same run.
 *
 * ONE registry per run: the CDP capture stamps a row with the label of the
 * page the event fired on, and the adapter's `tabs()` listing reports the same
 * label — so a `[tab-2]` marker in `logs/console.log` resolves to the tab the
 * driver drove, and a row captured before a switch still names its own tab.
 *
 * The label is an opaque marker: it carries no URL, no title and no secret —
 * only the shape `tab-N`.
 */

import type { Page } from 'playwright-core';

export class TabContext {
  /** Page → its label. Weak: a closed tab's entry evaporates with the page. */
  readonly #labels = new WeakMap<Page, string>();
  /** Next label number — monotonic and never reused, so a marker never changes meaning. */
  #next = 1;

  /**
   * The label of `page`, assigning one the first time the page is seen.
   *
   * Idempotent: the same page always gets the same label for the whole run,
   * and a page seen for the first time joins the sequence at the end.
   */
  label(page: Page): string {
    const known = this.#labels.get(page);
    if (known !== undefined) return known;
    const label = `tab-${this.#next}`;
    this.#next += 1;
    this.#labels.set(page, label);
    return label;
  }
}
