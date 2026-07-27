/**
 * `log-format.ts` — level normalization, body truncation, the two `logs/*.log`
 * line renderers, and the URL/header redactors. Pure functions only; the capture
 * class that feeds them is exercised in `cdp.test.ts`.
 */

import { expect, test } from 'bun:test';
import {
  createSecretRedactor,
  formatConsoleLine,
  formatNetworkLine,
  normalizeConsoleLevel,
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
  expect(redact('req="password=p%40ss%20word&next=/"')).not.toContain('p%40ss');
  // `application/x-www-form-urlencoded` spells a space `+`, not `%20`.
  expect(redact('req="password=p%40ss+word&next=/"')).not.toContain('p%40ss');
  const quoted = createSecretRedactor(['a"b\\c']);
  expect(quoted('req={"password":"a\\"b\\\\c"}')).not.toContain('a\\"b');
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
  // Nothing sensitive, nothing touched — the URL stays the driver's landmark.
  expect(redactUrl('https://app/users?page=2')).toBe('https://app/users?page=2');
  expect(redactUrl('https://app/users')).toBe('https://app/users');
});
