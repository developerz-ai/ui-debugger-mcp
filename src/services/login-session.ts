/**
 * Reusing a session the browser profile already holds — the pre-run login's one
 * way to succeed WITHOUT submitting the form. Split out of `login.ts` (500-LOC cap).
 */

import type { Adapter } from '../adapters/contract.js';
import { AuthError } from '../errors.js';
import type { LoginOptions } from './login.js';
import { FIELD_KEY_HINT } from './login-selectors.js';

/** Any password input — its presence means the page is still ASKING for a login. */
const PASSWORD_INPUT = 'css=input[type="password" i]';

/**
 * The login page ended up on `url` with no `key` input. That is an existing
 * session ONLY with positive proof — never by default, or a moved login page plus
 * a mistyped key would run the whole goal signed out:
 *  - this persona is the target's ONLY one (who is signed in cannot be read off a
 *    redirect), AND
 *  - its `expect` marker shows there, within `waitMs`.
 *
 * The marker is checked FIRST and is the whole proof — which is why it should
 * identify the ACCOUNT (the username shown), not just "someone is signed in". A
 * password input does not veto it (a dashboard has a change-password form); it
 * only decides which failure this is once the marker is absent, and then the
 * marker gets a single read instead of a wait: that page is a login form.
 *
 * A persona with no `expect` is never reused. The ABSENCE of a login form proves
 * nothing: `/login` also redirects to a public error or maintenance page, which
 * has no password field either. Everything else fails loud, saying which it was.
 */
export async function assertAlreadySignedIn(
  adapter: Adapter,
  { name, persona, loginUrl, solePersona }: LoginOptions,
  key: string,
  url: string,
  waitMs: number,
): Promise<void> {
  const marker = solePersona === true ? persona.expect : undefined;
  const asksForPassword = (await adapter.find({ query: PASSWORD_INPUT })) !== null;
  if (marker !== undefined) {
    if (asksForPassword) {
      if ((await adapter.find({ query: marker })) !== null) return;
    } else {
      try {
        await adapter.waitFor({ query: marker, timeout: waitMs });
        return;
      } catch {
        // absent — diagnosed below
      }
    }
  }

  const landed = `auth persona '${name}': opening ${loginUrl} landed on ${url}`;
  if (asksForPassword) {
    throw new AuthError(
      `${landed}, which still shows a password field — a login page, not a signed-in profile — ` +
        `but no input matching field '${key}'. ${FIELD_KEY_HINT} If the login page moved, point ` +
        "the persona's 'path' at it.",
    );
  }
  let why = `'${persona.expect}' ('expect') never appeared there`;
  if (solePersona !== true) {
    why = "this target has other personas, so the session may be someone else's";
  } else if (persona.expect === undefined) {
    why =
      "the persona has no 'expect' to prove it (a page with no login form may just as well be an " +
      "error page) — set 'expect' to a selector that only exists once signed in AS THIS ACCOUNT " +
      '(e.g. the username shown), and the next run reuses the session';
  }
  throw new AuthError(
    `${landed} — the app redirected away from its login page, so this browser profile is ` +
      `probably ALREADY signed in, but ${why}. Otherwise sign that session out, or delete the ` +
      "target's profile dir (chrome-user-data), then start again.",
  );
}
