/**
 * `log-format.ts` — level normalization, body truncation, the two `logs/*.log`
 * line renderers, and the URL/header redactors. Pure functions only; the capture
 * class that feeds them is exercised in `cdp.test.ts`.
 */

import { expect, test } from 'bun:test';
import {
  formatConsoleLine,
  formatNetworkLine,
  normalizeConsoleLevel,
  redactBody,
  redactHeaders,
  redactUrl,
  truncateBody,
} from './log-format.js';

// --- normalizeConsoleLevel --------------------------------------------------

test('normalizeConsoleLevel maps CDP types to normalized levels', () => {
  expect(normalizeConsoleLevel('error')).toBe('error');
  expect(normalizeConsoleLevel('assert')).toBe('error');
  expect(normalizeConsoleLevel('warning')).toBe('warn');
  expect(normalizeConsoleLevel('info')).toBe('info');
  expect(normalizeConsoleLevel('debug')).toBe('debug');
  expect(normalizeConsoleLevel('log')).toBe('log');
  expect(normalizeConsoleLevel('table')).toBe('log');
});

// --- line formatting --------------------------------------------------------

test('formatConsoleLine renders level, text, and location', () => {
  expect(
    formatConsoleLine({ level: 'error', text: 'boom', location: 'app.js:1:2', timestamp: 0 }),
  ).toBe('1970-01-01T00:00:00.000Z ERROR boom @ app.js:1:2');
});

test('formatConsoleLine omits location when absent', () => {
  expect(formatConsoleLine({ level: 'log', text: 'hi', timestamp: 0 })).toBe(
    '1970-01-01T00:00:00.000Z LOG hi',
  );
});

test('formatConsoleLine puts the tab marker between the timestamp and the level', () => {
  expect(
    formatConsoleLine({
      level: 'error',
      text: 'boom',
      location: 'app.js:1:2',
      timestamp: 0,
      tab: 'tab-1',
    }),
  ).toBe('1970-01-01T00:00:00.000Z [tab-1] ERROR boom @ app.js:1:2');
});

test('formatConsoleLine keeps the marker last-but-one when there is no location', () => {
  expect(formatConsoleLine({ level: 'log', text: 'hi', timestamp: 0, tab: 'tab-3' })).toBe(
    '1970-01-01T00:00:00.000Z [tab-3] LOG hi',
  );
});

test('formatNetworkLine renders status and resourceType', () => {
  expect(
    formatNetworkLine({
      method: 'GET',
      url: 'http://x/a',
      status: 200,
      ok: true,
      resourceType: 'fetch',
      timestamp: 0,
    }),
  ).toBe('1970-01-01T00:00:00.000Z GET http://x/a → 200 [fetch]');
});

test('formatNetworkLine renders failures', () => {
  expect(
    formatNetworkLine({
      method: 'POST',
      url: 'http://x/b',
      status: 0,
      ok: false,
      error: 'net::ERR',
      timestamp: 0,
    }),
  ).toBe('1970-01-01T00:00:00.000Z POST http://x/b → FAILED net::ERR');
});

test('formatNetworkLine puts the tab marker between the timestamp and the method', () => {
  expect(
    formatNetworkLine({
      method: 'GET',
      url: 'http://x/a',
      status: 200,
      ok: true,
      resourceType: 'fetch',
      timestamp: 0,
      tab: 'tab-2',
    }),
  ).toBe('1970-01-01T00:00:00.000Z [tab-2] GET http://x/a → 200 [fetch]');
});

test('formatNetworkLine keeps the marker on a failed exchange too', () => {
  expect(
    formatNetworkLine({
      method: 'POST',
      url: 'http://x/b',
      status: 0,
      ok: false,
      error: 'net::ERR',
      timestamp: 0,
      tab: 'tab-2',
    }),
  ).toBe('1970-01-01T00:00:00.000Z [tab-2] POST http://x/b → FAILED net::ERR');
});

test('formatNetworkLine carries duration + the payloads of a failure', () => {
  expect(
    formatNetworkLine({
      method: 'POST',
      url: 'http://x/api/login',
      status: 401,
      ok: false,
      resourceType: 'fetch',
      timestamp: 0,
      durationMs: 42,
      requestBody: '{"email":"a"}',
      responseBody: '{"error":"bad creds"}',
    }),
  ).toBe(
    '1970-01-01T00:00:00.000Z POST http://x/api/login → 401 [fetch] 42ms ' +
      'req="{\\"email\\":\\"a\\"}" res="{\\"error\\":\\"bad creds\\"}"',
  );
});

test('truncateBody marks what it dropped', () => {
  expect(truncateBody('abcdef', 3)).toBe('abc…[truncated, 6 chars total]');
  expect(truncateBody('abc', 3)).toBe('abc');
});

// --- credentials in URLs ----------------------------------------------------

test('redactUrl keeps sensitive query VALUES out, and everything else intact', () => {
  expect(redactUrl('https://app/callback?code=4/0AeSecretGrant&state=xyz')).toBe(
    'https://app/callback?code=<redacted, 16 chars>&state=xyz',
  );
  expect(redactUrl('https://api/x?apikey=eyJhbGciOi&page=2')).toBe(
    'https://api/x?apikey=<redacted, 10 chars>&page=2',
  );
  expect(redactUrl('https://s3/o.png?X-Amz-Signature=deadbeef&X-Amz-Expires=60')).toBe(
    'https://s3/o.png?X-Amz-Signature=<redacted, 8 chars>&X-Amz-Expires=60',
  );
  expect(redactUrl('https://app/reset?token=abc123def456&page=2')).toBe(
    'https://app/reset?token=<redacted, 12 chars>&page=2',
  );
  expect(redactUrl('https://app/oauth?access_token=SECRET123&expires_in=3600')).toBe(
    'https://app/oauth?access_token=<redacted, 9 chars>&expires_in=3600',
  );
  // Nothing sensitive, nothing touched — the URL stays the driver's landmark.
  expect(redactUrl('https://app/users?page=2')).toBe('https://app/users?page=2');
  expect(redactUrl('https://app/users')).toBe('https://app/users');
});

// --- credentials in headers -------------------------------------------------

test('redactHeaders masks every credential header, case-insensitively, and nothing else', () => {
  const secret = 's3cr3t';
  const names = [
    'Authorization',
    'proxy-authorization',
    'Cookie',
    'SET-COOKIE',
    'apikey',
    'api-key',
    'X-API-Key',
    'x-goog-api-key',
    'x-auth-token',
    'X-Access-Token',
    'x-refresh-token',
    'x-session-token',
    'x-csrf-token',
    'X-XSRF-TOKEN',
    'x-amz-security-token',
  ];
  const out = redactHeaders({
    ...Object.fromEntries(names.map((name) => [name, secret])),
    accept: 'application/json',
    'x-request-id': 'abc',
  });
  for (const name of names) expect(out[name]).toBe('<redacted, 6 chars>');
  expect(out.accept).toBe('application/json');
  expect(out['x-request-id']).toBe('abc');
});

// --- one entry, one line ------------------------------------------------------

test('formatNetworkLine folds every page-controlled line break — no forged log lines', () => {
  const forged = '\n2026-01-01T00:00:00.000Z [tab-1] GET /admin → 200';
  const breaks = (line: string) => /[\r\n\u2028\u2029]/.test(line);
  const failed = formatNetworkLine({
    method: `GET${forged}`,
    url: `http://x/a\r${forged}`,
    status: 0,
    ok: false,
    error: `boom\u2028${forged}`,
    requestBody: `{"a":"\u2029"}`,
    timestamp: 0,
  });
  expect(breaks(failed)).toBe(false);
  const answered = formatNetworkLine({
    method: 'POST',
    url: 'http://x/b',
    status: 500,
    ok: false,
    resourceType: 'fetch',
    requestBody: 'line\u2028two',
    responseBody: `oops\u2029${forged}`,
    timestamp: 0,
  });
  expect(breaks(answered)).toBe(false);
  expect(answered).toContain('oops\\n');
});

// --- credentials in bodies ---------------------------------------------------

test('redactBody masks credential-keyed JSON values at any depth, case- and separator-blind', () => {
  expect(
    redactBody(
      '{"Password":"hunter2","user":{"client_secret":"s3","api-key":12345},"list":[{"idToken":"t"}],"name":"bob","otp":null}',
    ),
  ).toBe(
    '{"Password":"<redacted, 7 chars>","user":{"client_secret":"<redacted, 2 chars>","api-key":"<redacted, 5 chars>"},"list":[{"idToken":"<redacted, 1 chars>"}],"name":"bob","otp":null}',
  );
});

test('redactBody masks form-urlencoded credentials, bracketed and percent-encoded keys too', () => {
  expect(redactBody('email=a%40b.c&password=hunter2&remember=1')).toBe(
    'email=a%40b.c&password=<redacted, 7 chars>&remember=1',
  );
  expect(redactBody('user%5Bpassword%5D=pw&user[name]=bob')).toBe(
    'user%5Bpassword%5D=<redacted, 2 chars>&user[name]=bob',
  );
});

test('redactBody leaves everything without a credential byte-for-byte untouched', () => {
  for (const body of [
    '{ "name": "bob",\n  "age": 3 }',
    'password=hunter2 is what I typed',
    '<html>password: hunter2</html>',
    '{"broken": ',
    '',
  ]) {
    expect(redactBody(body)).toBe(body);
  }
});

test('redactBody masks array fields and every bracket segment (`password[]`, `creds[password][0]`)', () => {
  expect(redactBody('password[]=hunter2&user=bob')).toBe('password[]=<redacted, 7 chars>&user=bob');
  expect(redactBody('password%5B%5D=pw')).toBe('password%5B%5D=<redacted, 2 chars>');
  expect(redactBody('creds[password][0]=pw')).toBe('creds[password][0]=<redacted, 2 chars>');
});

test('redactBody accepts every valid form shape: trailing `&`, empty pairs, bare keys', () => {
  expect(redactBody('email=a&password=hunter2&')).toBe('email=a&password=<redacted, 7 chars>&');
  expect(redactBody('&password=pw&&remember')).toBe('&password=<redacted, 2 chars>&&remember');
  expect(redactBody('remember')).toBe('remember');
});

test('redactBody never returns a duplicate-key JSON body whose parse hid the secret', () => {
  const out = redactBody('{"password":"hunter2","password":null}');
  expect(out).not.toContain('hunter2');
  expect(out).toBe('{"password":null}');
});

test('no valid urlencoded shape bypasses form masking — empty names, stray `=`, odd separators', () => {
  // [input, expected]: every one is a body a server would parse as a form.
  const table: Array<[string, string]> = [
    ['=x&password=hunter2', '=x&password=<redacted, 7 chars>'],
    ['&=&password=hunter2', '&=&password=<redacted, 7 chars>'],
    ['=&=&password=pw', '=&=&password=<redacted, 2 chars>'],
    ['password=a=b=c', 'password=<redacted, 5 chars>'],
    ['password=', 'password=<redacted, 0 chars>'],
    ['a&password=pw&b', 'a&password=<redacted, 2 chars>&b'],
    ['==&token=t0k', '==&token=<redacted, 3 chars>'],
    ['password=%F0%9F%94%91', 'password=<redacted, 12 chars>'],
    ['pass%77ord=pw', 'pass%77ord=<redacted, 2 chars>'],
    ['password=pw%', 'password=<redacted, 3 chars>'],
    ['%zz=1&password=pw', '%zz=1&password=<redacted, 2 chars>'],
    ['%zz%5Bpassword%5D=pw', '%zz%5Bpassword%5D=<redacted, 2 chars>'],
    ['pass+word=x&pass_word=pw', 'pass+word=x&pass_word=<redacted, 2 chars>'],
  ];
  for (const [input, expected] of table) expect(redactBody(input)).toBe(expected);
});

test('a declared form content type masks even a sloppy body with raw spaces', () => {
  const type = 'application/x-www-form-urlencoded; charset=UTF-8';
  expect(redactBody('user=bob smith&password=hunter 2', type)).toBe(
    'user=bob smith&password=<redacted, 8 chars>',
  );
  // Without the header, prose with a raw space is not a form.
  expect(redactBody('password=hunter 2 is what I typed')).toBe('password=hunter 2 is what I typed');
});
