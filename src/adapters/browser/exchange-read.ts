/**
 * Reading one exchange's payloads off Playwright — capped in SIZE and in TIME.
 *
 * Split out of `cdp.ts` (500-LOC cap). Every reader here is total: a body or
 * header that cannot be read is an ordinary outcome of watching a live page
 * (redirects, a page that navigated away), never a capture failure, so each
 * yields `undefined` or a stand-in marker instead of throwing.
 */

import type { Request, Response } from 'playwright-core';
import { redactBody, redactHeaders, truncateBody } from './log-format.js';

/**
 * How long a response body/header read may take before the exchange is recorded
 * without it. A streaming response (SSE, long-poll, a chunked download) only
 * "finishes" when the page tears it down, so an uncapped read would keep the
 * durable log line hostage for the whole run.
 */
export const BODY_WAIT_MS = 2_000;

/** Stand-in body for a response that was still streaming when the cap expired. */
export const BODY_UNFINISHED = '<body not finished>';

/**
 * Content types whose bytes are not text: decoded as UTF-8 they are replacement-
 * character garbage — up to {@link BODY_CAP} chars of it in the driver's context
 * on every read. `application/vnd.*` is deliberately absent (`vnd.api+json`).
 */
const BINARY_TYPE =
  /^\s*(image|audio|video|font)\/|^\s*application\/(octet-stream|pdf|zip|x-zip-compressed|gzip|x-gzip|wasm|grpc|protobuf|x-protobuf)\b/i;

/**
 * A declared body size past which the payload is never read. `text()` buffers the
 * WHOLE body before {@link truncateBody} keeps its first 4 KB, so a `fetch` of a
 * 200 MB export would pin 200 MB per request for nothing.
 */
export const BODY_READ_MAX_BYTES = 1_048_576;

/**
 * Why this response's body is not worth reading, as the stand-in body — or
 * `undefined` when it should be read. Decided off the response HEADERS alone
 * (synchronous, no body touched).
 */
function unreadBody(response: Response): string | undefined {
  const headers = response.headers();
  const type = headers['content-type'] ?? '';
  if (BINARY_TYPE.test(type)) return `<binary body, ${type.trim()}>`;
  const length = Number(headers['content-length']);
  if (Number.isFinite(length) && length > BODY_READ_MAX_BYTES) {
    return `<body not read, ${length} bytes>`;
  }
  return undefined;
}

/**
 * The response payload, capped — or `undefined` when the body cannot be read.
 *
 * Playwright throws for bodies that no longer exist (redirects, a response whose
 * page navigated away, a cancelled request). That is an ordinary outcome of
 * watching a live page, not a capture failure: the exchange is still recorded,
 * just without its body. A binary or oversized body is never read at all — it is
 * recorded as a marker saying why ({@link unreadBody}).
 */
async function readBody(response: Response): Promise<string | undefined> {
  try {
    // Redact BEFORE truncating: a cut JSON body no longer parses, so its secret would survive.
    return unreadBody(response) ?? truncateBody(redactBody(await response.text()));
  } catch {
    return undefined;
  }
}

/**
 * `promise`'s value, or `undefined` when it takes longer than `ms`.
 *
 * Never leaves a timer behind: the loser is cleared as soon as the race settles,
 * so a capped read cannot hold the process open past the run.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const capped = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([promise, capped]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The response payload, capped in SIZE and in TIME — {@link BODY_UNFINISHED} when
 * the stream had not finished within `waitMs`. The `{ body }` wrapper keeps the
 * two `undefined`s apart: "no body to read" (a redirect) vs "still streaming".
 */
export async function readBodyWithin(
  response: Response,
  waitMs: number,
): Promise<string | undefined> {
  const settled = await withTimeout(
    readBody(response).then((body) => ({ body })),
    waitMs,
  );
  return settled === undefined ? BODY_UNFINISHED : settled.body;
}

/** Redacted headers off a request or response; `undefined` if they cannot be read. */
export async function readHeaders(
  source: Pick<Response, 'allHeaders'> | Pick<Request, 'allHeaders'>,
): Promise<Record<string, string> | undefined> {
  try {
    return redactHeaders(await source.allHeaders());
  } catch {
    return undefined;
  }
}
