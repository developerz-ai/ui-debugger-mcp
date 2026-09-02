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

  await assertSignedIn(adapter, options, budget);
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
 */
async function assertSignedIn(
  adapter: Adapter,
  { name, persona, loginUrl }: LoginOptions,
  budget: number,
): Promise<void> {
  if (persona.expect !== undefined) {
    try {
      await adapter.waitFor({ query: persona.expect, timeout: budget });
    } catch (error) {
      throw new AuthError(
        `auth persona '${name}': submitted the form but '${persona.expect}' never appeared — ` +
          `the credentials are probably wrong, or 'expect' names something this app does not render. ` +
          `(${error instanceof Error ? error.message : String(error)})`,
      );
    }
    return;
  }

  await adapter.waitFor({ networkIdle: true, timeout: budget }).catch(() => undefined);
  const after = await currentUrl(adapter);
  if (after === null) {
    throw new AuthError(
      `auth persona '${name}': this target cannot report its current location, so the login ` +
        "cannot be verified — set 'expect' on the persona to a selector that only exists once signed in.",
    );
  }
  if (samePage(after, loginUrl)) {
    throw new AuthError(
      `auth persona '${name}': still on ${after} after submitting '${persona.submit}' — the login ` +
        'did not take. Check the credentials and the field keys; if this app signs in WITHOUT ' +
        "navigating away, set 'expect' on the persona to a selector that only exists once signed in.",
    );
  }
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
