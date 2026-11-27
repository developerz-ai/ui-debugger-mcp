/**
 * Selector candidates for a persona's `fields` keys and `submit` label — the
 * pure half of the pre-run login (`login.ts`): a config string in, the ordered
 * selectors to try out. Split out to keep `login.ts` under the 500-LOC cap.
 */

/**
 * A field key / submit label that is already a selector — used verbatim, never
 * expanded. Deliberately narrow (a leading `.`/`#`/`[`, a `tag#id`/`tag[attr]`, an
 * explicit engine prefix, or XPath) so an ordinary label like `Email address` or
 * `Sign in` is never mistaken for one.
 */
const SELECTORISH = /^[.#[]|^[a-zA-Z][\w-]*[#[]|^(css|role|text|id|data-testid|xpath)=|^\/\//;

/** A key safe to interpolate into an `#id` / `[type=…]` selector without quoting. */
const IDENTIFIER = /^[a-zA-Z][\w-]*$/;

/**
 * Selectors to try for a field, most specific first — `name`, then `id`/`type`,
 * then `data-testid`, then the two label-ish attributes.
 *
 * Ordered candidates rather than one comma-joined list on purpose: a CSS list
 * resolves in DOCUMENT order, so `{"password": …}` on a page with a "Forgot
 * password?" link above the input would type the password into the link.
 */
export function fieldCandidates(key: string): string[] {
  if (SELECTORISH.test(key)) return [key];
  const v = JSON.stringify(key); // quoted + escaped for an attribute value
  const candidates: string[] = [`css=input[name=${v} i], textarea[name=${v} i]`];
  if (IDENTIFIER.test(key)) {
    candidates.push(
      `css=input#${key}, textarea#${key}`,
      `css=input[type="${key.toLowerCase()}" i]`,
    );
  }
  candidates.push(
    `css=input[data-testid=${v} i], textarea[data-testid=${v} i]`,
    `css=input[aria-label*=${v} i], textarea[aria-label*=${v} i]`,
    `css=input[placeholder*=${v} i], textarea[placeholder*=${v} i]`,
    `role=textbox[name=${v} i]`,
  );
  return candidates;
}

/** Selectors to try for the submit control — the named button, then link, then plain text. */
export function submitCandidates(submit: string): string[] {
  if (SELECTORISH.test(submit)) return [submit];
  const v = JSON.stringify(submit);
  return [`role=button[name=${v} i]`, `role=link[name=${v} i]`, `text=${submit}`];
}

/** How to fix a field key that matched nothing. */
export const FIELD_KEY_HINT =
  "Rename the key to the field's name/id/type/data-testid/aria-label/placeholder, " +
  'or use a selector as the key (e.g. "#user", "[data-testid=\'email\']").';
