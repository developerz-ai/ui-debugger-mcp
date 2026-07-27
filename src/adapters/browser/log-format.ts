/**
 * Rendering + redaction for captured console/network entries.
 *
 * Split out of `cdp.ts` to keep that file under the 500-LOC cap — no behavior
 * change. Everything here is pure: level normalization, body truncation, the two
 * `logs/*.log` line renderers, and the two redactors that keep a credential out
 * of the model's context and out of the durable trail (a secret in a header
 * VALUE, or in a query param of the URL itself).
 */

import type { ConsoleEntry, NetworkEntry } from '../contract.js';

/**
 * Per-body character cap. Big enough for an error payload or a small collection,
 * small enough that the driver re-reading tool results every step cannot drown.
 */
export const BODY_CAP = 4096;

/** Header names whose VALUE is a credential — kept as a length marker, never verbatim. */
const SENSITIVE_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token)$/i;

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
 * Values a CONFIGURED auth persona types into the app (`targets.<t>.auth.<p>.fields`).
 *
 * The two redactors above key off a NAME they recognize (`authorization`,
 * `?password=`). A persona's values have no such tell: they land in a form POST
 * body, in a `type` tool input on the agent trail, in whatever an adapter error
 * echoes back. So this one keys off the VALUE — the only thing all three share —
 * and is bound per run to the persona the caller named.
 *
 * Same posture as the other two: presence stays diagnostic (`<redacted, N chars>`
 * still tells you a password of the right length was typed), the secret itself
 * never reaches the durable trail. Form-encoded and JSON-escaped spellings are
 * redacted too — a password with an `@` rides a form POST as `%40`, and matching
 * only the plain text would leave the real body in `logs/network.log`.
 *
 * Longest first, so a value that contains another still redacts whole.
 */
export function createSecretRedactor(secrets: readonly string[]): (line: string) => string {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    spellings.add(secret);
    const encoded = encodeURIComponent(secret);
    spellings.add(encoded);
    spellings.add(encoded.replaceAll('%20', '+')); // form encoding spells a space `+`
    spellings.add(JSON.stringify(secret).slice(1, -1)); // JSON body escaping
  }
  const values = [...spellings].sort((a, b) => b.length - a.length);
  if (values.length === 0) return (line) => line;
  return (line) => {
    let out = line;
    for (const value of values) {
      // `split`/`join`, not a regex: a credential is arbitrary text and escaping it
      // for a pattern is one missed metacharacter away from not redacting at all.
      if (out.includes(value)) out = out.split(value).join(`<redacted, ${value.length} chars>`);
    }
    return out;
  };
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

/** ISO-8601 stamp from epoch ms; deterministic given the injected clock. */
function stamp(ts: number): string {
  return new Date(ts).toISOString();
}

/** Render a {@link ConsoleEntry} as one greppable `logs/console.log` line. */
export function formatConsoleLine(entry: ConsoleEntry): string {
  const where = entry.location ? ` @ ${entry.location}` : '';
  return `${stamp(entry.timestamp)} ${entry.level.toUpperCase()} ${entry.text}${where}`;
}

/** One log line's worth of a captured body — single-line, hard-capped, never secret-bearing. */
function bodySnippet(label: string, body: string | undefined): string {
  if (body === undefined || body.length === 0) return '';
  return ` ${label}=${JSON.stringify(truncateBody(body, 500))}`;
}

/**
 * Render a {@link NetworkEntry} as one greppable `logs/network.log` line.
 *
 * Failures carry their payloads inline: the durable log is what a human (or a
 * later agent) reads after the run, and `POST /login → 400` without the body is
 * the exact dead end this log exists to prevent.
 */
export function formatNetworkLine(entry: NetworkEntry): string {
  const head = `${stamp(entry.timestamp)} ${entry.method} ${entry.url}`;
  const sent = bodySnippet('req', entry.requestBody);
  if (entry.error !== undefined) return `${head} → FAILED ${entry.error}${sent}`;
  const type = entry.resourceType ? ` [${entry.resourceType}]` : '';
  const took = entry.durationMs !== undefined ? ` ${entry.durationMs}ms` : '';
  const got = entry.ok ? '' : bodySnippet('res', entry.responseBody);
  return `${head} → ${entry.status}${type}${took}${sent}${got}`;
}
