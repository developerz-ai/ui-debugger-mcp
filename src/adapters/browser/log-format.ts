/**
 * Rendering + redaction for captured console/network entries.
 *
 * Split out of `cdp.ts` to keep that file under the 500-LOC cap — no behavior
 * change. Everything here is pure: level normalization, body truncation, the
 * `logs/network.log` line renderer, and the two redactors that keep a credential
 * out of the model's context and out of the durable trail (a secret in a header
 * VALUE, or in a query param of the URL itself).
 *
 * The console-line renderer is SHARED (the android logcat drain renders the
 * same shape), so it lives in `src/adapters/log-format.ts` and is re-exported
 * here — every existing reader keeps its import path.
 *
 * Both renderers put the TAB MARKER between the timestamp and the row
 * (`<ISO> [tab-1] LEVEL text @ location`, `<ISO> [tab-1] METHOD url → 200 …`),
 * so a line says which tab produced it. The marker is an opaque label — no
 * URL, no title, no secret — and a row without a tab renders exactly as it did
 * before the marker existed.
 */

import type { ConsoleEntry, NetworkEntry } from '../contract.js';
import { oneLine, stamp, tabMarker } from '../log-format.js';

export { formatConsoleLine } from '../log-format.js';

/**
 * Per-body character cap. Big enough for an error payload or a small collection,
 * small enough that the driver re-reading tool results every step cannot drown.
 */
export const BODY_CAP = 4096;

/**
 * Header names whose VALUE is a credential — kept as a length marker, never verbatim.
 * Beyond the standard auth/cookie pair: the API-key spellings hosted backends send
 * from the browser (Supabase `apikey`, Google `x-goog-api-key`), the CSRF/XSRF pair
 * (Angular/Laravel send `x-xsrf-token`), bearer-ish custom headers, and the AWS
 * session token a presigned/SigV4 request carries.
 */
const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|apikey|api-key|x-api-key|x-goog-api-key|x-auth-token|x-access-token|x-refresh-token|x-session-token|x-csrf-token|x-xsrf-token|x-amz-security-token)$/i;

/** Truncate a captured body, marking what was dropped (never silently shortened). */
export function truncateBody(body: string, cap = BODY_CAP): string {
  if (body.length <= cap) return body;
  return `${body.slice(0, cap)}…[truncated, ${body.length} chars total]`;
}

/**
 * Copy headers with credential values replaced by `<redacted, N chars>`.
 *
 * Presence is diagnostic (an absent `cookie` explains a 401 as well as a wrong
 * one), the value is a secret that must not reach the model's context, the log
 * files, or the findings the caller reads back.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER.test(name) ? `<redacted, ${value.length} chars>` : value;
  }
  return out;
}

/**
 * Query-parameter names whose VALUE is a credential. An OAuth callback
 * (`?code=4/0Ae…`), a presigned S3 link (`?X-Amz-Signature=…`) or a `?apikey=`
 * carries a live secret in the URL itself — and the URL is the one field that
 * reaches the model on EVERY network read, plus `logs/network.log` verbatim.
 */
const SENSITIVE_PARAM =
  /^(code|token|access_token|refresh_token|id_token|api_key|apikey|signature|password|secret|x-amz-signature|x-amz-credential|x-amz-security-token)$/i;

/**
 * Copy a URL with credential-bearing query values replaced by `<redacted, N chars>`.
 *
 * Rewrites the query string textually rather than through `new URL`: capture runs
 * inside an event handler where a parse failure must not swallow the URL (nor let
 * it through unredacted), and re-serializing would also re-encode params the
 * driver needs to recognize.
 */
export function redactUrl(url: string): string {
  const start = url.indexOf('?');
  if (start === -1) return url;
  const hash = url.indexOf('#', start);
  const end = hash === -1 ? url.length : hash;
  const query = url
    .slice(start + 1, end)
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const name = pair.slice(0, eq);
      if (!SENSITIVE_PARAM.test(name)) return pair;
      return `${name}=<redacted, ${pair.length - eq - 1} chars>`;
    })
    .join('&');
  return `${url.slice(0, start + 1)}${query}${url.slice(end)}`;
}

/**
 * A body key whose VALUE is a credential, matched on the key with case and
 * `_`/`-` folded away, and on EVERY segment of a bracket path — so `password`,
 * `new_password`, `accessToken`, `client-secret`, `x_api_key`, `user[password]`
 * and the array field `password[]` all match. A suffix rule, not a list: a login body names its
 * secret a dozen ways, and over-masking a pagination `nextPageToken` is the
 * cheap side of that trade.
 */
const SENSITIVE_KEY = /(password|passwd|pwd|secret|token|apikey|authorization|otp|passcode)$/;

function isSensitiveKey(key: string): boolean {
  return (key.match(/[^[\]]+/g) ?? []).some((segment) =>
    SENSITIVE_KEY.test(segment.toLowerCase().replace(/[-_]/g, '')),
  );
}

const marker = (length: number): string => `<redacted, ${length} chars>`;

/**
 * Mask credential-keyed values anywhere in a parsed JSON value; `true` if ANY
 * credential key was seen — masked or not (a `null` one). The caller must then
 * re-serialize: `JSON.parse` keeps only the LAST of duplicate keys, so the raw
 * text of `{"password":"hunter2","password":null}` still holds the secret the
 * parsed value no longer shows.
 */
function maskJson(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  let seen = false;
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      seen = true;
      if (child === null || typeof child === 'boolean') continue;
      const text = typeof child === 'object' ? JSON.stringify(child) : String(child);
      (value as Record<string, unknown>)[key] = marker(text.length);
    } else if (maskJson(child)) {
      seen = true;
    }
  }
  return seen;
}

/** A declared `application/x-www-form-urlencoded` content type (any params). */
const FORM_TYPE = /^\s*application\/x-www-form-urlencoded\b/i;

/** A declared JSON content type — `application/json` or any `+json` suffix. */
const JSON_TYPE = /^\s*application\/([\w.-]+\+)?json\b/i;

const NOT_JSON = Symbol('not-json');

/** `text` parsed as JSON, or {@link NOT_JSON} when it does not parse. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/**
 * Whether to treat `text` as form-urlencoded. A DECLARED form always is. Else the
 * test is deliberately loose — every valid form passes it (empty names `=x`,
 * empty pairs, bare keys, stray `=`); a grammar that rejected any of those let
 * the password beside it through. Only text that cannot be a form is out: no
 * `=` at all, or raw whitespace (a serialized form encodes it as `+`/`%20`).
 */
function isForm(text: string, contentType: string | undefined): boolean {
  if (contentType !== undefined && FORM_TYPE.test(contentType)) return true;
  return text.includes('=') && !/\s/.test(text);
}

/**
 * A form key as the server reads it (`user%5Bpassword%5D` → `user[password]`),
 * decoded by `URLSearchParams` — the WHATWG parser, lenient exactly where servers
 * are: a malformed `%zz` stays literal while the valid escapes around it
 * (`%zz%5Bpassword%5D` → `%zz[password]`) still decode, instead of the whole key failing to decode.
 */
function formKey(raw: string): string {
  return new URLSearchParams(`${raw}=`).keys().next().value ?? raw;
}

/**
 * Copy a captured request/response body with credential-keyed values replaced by
 * `<redacted, N chars>` — JSON (at any depth) and `application/x-www-form-urlencoded`.
 * `contentType`, when the exchange's header is known, makes a declared form
 * parse as one even if it breaks the shape heuristic (raw spaces).
 *
 * A login POST and the token response it gets back carry the secret in the BODY,
 * which reaches the driver on every network read and `network.log` on failure;
 * the header and URL redactors above never see it. Anything else (plain text, HTML,
 * a body with nothing sensitive in it) comes back byte-for-byte untouched.
 */
export function redactBody(body: string, contentType?: string): string {
  const trimmed = body.trim();
  // Routing: a DECLARED form is always a form (`[x]=1&password=…` starts like
  // JSON). Anything else is JSON only if it actually PARSES — a failed parse
  // falls through to the form check, never to "return untouched".
  const declaredForm = contentType !== undefined && FORM_TYPE.test(contentType);
  const declaredJson = contentType !== undefined && JSON_TYPE.test(contentType);
  if (!declaredForm && (declaredJson || trimmed.startsWith('{') || trimmed.startsWith('['))) {
    const parsed = parseJson(trimmed);
    if (parsed !== NOT_JSON) return maskJson(parsed) ? JSON.stringify(parsed) : body;
  }
  if (!isForm(trimmed, contentType)) return body;
  let masked = false;
  const out = trimmed
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1 || !isSensitiveKey(formKey(pair.slice(0, eq)))) return pair;
      masked = true;
      return `${pair.slice(0, eq)}=${marker(pair.length - eq - 1)}`;
    })
    .join('&');
  return masked ? out : body;
}

// --- Normalizers ------------------------------------------------------------

/** Map a CDP console `type()` onto the normalized {@link ConsoleEntry} level. */
export function normalizeConsoleLevel(type: string): ConsoleEntry['level'] {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warn';
    case 'info':
    case 'count':
    case 'timeEnd':
      return 'info';
    case 'debug':
      return 'debug';
    default:
      return 'log';
  }
}

// --- Line formatting (durable log trail) ------------------------------------

/** One log line's worth of a captured body — single-line, hard-capped, never secret-bearing. */
function bodySnippet(label: string, body: string | undefined): string {
  if (body === undefined || body.length === 0) return '';
  // `JSON.stringify` escapes CR/LF but leaves U+2028/U+2029 raw — fold those too.
  return ` ${label}=${oneLine(JSON.stringify(truncateBody(body, 500)))}`;
}

/**
 * Render a {@link NetworkEntry} as one greppable `logs/network.log` line.
 *
 * Failures carry their payloads inline: the durable log is what a human (or a
 * later agent) reads after the run, and `POST /login → 400` without the body is
 * the exact dead end this log exists to prevent.
 */
export function formatNetworkLine(entry: NetworkEntry): string {
  // Every page-controlled field is folded to one line (`oneLine`): a URL, method or
  // error carrying a line break would otherwise plant a forged row in the trail.
  const head = `${stamp(entry.timestamp)}${tabMarker(entry.tab)} ${oneLine(entry.method)} ${oneLine(entry.url)}`;
  const sent = bodySnippet('req', entry.requestBody);
  if (entry.error !== undefined) return `${head} → FAILED ${oneLine(entry.error)}${sent}`;
  const type = entry.resourceType ? ` [${oneLine(entry.resourceType)}]` : '';
  const took = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
  const got = entry.ok ? '' : bodySnippet('res', entry.responseBody);
  return `${head} → ${entry.status}${type}${took}${sent}${got}`;
}
