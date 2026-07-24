/**
 * CDP console + network capture — the browser adapter's passive observers.
 *
 * Subscribes to Playwright/CDP events the moment the adapter opens and keeps a
 * bounded, in-memory ring of normalized entries:
 *   - `page.on('console')`   → {@link ConsoleEntry} (severity normalized)
 *   - `page.on('pageerror')` → {@link ConsoleEntry} at `level: 'error'` (uncaught
 *      exceptions never surface as console messages, but the contract says
 *      console capture covers them — so we fold them in)
 *   - `page.on('requestfailed')` → {@link NetworkEntry} (`status: 0`, `ok: false`)
 *   - `page.on('response')`      → {@link NetworkEntry} (covers 4xx/5xx too)
 *
 * Every listener is scoped to the SELECTED page, not the context — an attach or
 * persistent session can hold unrelated tabs, and their traffic must not leak
 * into this run's `network()`.
 *
 * Each captured entry is ALSO streamed line-by-line to an optional {@link CaptureSink}
 * (the session layer wires it to `findings-store`'s `logs/console.log` /
 * `logs/network.log`), so the persistent trail and the live buffer stay in sync.
 *
 * Reads are non-destructive and SQL-like: `console`/`network` return newest-first,
 * narrowed by the whitelisted {@link LogQuery.filters} and capped by `limit`. The
 * buffer is the source of truth for the agent's `observe`; the on-disk log is the
 * durable record. Filters fail loud — an unknown key or wrong value type throws
 * {@link AdapterError}, never a silent ignore.
 */

import type { ConsoleMessage, Page, Request, Response } from 'playwright-core';
import { AdapterError } from '../../errors.js';
import type { ConsoleEntry, Filters, FilterValue, LogQuery, NetworkEntry } from '../contract.js';
import { capToLimit } from '../limit.js';

/** Default ring size per channel — keeps memory bounded on chatty pages. */
const DEFAULT_BUFFER_CAP = 1000;

/**
 * Resource types whose bodies + headers are worth capturing: the app's own API
 * traffic. Everything else on a page is scripts, styles, images and fonts —
 * megabytes of bytes no UI debugger ever reads, and on a dev server (Vite/HMR)
 * they outnumber real API calls ~15:1.
 */
export const BODY_RESOURCE_TYPES = new Set(['fetch', 'xhr']);

/**
 * Per-body character cap. Big enough for an error payload or a small collection,
 * small enough that the driver re-reading tool results every step cannot drown.
 */
export const BODY_CAP = 4096;

/**
 * `{ key: value }` when the value exists, `{}` when it does not — spread into an
 * entry so an absent optional never serializes as an explicit `undefined` (and
 * `exactOptionalPropertyTypes` stays satisfied).
 */
function optional<K extends string, V>(key: K, value: V | undefined): Record<K, V> | object {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * The response payload, capped — or `undefined` when the body cannot be read.
 *
 * Playwright throws for bodies that no longer exist (redirects, a response whose
 * page navigated away, a cancelled request). That is an ordinary outcome of
 * watching a live page, not a capture failure: the exchange is still recorded,
 * just without its body.
 */
async function readBody(response: Response): Promise<string | undefined> {
  try {
    return truncateBody(await response.text());
  } catch {
    return undefined;
  }
}

/** Redacted headers off a request or response; `undefined` if they cannot be read. */
async function readHeaders(
  source: Pick<Response, 'allHeaders'> | Pick<Request, 'allHeaders'>,
): Promise<Record<string, string> | undefined> {
  try {
    return redactHeaders(await source.allHeaders());
  } catch {
    return undefined;
  }
}

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

/** Whitelisted `filters` keys for the console channel — anything else is rejected. */
export const CONSOLE_FILTER_KEYS = ['level_eq', 'level_in', 'text_contains'] as const;

/** Whitelisted `filters` keys for the network channel — anything else is rejected. */
export const NETWORK_FILTER_KEYS = [
  'status_eq',
  'status_gte',
  'status_lt',
  'ok_eq',
  'failed_eq',
  'method_eq',
  'resource_in',
  'url_contains',
  'duration_gte',
  'body_contains',
] as const;

/**
 * Where captured entries are streamed as formatted log lines. The session layer
 * binds this to `findings-store`'s append-only `console`/`network` channels; the
 * adapter stays decoupled from the session (depends on this seam, not the store).
 */
export type CaptureSink = (channel: 'console' | 'network', line: string) => void;

export interface CdpCaptureInit {
  /** Page that emits `console`/`pageerror`/`requestfailed`/`response`. */
  page: Page;
  /** Optional log sink — each new entry is streamed here as a line. */
  sink?: CaptureSink;
  /** Injected clock (epoch ms) for deterministic capture timestamps; default `Date.now`. */
  now?: () => number;
  /** Per-channel ring size; default {@link DEFAULT_BUFFER_CAP}. */
  cap?: number;
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

// --- Filter value type-guards (fail loud, never coerce) ---------------------

function expectBoolean(key: string, value: FilterValue): boolean {
  if (typeof value !== 'boolean') throw new AdapterError(`filter \`${key}\` expects a boolean`);
  return value;
}

function expectNumber(key: string, value: FilterValue): number {
  if (typeof value !== 'number') throw new AdapterError(`filter \`${key}\` expects a number`);
  return value;
}

function expectString(key: string, value: FilterValue): string {
  if (typeof value !== 'string') throw new AdapterError(`filter \`${key}\` expects a string`);
  return value;
}

function expectStringArray(key: string, value: FilterValue): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new AdapterError(`filter \`${key}\` expects a string[]`);
  }
  return value;
}

// --- Filtering (whitelisted, per-channel) -----------------------------------

/**
 * Narrow console entries by the whitelisted `filters` keys
 * ({@link CONSOLE_FILTER_KEYS}). Throws {@link AdapterError} on an unknown key
 * (no silent injection surface) or a wrong value type.
 */
export function filterConsole(entries: ConsoleEntry[], filters?: Filters): ConsoleEntry[] {
  if (!filters) return entries;
  let out = entries;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'level_eq': {
        const want = expectString(key, value);
        out = out.filter((e) => e.level === want);
        break;
      }
      case 'level_in': {
        const want = expectStringArray(key, value);
        out = out.filter((e) => want.includes(e.level));
        break;
      }
      case 'text_contains': {
        const needle = expectString(key, value).toLowerCase();
        out = out.filter((e) => e.text.toLowerCase().includes(needle));
        break;
      }
      default:
        throw new AdapterError(
          `unknown console filter \`${key}\` (allowed: ${CONSOLE_FILTER_KEYS.join(', ')})`,
        );
    }
  }
  return out;
}

/**
 * Narrow network entries by the whitelisted `filters` keys
 * ({@link NETWORK_FILTER_KEYS}). Throws {@link AdapterError} on an unknown key or
 * a wrong value type.
 */
export function filterNetwork(entries: NetworkEntry[], filters?: Filters): NetworkEntry[] {
  if (!filters) return entries;
  let out = entries;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'status_eq': {
        const want = expectNumber(key, value);
        out = out.filter((e) => e.status === want);
        break;
      }
      case 'status_gte': {
        const want = expectNumber(key, value);
        out = out.filter((e) => e.status >= want);
        break;
      }
      case 'status_lt': {
        const want = expectNumber(key, value);
        out = out.filter((e) => e.status < want);
        break;
      }
      case 'ok_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((e) => e.ok === want);
        break;
      }
      case 'failed_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((e) => (e.error !== undefined) === want);
        break;
      }
      case 'method_eq': {
        const want = expectString(key, value).toUpperCase();
        out = out.filter((e) => e.method.toUpperCase() === want);
        break;
      }
      case 'resource_in': {
        const want = expectStringArray(key, value);
        out = out.filter((e) => e.resourceType !== undefined && want.includes(e.resourceType));
        break;
      }
      case 'url_contains': {
        const needle = expectString(key, value).toLowerCase();
        out = out.filter((e) => e.url.toLowerCase().includes(needle));
        break;
      }
      case 'duration_gte': {
        const want = expectNumber(key, value);
        // A request with no timing (never answered, or in flight before capture)
        // is not "slower than N" — excluded rather than counted as 0.
        out = out.filter((e) => e.durationMs !== undefined && e.durationMs >= want);
        break;
      }
      case 'body_contains': {
        const needle = expectString(key, value).toLowerCase();
        out = out.filter((e) =>
          `${e.requestBody ?? ''}\n${e.responseBody ?? ''}`.toLowerCase().includes(needle),
        );
        break;
      }
      default:
        throw new AdapterError(
          `unknown network filter \`${key}\` (allowed: ${NETWORK_FILTER_KEYS.join(', ')})`,
        );
    }
  }
  return out;
}

/**
 * Reverse to newest-first and apply `limit` — the shared `console`/`network` read
 * tail. The cap goes through {@link capToLimit}, so a bad limit fails loud here
 * exactly as it does on the node reads.
 */
function newestFirst<T>(filtered: T[], limit?: number): T[] {
  return capToLimit([...filtered].reverse(), limit);
}

/**
 * Newest-first by capture time, then capped.
 *
 * Network entries are buffered only after their body has been awaited, so a slow
 * response can land in the ring *after* a fast one that started later — insertion
 * order is no longer capture order. Sorting on the recorded timestamp restores
 * "newest first" as a promise about the traffic rather than about our await
 * scheduling. The sort is stable, so same-timestamp entries keep the reversed
 * insertion order {@link newestFirst} alone would give them.
 */
function newestFirstByTime(filtered: NetworkEntry[], limit?: number): NetworkEntry[] {
  return capToLimit(
    [...filtered].reverse().sort((a, b) => b.timestamp - a.timestamp),
    limit,
  );
}

/**
 * Captures and buffers console + network activity for one browser adapter.
 * Construct with the open page/context, then {@link CdpCapture.start}; release the
 * listeners with {@link CdpCapture.stop} before the page closes.
 */
export class CdpCapture {
  /** The page events are read from — reassigned by {@link CdpCapture.rebind} on a tab switch. */
  #page: Page;
  readonly #sink: CaptureSink | undefined;
  readonly #now: () => number;
  readonly #cap: number;

  readonly #console: ConsoleEntry[] = [];
  readonly #network: NetworkEntry[] = [];
  /** Request → epoch ms it left the page, for {@link NetworkEntry.durationMs}. */
  readonly #requestStarted = new WeakMap<Request, number>();
  /**
   * Requests that already produced a response, so a later `requestfailed` for the
   * same one is recognized as teardown rather than logged as a second exchange.
   */
  readonly #responded = new WeakSet<Request>();
  /** Detacher thunks captured at `start`, replayed at `stop`. */
  readonly #detachers: Array<() => void> = [];
  #started = false;

  constructor(init: CdpCaptureInit) {
    this.#page = init.page;
    this.#sink = init.sink;
    this.#now = init.now ?? (() => Date.now());
    this.#cap = init.cap ?? DEFAULT_BUFFER_CAP;
  }

  /** Subscribe to the console/error/network events. Idempotent (a re-`start` is a no-op). */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    this.#page.on('console', this.#onConsole);
    this.#page.on('pageerror', this.#onPageError);
    this.#page.on('request', this.#onRequest);
    this.#page.on('requestfailed', this.#onRequestFailed);
    this.#page.on('response', this.#onResponse);
    this.#detachers.push(
      () => this.#page.off('console', this.#onConsole),
      () => this.#page.off('pageerror', this.#onPageError),
      () => this.#page.off('request', this.#onRequest),
      () => this.#page.off('requestfailed', this.#onRequestFailed),
      () => this.#page.off('response', this.#onResponse),
    );
  }

  /** Detach every listener. Idempotent; safe to call after the page is gone. */
  stop(): void {
    for (const detach of this.#detachers.splice(0)) detach();
    this.#started = false;
  }

  /**
   * Move capture onto another page (a tab switch), keeping everything already
   * buffered.
   *
   * Listeners are page-scoped, so without this a switched-to tab would record
   * nothing — and re-creating the capture instead would throw away the console
   * errors and API calls from the tab the agent just came from, which are
   * usually the whole reason it followed the flow into a new tab.
   */
  rebind(page: Page): void {
    const wasStarted = this.#started;
    this.stop();
    this.#page = page;
    if (wasStarted) this.start();
  }

  /** Captured console messages, newest first, narrowed by {@link LogQuery}. */
  console(opts: LogQuery = {}): ConsoleEntry[] {
    return newestFirst(filterConsole(this.#console, opts.filters), opts.limit);
  }

  /** Captured network exchanges, newest first, narrowed by {@link LogQuery}. */
  network(opts: LogQuery = {}): NetworkEntry[] {
    return newestFirstByTime(filterNetwork(this.#network, opts.filters), opts.limit);
  }

  // --- Event handlers (arrow fields: bound `this`, stable refs for `off`) ----

  readonly #onConsole = (msg: ConsoleMessage): void => {
    const loc = msg.location();
    this.#pushConsole({
      level: normalizeConsoleLevel(msg.type()),
      text: msg.text(),
      location: loc.url ? `${loc.url}:${loc.line}:${loc.column}` : undefined,
      timestamp: this.#now(),
    });
  };

  readonly #onPageError = (error: Error): void => {
    this.#pushConsole({
      level: 'error',
      text: error.message,
      location: error.stack?.split('\n')[1]?.trim(),
      timestamp: this.#now(),
    });
  };

  /**
   * Stamp when a request left the page, so the response handler can report a
   * duration. Keyed by the Playwright `Request` object in a {@link WeakMap}: it is
   * the identity the response hands back, and entries evaporate with the request
   * rather than growing a map for the life of the run.
   */
  readonly #onRequest = (request: Request): void => {
    this.#requestStarted.set(request, this.#now());
  };

  /** Elapsed ms since this request started, or `undefined` if we never saw its start. */
  #elapsed(request: Request, at: number): number | undefined {
    const started = this.#requestStarted.get(request);
    return started === undefined ? undefined : at - started;
  }

  /** The payload a request carried, capped — API traffic only (see {@link BODY_RESOURCE_TYPES}). */
  #requestBodyOf(request: Request): string | undefined {
    if (!BODY_RESOURCE_TYPES.has(request.resourceType())) return undefined;
    // `postData()` throws on some intercepted/streamed requests; a missing body is
    // never worth failing a capture over.
    let data: string | null;
    try {
      data = request.postData();
    } catch {
      return undefined;
    }
    return data ? truncateBody(data) : undefined;
  }

  readonly #onRequestFailed = (request: Request): void => {
    // A request that ALREADY answered and is now aborted is not a failed request:
    // Chrome fires `requestfailed` with `net::ERR_ABORTED` when the connection is
    // torn down after the response (a logout that navigates, a fetch whose page
    // unloads). Logging both produced two rows for one exchange — a clean `204`
    // and a phantom `FAILED` at the same millisecond — and readers reasonably took
    // the phantom for a real outage. The response is the truth; drop the echo.
    if (this.#responded.has(request)) return;
    const at = this.#now();
    this.#pushNetwork({
      method: request.method(),
      url: request.url(),
      status: 0,
      ok: false,
      resourceType: request.resourceType(),
      error: request.failure()?.errorText ?? 'request failed',
      timestamp: at,
      ...optional('durationMs', this.#elapsed(request, at)),
      ...optional('requestBody', this.#requestBodyOf(request)),
    });
  };

  /**
   * Buffer a finished exchange, enriched for API traffic.
   *
   * Async on purpose: the response body only exists behind an await, and a `400`
   * without its body is the dead end this capture exists to prevent. The
   * timestamp is taken UP FRONT (before the await) so ordering reflects when the
   * response actually arrived — `network()` sorts on it, since bodies resolve out
   * of order. Playwright tolerates an async listener; a rejection here must not
   * become an unhandled rejection that kills the run, so everything is guarded.
   */
  readonly #onResponse = (response: Response): void => {
    const at = this.#now();
    const request = response.request();
    // Marked SYNCHRONOUSLY, before the body await: an abort that lands while the
    // body is still resolving must already see this request as answered.
    this.#responded.add(request);
    void this.#captureResponse(response, request, at).catch(() => undefined);
  };

  async #captureResponse(response: Response, request: Request, at: number): Promise<void> {
    const isApi = BODY_RESOURCE_TYPES.has(request.resourceType());
    this.#pushNetwork({
      method: request.method(),
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      resourceType: request.resourceType(),
      timestamp: at,
      ...optional('durationMs', this.#elapsed(request, at)),
      ...optional('requestBody', this.#requestBodyOf(request)),
      ...optional('responseBody', isApi ? await readBody(response) : undefined),
      ...optional('requestHeaders', isApi ? await readHeaders(request) : undefined),
      ...optional('responseHeaders', isApi ? await readHeaders(response) : undefined),
    });
  }

  /** Ring-buffer a console entry and stream its formatted line to the sink. */
  #pushConsole(entry: ConsoleEntry): void {
    this.#console.push(entry);
    if (this.#console.length > this.#cap) this.#console.shift();
    try {
      this.#sink?.('console', formatConsoleLine(entry));
    } catch (error) {
      // Sink failure must not crash the handler — log but continue.
      console.error(
        `CDP capture sink failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** Ring-buffer a network entry and stream its formatted line to the sink. */
  #pushNetwork(entry: NetworkEntry): void {
    this.#network.push(entry);
    if (this.#network.length > this.#cap) this.#network.shift();
    try {
      this.#sink?.('network', formatNetworkLine(entry));
    } catch (error) {
      // Sink failure must not crash the handler — log but continue.
      console.error(
        `CDP capture sink failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
