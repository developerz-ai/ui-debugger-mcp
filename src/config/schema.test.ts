import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  AndroidTargetSchema,
  ConfigSchema,
  DesktopTargetSchema,
  ModelsSchema,
  TARGET_NOTES_MAX_CHARS,
  TargetSchema,
  WebTargetSchema,
} from './schema.js';

const example = JSON.parse(
  readFileSync(new URL('../../.ui-debugger-mcp.example.json', import.meta.url), 'utf8'),
);

test('accepts the example config verbatim', () => {
  const parsed = ConfigSchema.parse(example);
  expect(parsed.targets.web?.adapter).toBe('browser');
  expect(parsed.models?.driver).toBe('deepseek/deepseek-v4-flash');
  expect(parsed.workspace).toBe('./tmp/ui-debugger-mcp');
});

test('ModelsSchema: summary is optional, driver and vision required', () => {
  expect(ModelsSchema.safeParse({ driver: 'a', vision: 'b' }).success).toBe(true);
  expect(ModelsSchema.safeParse({ driver: 'a' }).success).toBe(false);
});

test('WebTargetSchema: requires a valid url and the browser adapter literal', () => {
  const base = { adapter: 'browser', url: 'http://localhost:3000', headless: true };
  expect(WebTargetSchema.safeParse(base).success).toBe(true);
  expect(WebTargetSchema.safeParse({ ...base, url: 'not-a-url' }).success).toBe(false);
  expect(WebTargetSchema.safeParse({ ...base, adapter: 'desktop' }).success).toBe(false);
});

test('WebTargetSchema: executablePath and cdpUrl accept null', () => {
  const parsed = WebTargetSchema.parse({
    adapter: 'browser',
    url: 'http://localhost:3000',
    headless: false,
    executablePath: null,
    cdpUrl: null,
  });
  expect(parsed.executablePath).toBeNull();
  expect(parsed.cdpUrl).toBeNull();
});

test('WebTargetSchema: headless is optional and defaults to true', () => {
  const minimal = WebTargetSchema.safeParse({ adapter: 'browser', url: 'http://x.test' });
  expect(minimal.success).toBe(true);
  expect(minimal.data?.headless).toBe(true);
  // An explicit false still wins — the default only fills an absent key.
  expect(WebTargetSchema.parse({ adapter: 'browser', headless: false }).headless).toBe(false);
});

test('WebTargetSchema: profile is optional but never empty', () => {
  const base = { adapter: 'browser', url: 'http://x.test' };
  expect(WebTargetSchema.parse(base).profile).toBeUndefined();
  expect(WebTargetSchema.parse({ ...base, profile: 'other-profile' }).profile).toBe(
    'other-profile',
  );
  expect(WebTargetSchema.safeParse({ ...base, profile: '' }).success).toBe(false);
});

// --- named auth personas (`start_debug({as})`) -------------------------------

const persona = {
  path: '/login',
  fields: { email: 'admin@dev.local', password: 'admin' },
  submit: 'Sign in',
};

test('WebTargetSchema: auth is an optional map of named personas', () => {
  const base = { adapter: 'browser', url: 'http://x.test' };
  expect(WebTargetSchema.parse(base).auth).toBeUndefined();

  const parsed = WebTargetSchema.parse({
    ...base,
    auth: { admin: persona, user: { ...persona, expect: 'text=Sign out' } },
  });
  expect(Object.keys(parsed.auth ?? {})).toEqual(['admin', 'user']);
  expect(parsed.auth?.admin?.fields.email).toBe('admin@dev.local');
  expect(parsed.auth?.user?.expect).toBe('text=Sign out');
});

test('WebTargetSchema: a persona needs path, at least one field, and a submit', () => {
  const base = { adapter: 'browser', url: 'http://x.test' };
  const bad = (auth: unknown) => WebTargetSchema.safeParse({ ...base, auth }).success;

  expect(bad({ admin: { ...persona, path: '' } })).toBe(false);
  expect(bad({ admin: { ...persona, submit: '' } })).toBe(false);
  // An empty `fields` would submit a blank form and read as bad credentials.
  expect(bad({ admin: { ...persona, fields: {} } })).toBe(false);
  expect(bad({ admin: { path: '/login', fields: { email: 'a' } } })).toBe(false); // no submit
  // Strict: a typo'd key must not be silently ignored — it would run signed out.
  expect(bad({ admin: { ...persona, sumbit: 'Sign in' } })).toBe(false);
  // A nameless persona is unaddressable by `as`.
  expect(bad({ '': persona })).toBe(false);
});

test('ConfigSchema: personas survive the discriminated union', () => {
  const parsed = ConfigSchema.parse({
    targets: {
      dashboard: { adapter: 'browser', url: 'http://localhost:5173', auth: { admin: persona } },
    },
  });
  const target = parsed.targets.dashboard;
  expect(target?.adapter === 'browser' && target.auth?.admin?.submit).toBe('Sign in');
});

// --- target notes (standing preconditions) ----------------------------------

test('every adapter takes `notes` — a wizard on first launch is not a web-only fact', () => {
  const notes = 'needs seeded data — empty tables are expected on /new';
  expect(WebTargetSchema.parse({ adapter: 'browser', url: 'http://x.test', notes }).notes).toBe(
    notes,
  );
  expect(DesktopTargetSchema.parse({ adapter: 'desktop', launch: 'app', notes }).notes).toBe(notes);
  expect(AndroidTargetSchema.parse({ adapter: 'android', avd: 'my-avd', notes }).notes).toBe(notes);
  // Optional everywhere, and never empty — a blank section would be prompt weight
  // for nothing.
  expect(WebTargetSchema.parse({ adapter: 'browser', url: 'http://x.test' }).notes).toBeUndefined();
  expect(
    WebTargetSchema.safeParse({ adapter: 'browser', url: 'http://x.test', notes: '' }).success,
  ).toBe(false);
});

test('notes over the cap fail at config validation, saying why', () => {
  // The prompt carrying notes is resent on EVERY step, so an essay pasted here is
  // paid for per step for the whole run. Bounded loud at the boundary, never
  // silently truncated — a caller must know which half the driver was told.
  const base = { adapter: 'browser', url: 'http://x.test' };
  expect(
    WebTargetSchema.safeParse({ ...base, notes: 'x'.repeat(TARGET_NOTES_MAX_CHARS) }).success,
  ).toBe(true);
  const over = WebTargetSchema.safeParse({
    ...base,
    notes: 'x'.repeat(TARGET_NOTES_MAX_CHARS + 1),
  });
  expect(over.success).toBe(false);
  expect(over.error?.issues[0]?.message).toContain(`${TARGET_NOTES_MAX_CHARS} characters`);
  expect(over.error?.issues[0]?.message).toContain('every step');
});

test('ConfigSchema: notes survive the discriminated union', () => {
  const parsed = ConfigSchema.parse({
    targets: {
      dashboard: {
        adapter: 'browser',
        url: 'http://localhost:5173',
        notes: 'dark mode by default',
      },
    },
  });
  expect(parsed.targets.dashboard?.notes).toBe('dark mode by default');
});

test('DesktopTargetSchema: launch required; window match and display optional', () => {
  const base = { adapter: 'desktop', launch: 'my-app' };
  expect(DesktopTargetSchema.safeParse(base).success).toBe(true); // minimal still valid
  expect(DesktopTargetSchema.safeParse({ adapter: 'desktop' }).success).toBe(false); // launch required

  const parsed = DesktopTargetSchema.parse({
    ...base,
    window: { title: 'My App', class: 'my-app' },
    display: ':99',
  });
  expect(parsed.window?.title).toBe('My App');
  expect(parsed.display).toBe(':99');
});

test('DesktopTargetSchema: display accepts null, strict rejects unknown keys', () => {
  expect(
    DesktopTargetSchema.safeParse({ adapter: 'desktop', launch: 'a', display: null }).success,
  ).toBe(true);
  expect(
    DesktopTargetSchema.safeParse({ adapter: 'desktop', launch: 'a', window: { role: 'x' } })
      .success,
  ).toBe(false); // window match is strict too
  expect(DesktopTargetSchema.safeParse({ adapter: 'desktop', launch: 'a', bogus: 1 }).success).toBe(
    false,
  );
});

// --- the desktop launch contract, pinned on the doc comment -------------------

const schemaSource = readFileSync(new URL('./schema.ts', import.meta.url), 'utf8');

/**
 * The doc comment immediately above `marker` in `source`.
 *
 * Returns '' when it cannot be located, so a caller can FAIL on the missing
 * comment — a guard that skips its own assertions is worse than no guard.
 */
function docCommentAbove(source: string, marker: string): string {
  const declaration = source.indexOf(marker);
  if (declaration === -1) return '';
  const before = source.slice(0, declaration);
  const start = before.lastIndexOf('/**');
  if (start === -1) return '';
  const end = before.indexOf('*/', start);
  if (end === -1) return '';
  // Only whitespace may sit between the comment and the declaration it documents.
  if (before.slice(end + 2).trim() !== '') return '';
  return before.slice(start, end + 2);
}

/**
 * Assert the desktop launch contract is stated by the given doc comment.
 *
 * Throws on any drift: the command-side rule (the launch command stays in the
 * foreground and does not daemonize or background itself), the shell patterns to
 * avoid, or the adapter's own `detached: true` spawn being read as a ban. The
 * comment text is a PARAMETER — the caller reads it out of the source — so a
 * test can feed this a mutated copy.
 */
function assertLaunchContractStated(comment: string): void {
  const missing: string[] = [];
  if (comment.trim() === '') missing.push('the doc comment is missing');
  if (!/launch/i.test(comment)) {
    missing.push('it never says the rule is about the launch command');
  }
  if (!/foreground/i.test(comment)) {
    missing.push('it does not say the launch command stays in the foreground');
  }
  if (!/daemoniz/i.test(comment)) {
    missing.push('it does not forbid the command to daemonize itself');
  }
  if (!/background/i.test(comment)) {
    missing.push('it does not forbid the command to background itself');
  }
  // The shell patterns to avoid, named as such.
  for (const pattern of ['`&`', '`nohup`', '`setsid`']) {
    if (!comment.includes(pattern)) {
      missing.push(`it does not name ${pattern} as a pattern to avoid`);
    }
  }
  // The adapter spawns the command with `detached: true` ON PURPOSE — it owns
  // that process group and kills the whole group in `close()`. The comment must
  // not read as a ban on that flag, so the word may not appear here at all.
  if (/detached/i.test(comment)) {
    missing.push('it names `detached`, which is the spawn flag the adapter uses itself');
  }
  if (missing.length > 0) {
    throw new Error(
      `the DesktopTargetSchema doc comment misses the launch contract: ${missing.join('; ')}`,
    );
  }
}

test('DesktopTargetSchema: the doc comment states the foreground launch contract', () => {
  const comment = docCommentAbove(schemaSource, 'export const DesktopTargetSchema');

  // Extraction fails LOUD: an empty comment would leave every wording
  // assertion below unchecked instead of guarding anything.
  expect(comment.length).toBeGreaterThan(0);

  assertLaunchContractStated(comment);
});

test('the launch-contract guard rejects the pre-fix comment', () => {
  // The wording this guard replaces: it read as a ban on the adapter's own
  // `detached: true` spawn and never named `setsid`.
  const preFix = `/**
 * Desktop target — X11/Xvfb + Wayland adapter. Managed launch.
 *
 * **Launch must stay foreground** (no daemonization via \`detached:true\`, \`&\`, \`nohup\`).
 */`;

  expect(() => assertLaunchContractStated(preFix)).toThrow(/detached/);
  expect(() => assertLaunchContractStated(preFix)).toThrow(/setsid/);
  expect(() => assertLaunchContractStated(preFix)).toThrow(/background/);
});

test('docCommentAbove: returns "" when the comment cannot be located', () => {
  // The marker is not in the source at all.
  expect(docCommentAbove(schemaSource, 'export const NoSuchSchema')).toBe('');
  // No block comment precedes the declaration.
  expect(docCommentAbove('const x = 1;\n', 'const x')).toBe('');
  // The block comment is never closed.
  expect(docCommentAbove('/** unterminated\nconst x = 1;\n', 'const x')).toBe('');
  // The nearest block comment documents another declaration, not this one.
  expect(docCommentAbove('/** doc */\nconst other = 1;\nconst x = 2;\n', 'const x')).toBe('');
});

test('AndroidTargetSchema: attach needs no `avd`, managed does', () => {
  // A physical device is `{adapter, adbSerial}` — attach binds straight to the serial and
  // never reads `avd`, so demanding one forced users to invent a fake AVD name.
  expect(
    AndroidTargetSchema.safeParse({ adapter: 'android', adbSerial: 'R58M12345' }).success,
  ).toBe(true);
  expect(AndroidTargetSchema.safeParse({ adapter: 'android', avd: 'my-avd' }).success).toBe(true);

  const managed = AndroidTargetSchema.safeParse({ adapter: 'android' });
  expect(managed.success).toBe(false); // managed still requires it, where the rule is real
  expect(managed.error?.issues[0]?.path).toEqual(['avd']);
  // `adbSerial: null` means "not attached" — managed rules apply.
  expect(AndroidTargetSchema.safeParse({ adapter: 'android', adbSerial: null }).success).toBe(
    false,
  );
  // The refinement survives the discriminated union (config goes through TargetSchema).
  expect(TargetSchema.safeParse({ adapter: 'android', adbSerial: 'R58M12345' }).success).toBe(true);
  expect(TargetSchema.safeParse({ adapter: 'android' }).success).toBe(false);
});

test('TargetSchema: discriminates desktop and android, rejects unknown adapters', () => {
  expect(TargetSchema.safeParse({ adapter: 'desktop', launch: 'app' }).success).toBe(true);
  expect(TargetSchema.safeParse({ adapter: 'android', avd: 'my-avd' }).success).toBe(true);
  expect(TargetSchema.safeParse({ adapter: 'ios', url: 'http://x.test' }).success).toBe(false);
});

test('ConfigSchema: models and workspace optional, targets required', () => {
  const minimal = {
    targets: { web: { adapter: 'browser', url: 'http://x.test', headless: true } },
  };
  expect(ConfigSchema.safeParse(minimal).success).toBe(true);
  expect(ConfigSchema.safeParse({ models: { driver: 'a', vision: 'b' } }).success).toBe(false);
});

test('ConfigSchema: a target needs a name — an empty key is unaddressable', () => {
  // start_debug names targets, and the session builder resolves them via
  // Object.hasOwn(config.targets, name) — a nameless target can never be
  // addressed, so it must fail loud here, not sit in config as dead weight.
  const rejected = ConfigSchema.safeParse({
    targets: { '': { adapter: 'browser', url: 'http://x.test' } },
  });
  expect(rejected.success).toBe(false);
  expect(rejected.error?.issues[0]?.path).toContain(''); // issue names the empty key
  expect(
    ConfigSchema.safeParse({
      targets: { web: { adapter: 'browser', url: 'http://x.test' } },
    }).success,
  ).toBe(true); // nonempty names still parse
});
