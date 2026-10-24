/**
 * Named auth personas — signing in for the run, before the driver's first step.
 *
 * `debugLogin` skips a CAPTCHA; it never skipped auth. So every goal string had
 * to re-teach the login flow in prose, which cost driver steps on every run and
 * put credentials in a free-text field that gets logged. A persona
 * (`targets.<t>.auth.<name>` — see `config/schema.ts`) states the recipe once and
 * `start_debug({as})` names it.
 *
 * **Out-of-band, not in-trail.** The login runs HERE, through the same adapter
 * contract the belt uses, between `adapter.open()` and the loop's first step —
 * the driver never performs it. Two reasons, both structural:
 *
 *  - *The secret must never enter the model's context.* That is already the rule
 *    for credential headers and `?token=` params (`log-format.ts`). A recipe
 *    composed into the system prompt would ship the password to the provider on
 *    EVERY step, which is a strictly worse posture than the one the repo holds
 *    everywhere else.
 *  - *Steps are the scarce resource.* An in-trail login spends 4-8 of the run's
 *    steps, and the run's context, on work that has one correct answer.
 *
 * The cost is that a changed form cannot be improvised around. That is paid back
 * as an {@link AuthError} naming the persona and the control that did not
 * resolve, thrown out of `start_debug` before a step is spent — which is a better
 * answer than a driver quietly reporting empty pages behind a login it never got
 * through.
 *
 * The trail stays honest: every action here is recorded as a {@link Step} the
 * same way `act` records its own, marked as the pre-run login rather than a
 * driver decision, with the values never written down.
 */

import { capWait } from '../adapters/budget.js';
import type { Adapter, Node } from '../adapters/contract.js';
import type { AuthPersona, Target } from '../config/schema.js';
import { AuthError, ConfigError } from '../errors.js';
import type { Step } from '../findings/schema.js';

/** Whole-login default budget; the run's remaining cap may only shorten it. */
const LOGIN_TIMEOUT_MS = 30_000;

/**
 * How long ONE observation of the post-submit navigation may wait for the page
 * to SETTLE, before the URL that decides whether the login took is read.
 *
 * A per-observation slice — NOT the cap on the proof. The proof watches the URL
 * across the whole login budget ({@link LOGIN_TIMEOUT_MS}); each observation
 * spends at most this long waiting for the network to go idle before the URL is
 * read again.
 *
 * Why there is a wait at all: the URL read alone can miss a redirect that has
 * been dispatched but has not landed yet, so each observation gives the page a
 * bounded chance to finish its work before the URL is read.
 *
 * Why it is not the CAP: a login whose redirect lands later than this slice — a
 * slow POST, a slow app — used to be read once, at the end of the slice, and
 * reported as a FAILED login, with the credentials blamed for a navigation that
 * had simply not happened yet. The proof now keeps watching instead of reading
 * the URL once and giving up, and a settle wait that TIMES OUT (the page is
 * still working) is not a verdict — it never ends the proof.
 *
 * Five seconds is chosen against what it is waiting for — one redirect hop on an
 * app that has already answered the login POST — not against the runner. A
 * caller with less than that left still shortens it via `capWait`.
 */
const NAVIGATION_SETTLE_MS = 5_000;

/**
 * How long the page must be observed IDLE **and UNMOVED** before a settled page
 * that is still on the login page is called a REJECTED login.
 *
 * A settle observation is NOT a verdict, and reading the URL twice back to back
 * is not evidence either: on a page that is already idle, Playwright's
 * network-idle wait resolves INSTANTLY (`browser-adapter.ts`), so an app that
 * answers the login POST and then navigates on a timer —
 * `fetch('/api/login')` and `setTimeout(() => location.href = '/dashboard', 1000)`
 * — is idle while its redirect is still PENDING. Blaming the credentials for
 * that was wrong: nothing about them was.
 *
 * So the page has to STAY idle, and stay on the login page, for this long
 * before the proof concludes the login was rejected. It bounds how long a
 * redirect may sit PENDING: the navigation is dispatched, and if it has not
 * fired within this window it is not going to.
 *
 * Two seconds is twice the delay of the case this exists for (a one-second
 * timer), and it stays UNDER the settle slice — so a wrong password is still
 * reported in seconds, faster than the fixed slice it replaced, and a rejected
 * login never costs the whole budget.
 *
 * It is bounded by what is LEFT of the login's budget: a caller with less
 * budget gets a shorter window, and a budget that runs out first ends the
 * proof through the other diagnostic.
 */
const SETTLE_CONFIRM_MS = 2_000;

/** Gap between two URL observations while the proof waits for a redirect to land. */
const OBSERVATION_INTERVAL_MS = 250;

/** Local sleep — the repo has no shared timer helper. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The ms left before `deadline`, never negative — `capWait` rejects a negative budget. */
function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/** What `start_debug({as})` resolved to — the persona plus the key that named it. */
export interface ResolvedAuth {
  /** The `as` key, as the caller typed it — every failure names it. */
  name: string;
  persona: AuthPersona;
}

/**
 * Resolve `start_debug({as})` against the target's configured personas.
 *
 * Fails loud ({@link ConfigError}) on an unknown key, listing the valid ones — an
 * `as` typo must NEVER fall through to a signed-out run, because every screen
 * behind the login then reads as a broken UI.
 */
export function resolveAuth(
  target: Target,
  targetName: string,
  as: string | undefined,
): ResolvedAuth | undefined {
  if (as === undefined) return undefined;
  if (target.adapter !== 'browser') {
    throw new ConfigError(
      `'as' (auth persona) only applies to web targets, but '${targetName}' is '${target.adapter}'`,
    );
  }
  const auth = target.auth;
  // `hasOwn`, never a plain index read — `auth['constructor']` walks the prototype
  // chain and answers truthy, and the run would die deeper with a persona of `{}`.
  const persona = auth && Object.hasOwn(auth, as) ? auth[as] : undefined;
  if (persona) return { name: as, persona };

  const configured = Object.keys(auth ?? {});
  const known =
    configured.length > 0
      ? `configured personas: ${configured.map((k) => `'${k}'`).join(', ')}`
      : `target '${targetName}' has no 'auth' block`;
  throw new ConfigError(
    `unknown auth persona '${as}' for target '${targetName}' — ${known}. ` +
      `Add it under targets.${targetName}.auth in .ui-debugger-mcp.json, or omit 'as' to run signed out.`,
  );
}

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

/** First candidate that resolves to a node, or `null` when none of them do. */
async function findFirst(adapter: Adapter, candidates: readonly string[]): Promise<Node | null> {
  for (const query of candidates) {
    const node = await adapter.find({ query });
    if (node) return node;
  }
  return null;
}

/** Everything {@link performLogin} needs beyond the adapter itself. */
export interface LoginOptions extends ResolvedAuth {
  /** Absolute login URL — `persona.path` already resolved against the target url. */
  loginUrl: string;
  /** The run's remaining wall-clock budget (ms); only ever shortens the login's waits. */
  timeoutMs?: number;
  /** Breadcrumb sink (`logs/agent.log`). The caller's sink is already secret-redacting. */
  log?: (line: string) => void;
}

/** The active tab's URL, or `null` on a target with no tab concept (desktop/android). */
async function currentUrl(adapter: Adapter): Promise<string | null> {
  const tabs = await adapter.tabs?.();
  return tabs?.find((tab) => tab.active)?.url ?? null;
}

/**
 * Sign in as `persona`, returning the {@link Step}s to splice onto the run's trail.
 *
 * Every failure is an {@link AuthError} that names the persona and the exact
 * control that did not resolve, so the caller fixes the config instead of reading
 * a run's worth of findings about a login page.
 */
export async function performLogin(adapter: Adapter, options: LoginOptions): Promise<Step[]> {
  const { name, persona, loginUrl, timeoutMs } = options;
  const log = options.log ?? (() => undefined);
  const budget = capWait(LOGIN_TIMEOUT_MS, timeoutMs);
  /**
   * ONE deadline for the WHOLE login, taken before the first byte is spent:
   * opening the page, filling the fields and submitting all come out of the
   * same budget as the URL watch. A watch window that started fresh AFTER the
   * submit would let the login overrun the cap it was handed.
   */
  const deadline = Date.now() + budget;
  const steps: Step[] = [];
  /** Marks every step here as the pre-run login, not something the driver chose. */
  const note = `auth persona ${JSON.stringify(name)} — signed in before the run's first step`;

  log(`auth: signing in as ${JSON.stringify(name)} at ${loginUrl}`);
  await adapter.open(loginUrl, budget);
  steps.push({ step: `open ${loginUrl}`, ok: true, note });

  for (const [key, value] of Object.entries(persona.fields)) {
    const node = await findFirst(adapter, fieldCandidates(key));
    if (!node) {
      throw new AuthError(
        `auth persona '${name}': no input matching field '${key}' on ${loginUrl}. ` +
          "Rename the key to the field's name/id/type/data-testid/aria-label/placeholder, " +
          'or use a selector as the key (e.g. "#user", "[data-testid=\'email\']").',
      );
    }
    // `type` APPENDS (it focuses and types, it does not `fill`), so a browser that
    // restored a saved value would produce a spliced credential and a failed login
    // that looks like wrong config. Same clear-then-type as `act({clear:true})`.
    await adapter.type(node, '');
    await adapter.pressKey('Control+a');
    await adapter.pressKey('Delete');
    await adapter.type(node, value);
    // The value is NOT written down — length is the diagnostic part.
    steps.push({ step: `type ${value.length} chars into field "${key}"`, ok: true, note });
  }

  const submit = await findFirst(adapter, submitCandidates(persona.submit));
  if (!submit) {
    throw new AuthError(
      `auth persona '${name}': no button, link or text matching submit '${persona.submit}' on ${loginUrl}. ` +
        'Use the control\'s visible label, or a selector (e.g. "button[type=submit]").',
    );
  }
  await adapter.click(submit);
  steps.push({ step: `click submit "${persona.submit}"`, ok: true, note });

  await assertSignedIn(adapter, options, budget, deadline);
  // Where the login LANDED, not where the run was configured to start: submitting
  // usually redirects, so this is the page the driver's first step actually reads.
  const landed = await currentUrl(adapter);
  log(`auth: signed in as ${JSON.stringify(name)}${landed ? ` → ${landed}` : ''}`);
  steps.push({ step: `signed in as "${name}"${landed ? ` → ${landed}` : ''}`, ok: true, note });
  return steps;
}

/**
 * Prove the login took, or fail loud. `expect` is the explicit proof; without one
 * the run requires that submitting LEFT the login page — a real signal, and the
 * error says how to replace it for an app that signs in without navigating.
 *
 * Without `expect` the proof WATCHES the active tab's URL across the whole
 * login budget instead of reading it once after a fixed settle slice: a valid
 * login whose redirect lands later than that slice used to be reported as a
 * failed login, with the credentials blamed for a navigation that had simply
 * not happened yet.
 *
 * A settled observation is not a verdict by itself. It only says the page
 * finished its work — a redirect can be dispatched and still PENDING, and on
 * an already-idle page the settle wait returns INSTANTLY, so two back-to-back
 * reads prove nothing. The settled rejection therefore needs the page to stay
 * idle AND unmoved for {@link SETTLE_CONFIRM_MS}; a redirect that lands inside
 * that window is the login taking, not a rejected login.
 *
 * Two failures, and they say different things because the MEASUREMENTS differ:
 *
 *  - **settled rejection** — the page reached network-idle at least once and
 *    the URL was still the login page when the proof ended. The app finished
 *    its work and did not navigate: the login did not take, and the
 *    credentials are the first thing to check.
 *  - **never settled** — the budget ran out with the URL still on the login page
 *    and the page never having gone idle. The navigation may still have been in
 *    flight; nothing measured here implicates the credentials, so the error says
 *    that instead of guessing.
 */
async function assertSignedIn(
  adapter: Adapter,
  { name, persona, loginUrl }: LoginOptions,
  budget: number,
  deadline: number,
): Promise<void> {
  if (persona.expect !== undefined) {
    try {
      // The SAME deadline as the URL watch: the whole login shares one budget,
      // so `expect` waits on what is LEFT of it, never on a fresh one.
      await adapter.waitFor({
        query: persona.expect,
        timeout: capWait(budget, remainingMs(deadline)),
      });
    } catch (error) {
      throw new AuthError(
        `auth persona '${name}': submitted the form but '${persona.expect}' never appeared — ` +
          `the credentials are probably wrong, or 'expect' names something this app does not render. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return;
  }

  // A target with no tab concept cannot answer "did the page move?", and there
  // is no `expect` to fall back on. Say so before spending a wait on it.
  if (!adapter.tabs) {
    throw new AuthError(
      `auth persona '${name}': this target cannot report its current location, so the login ` +
        "cannot be verified — set 'expect' on the persona to a selector that only exists once signed in.",
    );
  }

  /** The URL the last observation saw — the one a failure names. */
  let lastUrl = loginUrl;
  /** Whether the page was EVER observed idle — the difference between the two failures. */
  let sawSettled = false;
  /**
   * When the page was first observed idle AND unmoved, or 0 when it is not
   * currently quiet. A page that goes busy again resets it: the app is still
   * working, so the quiet streak starts over.
   */
  let quietSince = 0;
  /** How long the page must stay quiet before the credentials are blamed. */
  let quietWindow = 0;

  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    // One observation: give the page a bounded slice to settle. A REJECTED wait
    // is not a verdict — it only says the page is still working (the POST is in
    // flight, the redirect has not fired) — so the watch continues.
    let settled = false;
    try {
      await adapter.waitFor({
        networkIdle: true,
        timeout: capWait(NAVIGATION_SETTLE_MS, remaining),
      });
      settled = true;
    } catch {
      // not idle within the slice — keep watching
    }

    // The URL is what decides, and it is read after EVERY observation — settled
    // or not. That is the whole fix: a redirect that lands late is still seen.
    const after = await currentUrl(adapter);
    if (after === null) {
      throw new AuthError(
        `auth persona '${name}': this target cannot report its current location, so the login ` +
          "cannot be verified — set 'expect' on the persona to a selector that only exists once signed in.",
      );
    }
    lastUrl = after;
    // The URL left the login page: the login took.
    if (!samePage(after, loginUrl)) return;

    if (!settled) {
      // The page went busy again (or never settled): it is WORKING, not
      // rejecting. Any quiet streak is void — a redirect may be on its way.
      quietSince = 0;
    } else {
      sawSettled = true;
      if (quietSince === 0) {
        // The page just went quiet for the first time (or after being busy).
        // How long it must STAY quiet is bounded by what is left of the budget:
        // a caller with less budget gets a shorter window, and a budget that
        // runs out first ends the proof through the other diagnostic.
        quietSince = Date.now();
        quietWindow = Math.min(SETTLE_CONFIRM_MS, Math.max(1, remaining));
      }
      // The page is idle and has not moved. That is STILL not a rejection: the
      // redirect can be pending (the app answered the login POST and will
      // navigate on a timer). Only a page that stays idle AND unmoved for the
      // whole quiet window is a rejected login — and a redirect that lands
      // inside that window is the login taking.
      if (Date.now() - quietSince >= quietWindow) {
        throw new AuthError(
          `auth persona '${name}': still on ${after} after submitting '${persona.submit}' — the login ` +
            'did not take. Check the credentials and the field keys; if this app signs in WITHOUT ' +
            "navigating away, set 'expect' on the persona to a selector that only exists once signed in.",
        );
      }
    }

    // Sleep only as long as the budget still allows: a fixed gap would carry
    // the login PAST the caller's cap, which is the very overrun the shared
    // deadline exists to prevent.
    await delay(Math.min(OBSERVATION_INTERVAL_MS, remainingMs(deadline)));
  }

  // The budget ran out with the URL still on the login page. Which failure it
  // is depends on what was MEASURED, not on how the loop ended: a page that
  // settled at least once finished its work and did not navigate, while a page
  // that never went idle may still have had a navigation in flight — and
  // nothing measured there implicates the credentials.
  if (sawSettled) {
    throw new AuthError(
      `auth persona '${name}': still on ${lastUrl} after submitting '${persona.submit}' — the login ` +
        'did not take. Check the credentials and the field keys; if this app signs in WITHOUT ' +
        "navigating away, set 'expect' on the persona to a selector that only exists once signed in.",
    );
  }
  throw new AuthError(
    `auth persona '${name}': still on ${lastUrl} after ${budget}ms — the login navigation never settled ` +
      '(the page never went idle) and the login budget was exhausted, so the proof could not be ' +
      'completed. Nothing measured here says why the page did not leave the login page. ' +
      "Raise the run's timeout, or set 'expect' on the persona to a selector that only exists once signed in.",
  );
}

/** Same origin + same path — the query/hash a login flow adds (`?error=1`) does not make it a new page. */
export function samePage(a: string, b: string): boolean {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname === right.pathname;
  } catch {
    return a === b;
  }
}
