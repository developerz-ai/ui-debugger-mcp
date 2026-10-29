import { expect, test } from 'bun:test';
import type { Adapter, Node, Query, TabInfo } from '../adapters/contract.js';
import type { AuthPersona, Target } from '../config/schema.js';
import { AuthError, ConfigError } from '../errors.js';
import {
  fieldCandidates,
  type LoginOptions,
  performLogin,
  resolveAuth,
  samePage,
  submitCandidates,
} from './login.js';

const PERSONA: AuthPersona = {
  path: '/login',
  fields: { email: 'admin@dev.local', password: 'hunter2' },
  submit: 'Sign in',
};

/** The login page the fake adapter sits on until the redirect lands. */
const LOGIN_URL = 'http://localhost:5173/login';

const WEB: Target = {
  adapter: 'browser',
  url: 'http://localhost:5173',
  headless: true,
  auth: { admin: PERSONA, user: { ...PERSONA, fields: { email: 'u@dev.local', password: 'u' } } },
};

// --- resolveAuth: an unknown `as` must NEVER fall through to a signed-out run ---

test('resolveAuth returns undefined when the caller named no persona', () => {
  expect(resolveAuth(WEB, 'dashboard', undefined)).toBeUndefined();
});

test('resolveAuth resolves a configured persona by its key', () => {
  expect(resolveAuth(WEB, 'dashboard', 'admin')).toEqual({ name: 'admin', persona: PERSONA });
});

test('resolveAuth fails loud on an unknown persona, listing the valid keys', () => {
  // Running the whole goal signed out would report every screen behind the login
  // as broken — the caller must learn about the typo here, before the browser.
  let error: unknown;
  try {
    resolveAuth(WEB, 'dashboard', 'admn');
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(ConfigError);
  const message = (error as Error).message;
  expect(message).toContain("unknown auth persona 'admn'");
  expect(message).toContain("'admin'");
  expect(message).toContain("'user'");
});

test('resolveAuth says so when the target has no auth block at all', () => {
  const bare: Target = { adapter: 'browser', url: 'http://x.test', headless: true };
  expect(() => resolveAuth(bare, 'web', 'admin')).toThrow(/has no 'auth' block/);
});

test('resolveAuth never resolves an inherited Object.prototype key as a persona', () => {
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
    expect(() => resolveAuth(WEB, 'dashboard', name)).toThrow(ConfigError);
  }
});

test('resolveAuth rejects `as` on a non-web target', () => {
  const desktop: Target = { adapter: 'desktop', launch: 'myapp' };
  expect(() => resolveAuth(desktop, 'screen', 'admin')).toThrow(ConfigError);
});

// --- selector expansion -------------------------------------------------------

test('fieldCandidates tries name, then id/type, then testid, then the label-ish attributes', () => {
  const candidates = fieldCandidates('password');
  expect(candidates[0]).toContain('input[name="password" i]');
  expect(candidates.some((c) => c.includes('input[type="password" i]'))).toBe(true);
  expect(candidates.some((c) => c.includes('data-testid'))).toBe(true);
  expect(candidates.some((c) => c.includes('placeholder'))).toBe(true);
  expect(candidates.at(-1)).toBe('role=textbox[name="password" i]');
  // Ordered, not comma-joined: a CSS list resolves in DOCUMENT order, so a
  // "Forgot password?" link above the input would win.
  expect(candidates.length).toBeGreaterThan(1);
});

test('fieldCandidates keeps a selector-shaped key verbatim', () => {
  for (const key of ['#user', '[data-testid="email"]', '.form input', 'css=input']) {
    expect(fieldCandidates(key)).toEqual([key]);
  }
});

test('fieldCandidates quotes a label-shaped key instead of splicing it into an id', () => {
  const candidates = fieldCandidates('Email address');
  expect(candidates.some((c) => c.includes('#Email address'))).toBe(false);
  expect(candidates[0]).toContain('"Email address"');
});

test('submitCandidates tries the named button, then link, then plain text', () => {
  expect(submitCandidates('Sign in')).toEqual([
    'role=button[name="Sign in" i]',
    'role=link[name="Sign in" i]',
    'text=Sign in',
  ]);
  expect(submitCandidates('button[type=submit]')).toEqual(['button[type=submit]']);
});

test('samePage ignores the query a login flow appends', () => {
  expect(samePage('http://x/login?error=1', 'http://x/login')).toBe(true);
  expect(samePage('http://x/dashboard', 'http://x/login')).toBe(false);
  expect(samePage('http://y/login', 'http://x/login')).toBe(false);
});

// --- performLogin -------------------------------------------------------------

/** A trace entry: what the login asked the adapter to do. */
type Call = { fn: string; arg?: unknown; text?: string; timeout?: number };

/** Local sleep — the fake spends real budget the way a real adapter does. */
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface FakeOptions {
  /** Selectors that resolve to a node; everything else resolves to null. */
  matches?: (query: string) => boolean;
  /** URL reported as the active tab AFTER submit (before it is the login page). */
  landsOn?: string;
  /** No `tabs` method — a target with no tab concept. */
  noTabs?: boolean;
  /** Make `waitFor` reject (the `expect` proof never showing up). */
  waitFails?: boolean;
  /** Make ONLY the `networkIdle` settle wait reject — a page that never goes idle. */
  settleFails?: boolean;
  /**
   * The settle wait SUCCEEDS for the first N observations and rejects after
   * that — a page that went idle once and then went BUSY again (the app is
   * still working). A quiet streak the page interrupts is void.
   */
  settleFailsAfter?: number;
  /**
   * The URL changes only after this many settle observations — a redirect that
   * lands LATE, after the settle slice that used to cap the whole proof.
   */
  landsOnAfter?: { url: string; afterObservations: number };
  /**
   * The URL changes only after this many REAL milliseconds have passed since
   * the submit — a redirect that is PENDING: the app answered the login POST
   * and goes idle, and only navigates later (on a timer).
   *
   * This is the shape the settle wait cannot see: on an already-idle page
   * Playwright's network-idle wait resolves INSTANTLY, so a proof that reads
   * the URL twice back to back reads it twice before the timer fires.
   */
  landsOnAfterMs?: { url: string; afterMs: number };
  /**
   * The `open` call takes this many REAL ms — setup that spends part of the
   * shared budget, so a watch window handed the FULL budget after the submit
   * is visible in what the settle wait was offered.
   */
  openDelayMs?: number;
}

function fakeAdapter(options: FakeOptions = {}): { adapter: Adapter; calls: Call[] } {
  const calls: Call[] = [];
  const matches = options.matches ?? (() => true);
  let submitted = false;
  /** When the submit happened — the clock a PENDING redirect is measured against. */
  let submittedAt = 0;
  /** How many settle observations the proof has made — the "late redirect" clock. */
  let observations = 0;
  const node = (name: string): Node => ({
    role: 'textbox',
    name,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    enabled: true,
  });
  const adapter: Adapter = {
    selectorDialect: 'web',
    open: async (target) => {
      if (options.openDelayMs) await delay(options.openDelayMs);
      calls.push({ fn: 'open', arg: target });
    },
    find: async (opts: Query) => {
      const query = opts.query ?? '';
      return matches(query) ? node(query) : null;
    },
    click: async (target) => {
      submitted = true;
      submittedAt = Date.now();
      calls.push({ fn: 'click', arg: typeof target === 'string' ? target : target.name });
    },
    type: async (target, text) => {
      calls.push({ fn: 'type', arg: typeof target === 'string' ? target : target.name, text });
    },
    pressKey: async (key) => {
      calls.push({ fn: 'pressKey', arg: key });
    },
    scroll: async () => {},
    readState: async () => [],
    screenshot: async () => new Uint8Array(),
    waitFor: async (opts) => {
      calls.push({ fn: 'waitFor', arg: opts.query ?? 'networkIdle', timeout: opts.timeout });
      if (opts.networkIdle) {
        observations += 1;
        // A settle wait that times out means the page is STILL WORKING — it is
        // not a verdict, and it must not end the proof.
        if (options.settleFails) throw new Error('network never went idle');
        if (options.settleFailsAfter !== undefined && observations > options.settleFailsAfter) {
          throw new Error('network went busy again');
        }
      }
      if (options.waitFails) throw new Error('never became visible');
    },
    console: async () => [],
    network: async () => [],
    close: async () => {},
  };
  if (!options.noTabs) {
    adapter.tabs = async (): Promise<TabInfo[]> => [
      {
        index: 0,
        url: landed(),
        title: '',
        active: true,
      },
    ];
  }
  /** The URL the tab is on: the login page until the redirect lands. */
  function landed(): string {
    if (!submitted) return LOGIN_URL;
    if (options.landsOnAfter) {
      return observations >= options.landsOnAfter.afterObservations
        ? options.landsOnAfter.url
        : LOGIN_URL;
    }
    if (options.landsOnAfterMs) {
      // The redirect is PENDING: it fires on a timer, so the URL is still the
      // login page until that much REAL time has passed. The settle wait cannot
      // see this — the page is idle the whole time.
      return Date.now() - submittedAt >= options.landsOnAfterMs.afterMs
        ? options.landsOnAfterMs.url
        : LOGIN_URL;
    }
    return options.landsOn ?? 'http://localhost:5173/dashboard';
  }
  return { adapter, calls };
}

const OPTS: LoginOptions = {
  name: 'admin',
  persona: PERSONA,
  loginUrl: LOGIN_URL,
};

test('performLogin opens the login page, fills every field, and submits', async () => {
  const { adapter, calls } = fakeAdapter();
  const steps = await performLogin(adapter, OPTS);

  expect(calls[0]).toMatchObject({ fn: 'open', arg: 'http://localhost:5173/login' });
  // Every value made it into the app...
  expect(calls.filter((c) => c.fn === 'type' && c.text === 'admin@dev.local')).toHaveLength(1);
  expect(calls.filter((c) => c.fn === 'type' && c.text === 'hunter2')).toHaveLength(1);
  expect(calls.some((c) => c.fn === 'click')).toBe(true);
  // The trail names where the login LANDED, not where the run was configured to
  // start — the driver's first step reads that page, not the entry url.
  expect(steps.at(-1)?.step).toBe('signed in as "admin" → http://localhost:5173/dashboard');
  expect(steps.every((s) => s.ok)).toBe(true);
});

test('each settle observation is a bounded SLICE, not the cap on the whole proof', async () => {
  const { adapter, calls } = fakeAdapter();
  await performLogin(adapter, OPTS);

  // The no-`expect` proof watches the URL across the WHOLE login budget. Each
  // observation spends at most one settle slice waiting for the page to go
  // idle before the URL is read again — so a single observation can never hang
  // on a page that never settles.
  //
  // RED-WHEN-WIDENED: hand an observation the whole budget instead of a slice
  // and one stuck observation eats the entire login window; the proof could no
  // longer notice a redirect that lands between two observations.
  const settle = calls.find((c) => c.fn === 'waitFor' && c.arg === 'networkIdle');
  expect(settle).toBeDefined();
  expect(settle?.timeout).toBe(5_000);
});

test('a caller with less budget left still shortens the settle wait', async () => {
  const { adapter, calls } = fakeAdapter();
  await performLogin(adapter, { ...OPTS, timeoutMs: 1_200 });

  // capWait only ever SHORTENS: the slice is a ceiling, never a floor a spent
  // run has to sit through. It is bounded by what is LEFT of the caller's
  // budget — the open, the typing and the submit already spent part of it —
  // so it lands just under the 1.2 s the caller handed over.
  const settle = calls.find((c) => c.fn === 'waitFor' && c.arg === 'networkIdle');
  expect(settle?.timeout).toBeLessThanOrEqual(1_200);
  expect(settle?.timeout).toBeGreaterThan(1_000);
});

test('performLogin clears each field before typing (type appends, it does not fill)', async () => {
  const { adapter, calls } = fakeAdapter();
  await performLogin(adapter, OPTS);
  // Same clear-then-type as `act({clear:true})`: a restored value would splice the
  // credential and the failed login would look like wrong config.
  expect(calls.some((c) => c.fn === 'pressKey' && c.arg === 'Control+a')).toBe(true);
  expect(calls.some((c) => c.fn === 'pressKey' && c.arg === 'Delete')).toBe(true);
});

test('performLogin never writes a credential into the trail it returns', async () => {
  const { adapter } = fakeAdapter();
  const lines: string[] = [];
  const steps = await performLogin(adapter, { ...OPTS, log: (line) => lines.push(line) });
  const written = JSON.stringify(steps) + lines.join('\n');
  for (const secret of Object.values(PERSONA.fields)) {
    expect(written).not.toContain(secret);
  }
  // The shape is still there — length is the diagnostic part, like a redacted header.
  expect(steps.map((s) => s.step)).toContain('type 7 chars into field "password"');
});

test('performLogin marks every step as the pre-run login, not a driver decision', async () => {
  const { adapter } = fakeAdapter();
  const steps = await performLogin(adapter, OPTS);
  expect(steps.every((s) => s.note?.includes('auth persona "admin"'))).toBe(true);
  expect(steps.every((s) => s.note?.includes("before the run's first step"))).toBe(true);
});

test('performLogin fails loud when a field selector resolves nothing', async () => {
  const { adapter } = fakeAdapter({ matches: (q) => !q.includes('password') });
  await expect(performLogin(adapter, OPTS)).rejects.toThrow(AuthError);
  await expect(performLogin(adapter, OPTS)).rejects.toThrow(/field 'password'/);
});

test('performLogin fails loud when the submit control resolves nothing', async () => {
  const { adapter } = fakeAdapter({ matches: (q) => !q.includes('Sign in') });
  await expect(performLogin(adapter, OPTS)).rejects.toThrow(/submit 'Sign in'/);
});

test('performLogin fails when submitting left the run on the login page', async () => {
  // The single worst outcome this guard exists to prevent: a signed-out run that
  // reports every screen behind the login as an empty page.
  const { adapter } = fakeAdapter({ landsOn: 'http://localhost:5173/login?error=1' });
  await expect(performLogin(adapter, { ...OPTS, timeoutMs: 300 })).rejects.toThrow(AuthError);
  await expect(performLogin(adapter, { ...OPTS, timeoutMs: 300 })).rejects.toThrow(/did not take/);
});

// --- the URL watch: the proof, not a single read --------------------------------

test('a login whose redirect lands LATE still signs the run in', async () => {
  // The defect: the proof read the URL ONCE, after a fixed settle slice, so a
  // valid login whose redirect landed later than that slice was reported as a
  // FAILED login — with the credentials blamed for a navigation that had simply
  // not happened yet.
  //
  // Here the page never goes idle (the POST is still in flight — a settle wait
  // that TIMES OUT is not a verdict) and the redirect lands only after MORE
  // than the whole 5s settle slice has passed, on a budget LONGER than the
  // slice. A proof still capped at the 5s slice ends before the redirect and
  // fails this test: the watch has to keep going for as long as its budget
  // says, and the trail must name where it landed.
  const { adapter } = fakeAdapter({
    settleFails: true,
    landsOnAfterMs: { url: 'http://localhost:5173/dashboard', afterMs: 5_500 },
  });
  const steps = await performLogin(adapter, { ...OPTS, timeoutMs: 15_000 });

  expect(steps.at(-1)?.step).toBe('signed in as "admin" → http://localhost:5173/dashboard');
  expect(steps.every((s) => s.ok)).toBe(true);
}, 20_000);

test('a redirect landing in the FINAL slice is still seen — one more read before giving up', async () => {
  // The loop's last act is a SLEEP, not a read: the final observation reads
  // the URL, then sleeps out what is left of the budget. A redirect landing
  // inside that sleep — 275ms on a 300ms budget — used to be missed: the loop
  // left without reading again and reported a FAILED login that blames the
  // credentials for a navigation that DID happen. The proof reads the URL one
  // more time before it reports the budget exhausted.
  const { adapter } = fakeAdapter({
    landsOnAfterMs: { url: 'http://localhost:5173/dashboard', afterMs: 275 },
  });
  const steps = await performLogin(adapter, { ...OPTS, timeoutMs: 300 });

  expect(steps.at(-1)?.step).toBe('signed in as "admin" → http://localhost:5173/dashboard');
  expect(steps.every((s) => s.ok)).toBe(true);
});

test('a login whose POST is registered late is not called a rejected login', async () => {
  // The click's POST is not registered as in-flight the instant the click is
  // dispatched, so the FIRST settle wait can observe an idle page while the
  // navigation is still to come. That is not a rejection — the proof keeps
  // watching until the page has been idle AND unmoved for the whole quiet
  // window, and the redirect that lands in that window is seen.
  const { adapter } = fakeAdapter({
    landsOnAfter: { url: 'http://localhost:5173/dashboard', afterObservations: 2 },
  });
  const steps = await performLogin(adapter, { ...OPTS, timeoutMs: 5_000 });

  expect(steps.at(-1)?.step).toBe('signed in as "admin" → http://localhost:5173/dashboard');
});

test('a login whose redirect is PENDING is not called a rejected login', async () => {
  // The shape the settle wait CANNOT see: the app answers the login POST and
  // goes idle, and only THEN navigates — on a timer, not on the network. The
  // page is idle the whole time, so Playwright's network-idle wait resolves
  // INSTANTLY on every observation.
  //
  // Reading the URL twice back to back therefore read it twice BEFORE the
  // timer fired, and the proof called a perfectly valid login a failed one —
  // blaming the credentials for a navigation that had not happened yet. The
  // proof has to WAIT for the redirect, not conclude from two adjacent reads.
  const { adapter } = fakeAdapter({
    landsOnAfterMs: { url: 'http://localhost:5173/dashboard', afterMs: 300 },
  });
  const steps = await performLogin(adapter, { ...OPTS, timeoutMs: 5_000 });

  expect(steps.at(-1)?.step).toBe('signed in as "admin" → http://localhost:5173/dashboard');
  expect(steps.every((s) => s.ok)).toBe(true);
});

test('a login that settles and then goes BUSY again keeps watching', async () => {
  // The page settled once, then went busy again: the app is STILL WORKING (a
  // slow request, a redirect being dispatched). A quiet streak that the page
  // interrupts is void — the proof must not call this a rejected login, and
  // must not fall back to blaming the credentials either.
  //
  // The redirect lands after the page went busy, so the proof has to keep
  // watching through the busy stretch to see it.
  const { adapter } = fakeAdapter({
    settleFailsAfter: 1,
    landsOnAfterMs: { url: 'http://localhost:5173/dashboard', afterMs: 300 },
  });
  const steps = await performLogin(adapter, { ...OPTS, timeoutMs: 5_000 });

  expect(steps.at(-1)?.step).toBe('signed in as "admin" → http://localhost:5173/dashboard');
});

test('a page that settled once and then stayed BUSY to the budget end is NOT a rejected login', async () => {
  // The quiet streak was INVALIDATED: the page went back to work after
  // settling and was STILL working when the budget ran out. That is not
  // evidence about the credentials — only quiet evidence that is CURRENT
  // (the streak was never interrupted) and complete may call the login
  // rejected — so this is the unresolved diagnostic, not the rejection.
  const { adapter } = fakeAdapter({ settleFailsAfter: 1, landsOn: LOGIN_URL });
  let thrown: unknown;
  try {
    await performLogin(adapter, { ...OPTS, timeoutMs: 300 });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AuthError);
  const message = (thrown as Error).message;
  expect(message).toMatch(/budget was exhausted/);
  expect(message).not.toMatch(/did not take/);
  expect(message).not.toMatch(/credentials/i);
});

test('the settled rejection waits for the page to STAY quiet, not for one adjacent read', async () => {
  // The settled rejection is a verdict about a page that has been idle AND
  // unmoved for the whole quiet window. It must NOT fire on the first settled
  // observation: that is the bug this proof exists to remove.
  //
  // The budget here is well past the quiet window, so the rejection comes from
  // the window itself and not from the budget running out.
  const { adapter } = fakeAdapter({ landsOn: 'http://localhost:5173/login?error=1' });
  const started = Date.now();
  let thrown: unknown;
  try {
    await performLogin(adapter, { ...OPTS, timeoutMs: 30_000 });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AuthError);
  expect((thrown as Error).message).toContain('did not take');
  // It waited for the page to stay put before blaming the credentials — it did
  // not conclude from the first adjacent pair of reads.
  expect(Date.now() - started).toBeGreaterThan(1_000);
});

test('the login shares ONE budget with the caller — it cannot overrun the cap it was handed', async () => {
  // The watch window used to be a FRESH budget started after the open, the
  // typing and the submit, so the login could take twice the cap it was given.
  // The whole login — open, fill, submit, watch — now fits inside it.
  //
  // RED-WHEN-REGRESSED: the setup spends half the cap (the fake `open` takes
  // 250ms of the 500ms). A watch that restarts the FULL budget after the
  // submit would be offered all 500ms and end ~750ms in; the shared deadline
  // offers it only the ~250ms that is left and ends at the original cap.
  const { adapter, calls } = fakeAdapter({
    settleFails: true,
    landsOn: LOGIN_URL,
    openDelayMs: 250,
  });
  const started = Date.now();
  await expect(performLogin(adapter, { ...OPTS, timeoutMs: 500 })).rejects.toThrow(AuthError);
  const elapsed = Date.now() - started;

  // The watch was offered only the REMAINDER, not the whole budget again.
  const settle = calls.find((c) => c.fn === 'waitFor' && c.arg === 'networkIdle');
  expect(settle?.timeout).toBeLessThanOrEqual(250);
  // …and the whole login finished within the ORIGINAL deadline — a fresh
  // 500ms watch started after the 250ms setup would run past 700ms.
  expect(elapsed).toBeLessThan(650);
});

test('a rejected login blames the credentials — the page settled and stayed put', async () => {
  // The page reached idle (the credentials POST came back 401, the app rendered
  // the error in place) and the URL is STILL the login page: the login did not
  // take, and the credentials are the first thing to check.
  const { adapter } = fakeAdapter({ landsOn: 'http://localhost:5173/login?error=1' });
  let thrown: unknown;
  try {
    await performLogin(adapter, { ...OPTS, timeoutMs: 300 });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AuthError);
  const message = (thrown as Error).message;
  // Names the persona, the URL and the submit control...
  expect(message).toContain("auth persona 'admin'");
  expect(message).toContain('http://localhost:5173/login');
  expect(message).toContain("submitting 'Sign in'");
  // ...and says the credentials are the thing to check.
  expect(message).toContain('did not take');
  expect(message).toContain('Check the credentials');
});

test('a login that never settles exhausts the budget WITHOUT blaming the credentials', async () => {
  // The URL never leaves the login page and the page never goes idle: the
  // navigation is UNRESOLVED, not refused. The budget is the cap, so the proof
  // ends there — and nothing measured here implicates the credentials, so the
  // error must not say they are wrong.
  const { adapter } = fakeAdapter({ settleFails: true, landsOn: LOGIN_URL });
  let thrown: unknown;
  try {
    await performLogin(adapter, { ...OPTS, timeoutMs: 300 });
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(AuthError);
  const message = (thrown as Error).message;
  // Names the persona and the URL, and says the budget ran out.
  expect(message).toContain("auth persona 'admin'");
  expect(message).toContain(LOGIN_URL);
  expect(message).toMatch(/never settled/);
  expect(message).toMatch(/budget was exhausted/);
  // …and does NOT blame the credentials: this measurement cannot implicate them.
  expect(message).not.toMatch(/did not take/);
  expect(message).not.toMatch(/credentials/i);
});

test('the exhausted diagnostic is a DIFFERENT one from the rejected-login diagnostic', async () => {
  // Two failures, two messages: a settled page that stayed on the login page is
  // a rejection; a page that never settled is not.
  const rejected = fakeAdapter({ landsOn: 'http://localhost:5173/login?error=1' });
  const unresolved = fakeAdapter({ settleFails: true, landsOn: LOGIN_URL });
  const message = async (adapter: Adapter, options: LoginOptions): Promise<string> => {
    try {
      await performLogin(adapter, options);
    } catch (error) {
      return (error as Error).message;
    }
    throw new Error('expected the login to fail');
  };

  const rejectedMessage = await message(rejected.adapter, { ...OPTS, timeoutMs: 300 });
  const unresolvedMessage = await message(unresolved.adapter, { ...OPTS, timeoutMs: 300 });
  expect(rejectedMessage).not.toBe(unresolvedMessage);
});

test('performLogin waits for `expect` instead of the URL when the persona declares one', async () => {
  const persona = { ...PERSONA, expect: 'text=Sign out' };
  // Stays on /login on purpose: `expect` is exactly the escape hatch for an app
  // that signs in without navigating.
  const { adapter, calls } = fakeAdapter({ landsOn: 'http://localhost:5173/login' });
  await performLogin(adapter, { ...OPTS, persona });
  expect(calls.some((c) => c.fn === 'waitFor' && c.arg === 'text=Sign out')).toBe(true);
});

test('performLogin fails loud when `expect` never appears', async () => {
  const persona = { ...PERSONA, expect: 'text=Sign out' };
  const { adapter } = fakeAdapter({ waitFails: true });
  await expect(performLogin(adapter, { ...OPTS, persona })).rejects.toThrow(
    /'text=Sign out' never appeared/,
  );
});

test('performLogin demands `expect` on a target that cannot report its location', async () => {
  const { adapter } = fakeAdapter({ noTabs: true });
  await expect(performLogin(adapter, OPTS)).rejects.toThrow(/set 'expect' on the persona/);
});
