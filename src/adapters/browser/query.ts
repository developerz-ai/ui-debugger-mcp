/**
 * Query normalization — bridge the gap between what the driver *reads* and what
 * Playwright *accepts*.
 *
 * `observe({kind:'tree'})` hands the agent nodes as `role` + accessible `name`
 * (e.g. `[button] "Add to cart"`) — it never sees a CSS selector. So when the
 * agent acts, the natural targets it produces are role+name (`button "Add to
 * cart"`) or plain text (`Add to cart`) — both of which a raw
 * `page.locator(selector)` rejects (invalid CSS) or misses. That mismatch made
 * the driver loop forever without ever landing a click.
 *
 * {@link normalizeQuery} maps those LLM-natural targets onto Playwright selector
 * engines, while passing real CSS / explicit-engine / XPath selectors straight
 * through. The result is always a string a Playwright `locator()` understands.
 */

/** Selector engines (and XPath) Playwright already understands — passed through verbatim. */
const ENGINE_PREFIX = /^(css|text|role|id|data-testid|xpath|internal:[a-z-]+)=/i;

/** `role "Accessible Name"` (or single quotes / smart quotes), e.g. `button "Add to cart"`. */
const ROLE_NAME = /^([a-zA-Z][\w-]*)\s+["'“”](.+?)["'”“]$/;

/**
 * CSS-ish: starts with `.`/`#`/`[`/`*`, a `tag` followed by `.`/`#`/`[`/`:`, or
 * contains a combinator (`>`,`~`) or a structural pseudo (`:has`,`:nth`,`::`).
 */
const CSS_LIKE = /^[.#[*]|^[a-zA-Z][\w-]*[.#:[]|[>~]|:has\(|:nth-|::/;

/**
 * Turn an agent-supplied target into a Playwright-resolvable selector string.
 *
 * Resolution order (first match wins):
 *  1. explicit engine / XPath (`text=…`, `role=…`, `css=…`, `//…`) → verbatim
 *  2. `role "name"` → `role=<role>[name="<name>" i]` (case-insensitive)
 *  3. CSS-looking → verbatim CSS
 *  4. anything else (plain visible text) → `text=<query>` (case-insensitive substring)
 */
export function normalizeQuery(raw: string): string {
  const q = raw.trim();
  if (q === '') return q;
  if (ENGINE_PREFIX.test(q) || q.startsWith('//') || q.startsWith('(//')) return q;

  const roleName = ROLE_NAME.exec(q);
  if (roleName?.[1] && roleName[2]) {
    return `role=${roleName[1].toLowerCase()}[name=${JSON.stringify(roleName[2])} i]`;
  }

  if (CSS_LIKE.test(q)) return q;

  // Plain text the agent copied out of the tree's `name` — match it as visible text.
  return `text=${q}`;
}
