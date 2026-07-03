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

/**
 * ARIA roles Playwright's `role=` engine accepts — the allow-list that gates the
 * `role "name"` shorthand. A first token outside this set is an ordinary label,
 * not a role (so `Sale "50% off"` stays text, never `role=sale`), and falls through
 * to the plain-text engine. Mirrors the role set `observe` uses to build targets.
 */
const ARIA_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'slider',
  'heading',
  'img',
  'navigation',
  'main',
  'form',
  'list',
  'listitem',
  'tab',
  'menuitem',
  'switch',
  'dialog',
  'banner',
  'contentinfo',
  'region',
  'article',
  'search',
  'table',
]);

/** `role "Accessible Name"` (or single quotes / smart quotes), e.g. `button "Add to cart"`. */
const ROLE_NAME = /^([a-zA-Z][\w-]*)\s+["'“”](.+?)["'”“]$/;

/**
 * HTML tag names a bare one-word query resolves as CSS. Without this, `span` or
 * `img` fell through to `text=span` — matching nothing, silently — and the driver
 * burned steps on empty reads. A page whose visible text is exactly one of these
 * words loses the text match, but a structural read is what such a query means.
 */
const HTML_TAGS = new Set([
  'a',
  'article',
  'aside',
  'audio',
  'blockquote',
  'button',
  'canvas',
  'caption',
  'code',
  'details',
  'dialog',
  'div',
  'fieldset',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'iframe',
  'img',
  'input',
  'label',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'option',
  'p',
  'pre',
  'progress',
  'section',
  'select',
  'span',
  'summary',
  'svg',
  'table',
  'tbody',
  'td',
  'textarea',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul',
  'video',
]);

/**
 * CSS-ish, kept deliberately narrow so ordinary labels are not misread as selectors:
 *  - starts with `.`/`#`/`[`/`*`,
 *  - a `tag` followed by `#`/`[`, by `.` + a class-start char (`div.card`, but not
 *    `Loading...` / `Loading.`), or by `:` + a pseudo-start char (`a:hover`, but not
 *    `Error: payment failed`) — a selector-ish continuation, not trailing punctuation,
 *  - a combinator (`>`/`~`) flanked by simple selectors on BOTH sides — a tag or a
 *    `.`/`#`/`[`/`*` token — so `nav > a` is CSS while `Next >` and `A ~ B` stay text,
 *  - or a structural pseudo (`:has(`, `:nth-`, `::`).
 */
const CSS_LIKE =
  /^[.#[*]|^[a-zA-Z][\w-]*(?:[#[]|\.[a-zA-Z_-]|:[a-zA-Z-])|(?:[a-z][\w-]*|[.#][\w-]+|\*|\])\s*[>~]\s*(?:[a-z][\w-]*|[.#[*])|:has\(|:nth-|::/;

/**
 * Turn an agent-supplied target into a Playwright-resolvable selector string.
 *
 * Resolution order (first match wins):
 *  1. explicit engine / XPath (`text=…`, `role=…`, `css=…`, `//…`) → verbatim
 *  2. `role "name"` → `role=<role>[name="<name>" i]` (case-insensitive)
 *  3. bare HTML tag name (`span`, `img`, `div`) → verbatim CSS tag selector
 *  4. CSS-looking → verbatim CSS
 *  5. anything else (plain visible text) → `text=<query>` (case-insensitive substring)
 */
export function normalizeQuery(raw: string): string {
  const q = raw.trim();
  if (q === '') return q;
  if (ENGINE_PREFIX.test(q) || q.startsWith('//') || q.startsWith('(//')) return q;

  const roleName = ROLE_NAME.exec(q);
  if (roleName?.[1] && roleName[2] && ARIA_ROLES.has(roleName[1].toLowerCase())) {
    return `role=${roleName[1].toLowerCase()}[name=${JSON.stringify(roleName[2])} i]`;
  }

  if (HTML_TAGS.has(q.toLowerCase())) return q.toLowerCase();
  // A comma list of tags (`p, span`) is a CSS selector list, not visible text.
  if (q.includes(',') && q.split(',').every((t) => HTML_TAGS.has(t.trim().toLowerCase()))) {
    return q.toLowerCase();
  }

  if (CSS_LIKE.test(q)) return q;

  // Plain text the agent copied out of the tree's `name` — match it as visible text.
  return `text=${q}`;
}
