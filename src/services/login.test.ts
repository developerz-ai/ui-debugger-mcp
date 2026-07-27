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
type Call = { fn: string; arg?: unknown; text?: string };

interface FakeOptions {
  /** Selectors that resolve to a node; everything else resolves to null. */
  matches?: (query: string) => boolean;
  /** URL reported as the active tab AFTER submit (before it is the login page). */
  landsOn?: string;
  /** No `tabs` method — a target with no tab concept. */
  noTabs?: boolean;
  /** Make `waitFor` reject (the `expect` proof never showing up). */
  waitFails?: boolean;
}

function fakeAdapter(options: FakeOptions = {}): { adapter: Adapter; calls: Call[] } {
  const calls: Call[] = [];
  const matches = options.matches ?? (() => true);
  let submitted = false;
  const node = (name: string): Node => ({
    role: 'textbox',
    name,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    enabled: true,
  });
  const adapter: Adapter = {
    open: async (target) => {
      calls.push({ fn: 'open', arg: target });
    },
    find: async (opts: Query) => {
      const query = opts.query ?? '';
      return matches(query) ? node(query) : null;
    },
    click: async (target) => {
      submitted = true;
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
      calls.push({ fn: 'waitFor', arg: opts.query ?? 'networkIdle' });
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
        url: submitted ? (options.landsOn ?? 'http://localhost:5173/dashboard') : OPTS.loginUrl,
        title: '',
        active: true,
      },
    ];
  }
  return { adapter, calls };
}

const OPTS: LoginOptions = {
  name: 'admin',
  persona: PERSONA,
  loginUrl: 'http://localhost:5173/login',
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
  await expect(performLogin(adapter, OPTS)).rejects.toThrow(AuthError);
  await expect(performLogin(adapter, OPTS)).rejects.toThrow(/did not take/);
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
