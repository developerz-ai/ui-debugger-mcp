/**
 * `redact.ts` — the value-keyed per-run redactor: the secrets a CONFIGURED auth
 * persona types into the app, masked out of every line that leaves the run.
 * Pure function only; the name-keyed HTTP redactors live next door in
 * `adapters/browser/log-format.ts`.
 */

import { expect, test } from 'bun:test';
import { createSecretRedactor } from './redact.js';

// --- credentials a persona TYPES --------------------------------------------

test('createSecretRedactor keeps a persona value out of the durable trail', () => {
  const redact = createSecretRedactor(['hunter2', 'admin@dev.local']);
  expect(redact('act type {"text":"hunter2"}')).toBe('act type {"text":"<redacted, 7 chars>"}');
  expect(redact('POST /login → 401 req="email=admin@dev.local"')).toContain('<redacted, 15 chars>');
  // Presence stays diagnostic, everything else untouched.
  expect(redact('POST /login → 401')).toBe('POST /login → 401');
});

test('createSecretRedactor covers the form-encoded and JSON-escaped spellings', () => {
  // A password with an `@` rides a form POST as `%40`; matching only the plain text
  // would leave the real body sitting in `logs/network.log`.
  const redact = createSecretRedactor(['p@ss word']);
  expect(redact('req="password:p%40ss%20word&next=/"')).not.toContain('p%40ss');
  // `application/x-www-form-urlencoded` spells a space `+`, not `%20`.
  expect(redact('req="password:p%40ss+word&next=/"')).not.toContain('p%40ss');
  const quoted = createSecretRedactor(['a"b\\c']);
  expect(quoted('req={"password":"a\\"b\\\\c"}')).not.toContain('a\\"b');
});

test('createSecretRedactor covers the browser form serializer and ASCII-only JSON', () => {
  // A real `<form>` POST percent-encodes `!'()~` too (URLSearchParams / the
  // urlencoded serializer), which `encodeURIComponent` leaves bare.
  const secret = "pa!ss wo(r)d~'é";
  const redact = createSecretRedactor([secret]);
  const form = new URLSearchParams({ password: secret }).toString();
  expect(redact(`req="${form}"`)).not.toContain('pa%21ss');
  // A backend echoing JSON with ASCII-only escaping (Python's json.dumps default).
  expect(redact('res={"password":"pa!ss wo(r)d~\'\\u00e9"}')).not.toContain('pa!ss');
});

test('createSecretRedactor redacts the longest value first', () => {
  // A value that CONTAINS another must still redact whole — shortest-first would
  // blank the inner one and leave the rest of the credential in the clear.
  const redact = createSecretRedactor(['secret', 'supersecretpass']);
  expect(redact('typed supersecretpass')).toBe('typed <redacted, 15 chars>');
});

test('createSecretRedactor is the identity when the run has no persona', () => {
  const redact = createSecretRedactor([]);
  const line = 'act type {"text":"hello"}';
  expect(redact(line)).toBe(line);
  expect(createSecretRedactor([''])(line)).toBe(line); // an empty value redacts nothing
});

test('createSecretRedactor leaves no fragment of two secrets that overlap in a line', () => {
  // Sequential replace blanked `abcXYZ`, after which `XYZdef` no longer matched — `def` leaked.
  const redact = createSecretRedactor(['abcXYZ', 'XYZdef']);
  expect(redact('typed abcXYZdef!')).toBe('typed <redacted, 9 chars>!');
});

test('createSecretRedactor never re-matches its own label', () => {
  // A short secret that occurs inside `<redacted, N chars>` must not mangle the label.
  const redact = createSecretRedactor(['re', 'supersecret']);
  expect(redact('a supersecret b re')).toBe('a <redacted, 11 chars> b <redacted, 2 chars>');
});

test('createSecretRedactor accepts a lone-surrogate secret and still redacts it', () => {
  // `encodeURIComponent` throws URIError on it; that spelling cannot occur on the wire.
  const secret = 'pw\ud800x';
  const redact = createSecretRedactor([secret]);
  expect(redact(`typed ${secret}`)).toBe('typed <redacted, 4 chars>');
  const form = new URLSearchParams({ p: secret }).toString();
  expect(redact(form)).toBe(`p=<redacted, ${form.length - 2} chars>`);
});

test('createSecretRedactor covers DEL in the ASCII-only JSON spelling', () => {
  // Python's ensure_ascii escapes everything outside space..tilde — DEL included.
  const redact = createSecretRedactor(['pw\u007fsynthetic']);
  expect(redact('res={"password":"pw\\u007fsynthetic"}')).not.toContain('synthetic');
});

test('createSecretRedactor merges dense overlapping matches into one label', () => {
  // Many spellings matching at nearly every offset of a long line — one span, one label.
  const line = `x${'ab'.repeat(50_000)}y`;
  const redact = createSecretRedactor(['ab', 'ba', 'aba']);
  expect(redact(line)).toBe(`x<redacted, ${line.length - 2} chars>y`);
});

test('createSecretRedactor matches the hex digits of generated escapes in either case', () => {
  // Escapes are case-insensitive by spec (RFC 3986 `%2f` == `%2F`, JSON `\u007F` ==
  // `\u007f`); encoders and loggers differ, and the other case leaked the secret.
  const del = createSecretRedactor(['pw\u007fsynthetic']);
  expect(del('res={"password":"pw\\u007Fsynthetic"}')).not.toContain('synthetic');
  const accent = createSecretRedactor(['cafésynthetic']);
  expect(accent('res={"password":"caf\\u00E9synthetic"}')).not.toContain('synthetic');
  const slash = createSecretRedactor(['a/bsynthetic']);
  expect(slash('req="password=a%2fbsynthetic"')).not.toContain('synthetic');
});

test('createSecretRedactor keeps literal secret characters case-sensitive', () => {
  const redact = createSecretRedactor(['Hunter2', 'x%2Fy']);
  expect(redact('typed hunter2')).toBe('typed hunter2');
  // A literal `%2F` typed in the secret is text, not an escape: `x%2fy` is another value.
  expect(redact('typed x%2fy')).toBe('typed x%2fy');
  // A literal backslash-u in the secret is text too — its JSON spelling is `\\u0041`.
  const literal = createSecretRedactor(['\\u0041']);
  expect(literal('res={"p":"\\\\u0061"}')).toBe('res={"p":"\\\\u0061"}');
  expect(literal('res={"p":"\\\\u0041"}')).toBe('res={"p":"<redacted, 7 chars>"}');
});

test('createSecretRedactor matches ANY per-character JSON escaping, not a list of encoders', () => {
  // System.Text.Json writes `&` `<` `'` as \u0026 \u003C \u0027; others escape `/` as `\/`;
  // an encoder may escape some characters and not others.
  const redact = createSecretRedactor(["a&b<c'd/e\u{1F600}synthetic"]);
  const leaks = (line: string) => redact(line).includes('synthetic');
  expect(leaks('{"p":"a\\u0026b\\u003Cc\\u0027d/e\\uD83D\\uDE00synthetic"}')).toBe(false);
  expect(leaks('{"p":"a&b\\u003cc\'d\\/e\\ud83d\\ude00synthetic"}')).toBe(false);
  expect(leaks('{"p":"\\u0061&b<c\'d\\u002Fe\u{1F600}synthetic"}')).toBe(false);
});

test('createSecretRedactor matches ANY per-character percent-encoding, either hex case', () => {
  const redact = createSecretRedactor(['a b/c\u00e9synthetic']);
  const leaks = (line: string) => redact(line).includes('synthetic');
  expect(leaks('p=a+b%2fc%C3%a9synthetic')).toBe(false);
  expect(leaks('p=a%20b/c%c3%A9synthetic')).toBe(false);
  expect(leaks('p=%61 b%2Fc\u00e9synthetic')).toBe(false);
});

test('createSecretRedactor stays linear on a 1 MB line (no pathological backtracking)', () => {
  // Backslash- and percent-heavy secrets are where an ambiguous alternation would explode.
  const redact = createSecretRedactor([
    '\\\\\\\\\\\\\\\\\\\\x',
    '%%%%%%%%%%x',
    'admin@example.test',
  ]);
  const line = '\\'.repeat(500_000) + '%'.repeat(500_000);
  const started = performance.now();
  expect(redact(line)).toBe(line);
  expect(performance.now() - started).toBeLessThan(5_000);
});

test('createSecretRedactor redacts an astral character bare, in both encoded families', () => {
  const redact = createSecretRedactor(['pw\u{1F600}synthetic']);
  expect(redact('typed pw\u{1F600}synthetic')).toBe('typed <redacted, 13 chars>');
  expect(redact('p=pw%F0%9F%98%80synthetic')).toBe('p=<redacted, 23 chars>');
});

test('createSecretRedactor redacts the U+FFFD form a browser sends for a lone surrogate', () => {
  // The browser replaces the lone surrogate with U+FFFD; a JSON echo of THAT
  // value (bare, or as �) is the same secret.
  const redact = createSecretRedactor(['pw\ud800synthetic']);
  expect(redact('res={"p":"pw�synthetic"}')).toBe('res={"p":"<redacted, 12 chars>"}');
  expect(redact('res={"p":"pw\\uFFFDsynthetic"}')).toBe('res={"p":"<redacted, 17 chars>"}');
});

/** --- credential spellings never reach any durable trail ------------------- */

test('redaction binds per-run: each runner sees only its own secret masked', () => {
  const aRedact = createSecretRedactor(['runner-alpha-secret']);
  const bRedact = createSecretRedactor(['runner-beta-secret']);

  // Each run redacts ONLY its own credential; the other run's value passes through untouched.
  expect(aRedact('act type {"text":"runner-alpha-secret"}')).toBe(
    'act type {"text":"<redacted, 19 chars>"}',
  );
  expect(bRedact('act type {"text":"runner-alpha-secret"}')).toBe(
    'act type {"text":"runner-alpha-secret"}',
  );
  expect(bRedact('act type {"text":"runner-beta-secret"}')).toBe(
    'act type {"text":"<redacted, 18 chars>"}',
  );
  expect(aRedact('act type {"text":"runner-beta-secret"}')).toBe(
    'act type {"text":"runner-beta-secret"}',
  );
});

test('a raw credential never reaches session logs, findings, or diagnostic output', () => {
  const redact = createSecretRedactor(['hunter2']);

  const sessionLog = 'POST /login → 200 set-cookie=session=abc hunter2';
  const persistedFinding = 'bug: user can type "hunter2" into the password field';
  const diagnosticOutput = 'act type {"text":"hunter2","field":"password"}';

  for (const trail of [sessionLog, persistedFinding, diagnosticOutput]) {
    expect(redact(trail)).not.toContain('hunter2');
    expect(redact(trail)).toContain('<redacted, 7 chars>');
  }
});

test('a percent-encoded credential is redacted from every trail', () => {
  const redact = createSecretRedactor(['p@ss']);

  const sessionLog = 'POST /login req=email%3Duser%40example.com%26pass%3Dp%40ss';
  const persistedFinding = 'network: p%40ss seen in the request body';
  const diagnosticOutput = 'form: password=p%40ss&next=/dashboard';

  for (const trail of [sessionLog, persistedFinding, diagnosticOutput]) {
    const out = redact(trail);
    expect(out).not.toContain('p@ss');
    expect(out).not.toContain('p%40ss');
    expect(out).not.toContain('p%40');
    expect(out).toContain('<redacted, 6 chars>');
  }
});

test('a +-for-space credential spelling is redacted from every trail', () => {
  const redact = createSecretRedactor(['pass word']);

  const sessionLog = 'POST /login req=password:pass+word&next=/';
  const persistedFinding = 'console: typed pass+word into the field';
  const diagnosticOutput = 'act type {"text":"pass+word"}';

  for (const trail of [sessionLog, persistedFinding, diagnosticOutput]) {
    const out = redact(trail);
    expect(out).not.toContain('pass word');
    expect(out).not.toContain('pass+word');
    expect(out).not.toContain('pass%20word');
    expect(out).toContain('<redacted, 9 chars>');
  }
});

test('a JSON-escaped credential spelling is redacted from every trail', () => {
  const redact = createSecretRedactor(['a"b\\c']);

  const sessionLog = 'POST {"password":"a\\"b\\\\c"}';
  const persistedFinding = 'error: could not parse {"password":"a\\"b\\\\c"}';
  const diagnosticOutput = 'act type {"text":"a\\"b\\\\c","field":"password"}';

  for (const trail of [sessionLog, persistedFinding, diagnosticOutput]) {
    const out = redact(trail);
    expect(out).not.toContain('a"b\\c');
    expect(out).not.toContain('a\\"b');
    expect(out).not.toContain('b\\\\c');
    expect(out).toContain('<redacted, 7 chars>');
  }
});
