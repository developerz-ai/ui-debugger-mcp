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
import type { ConsoleEntry, LogQuery, NetworkEntry } from '../contract.js';
import { capToLimit } from '../limit.js';
import { filterConsole, filterNetwork } from './log-filters.js';
import {
  formatConsoleLine,
  formatNetworkLine,
  normalizeConsoleLevel,
  redactHeaders,
  redactUrl,
  truncateBody,
} from './log-format.js';

// Filtering lives in `log-filters.ts` and rendering/redaction in `log-format.ts`
// (500-LOC cap); both are re-exported here so `cdp.js` stays the single import
// surface for the capture channel.
export {
  CONSOLE_FILTER_KEYS,
  filterConsole,
  filterNetwork,
  NETWORK_FILTER_KEYS,
} from './log-filters.js';
export {
  BODY_CAP,
  formatConsoleLine,
  formatNetworkLine,
  normalizeConsoleLevel,
  redactHeaders,
  redactUrl,
  truncateBody,
} from './log-format.js';

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
 * How long a response body/header read may take before the exchange is recorded
 * without it. A streaming response (SSE, long-poll, a chunked download) only
 * "finishes" when the page tears it down, so an uncapped read would keep the
 * durable log line hostage for the whole run.
 */
export const BODY_WAIT_MS = 2_000;

/** Stand-in body for a response that was still streaming when the cap expired. */
export const BODY_UNFINISHED = '<body not finished>';

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

/**
 * `promise`'s value, or `undefined` when it takes longer than `ms`.
 *
 * Never leaves a timer behind: the loser is cleared as soon as the race settles,
 * so a capped read cannot hold the process open past the run.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
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
async function readBodyWithin(response: Response, waitMs: number): Promise<string | undefined> {
  const settled = await withTimeout(
    readBody(response).then((body) => ({ body })),
    waitMs,
  );
  return settled === undefined ? BODY_UNFINISHED : settled.body;
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
  /** How long a body/header read may take before it is given up on; default {@link BODY_WAIT_MS}. */
  bodyWaitMs?: number;
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
 * Sorting on the recorded timestamp (rather than trusting insertion order) makes
 * "newest first" a promise about the TRAFFIC, independent of how the handlers
 * happened to be scheduled. The sort is stable, so same-timestamp entries keep
 * the reversed insertion order {@link newestFirst} alone would give them.
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
  readonly #bodyWait: number;

  readonly #console: ConsoleEntry[] = [];
  readonly #network: NetworkEntry[] = [];
  /** Request → epoch ms it left the page, for {@link NetworkEntry.durationMs}. */
  readonly #requestStarted = new WeakMap<Request, number>();
  /**
   * Requests that already produced a response, so a later `requestfailed` for the
   * same one is recognized as teardown rather than logged as a second exchange.
   */
  readonly #responded = new WeakSet<Request>();
  /** Request → the buffered entry it produced, so a late failure can amend it in place. */
  readonly #entryOf = new WeakMap<Request, NetworkEntry>();
  /** Entries whose log line was already streamed — the line lands once, when enrichment settles. */
  readonly #logged = new WeakSet<NetworkEntry>();
  /** Detacher thunks captured at `start`, replayed at `stop`. */
  readonly #detachers: Array<() => void> = [];
  #started = false;

  constructor(init: CdpCaptureInit) {
    this.#page = init.page;
    this.#sink = init.sink;
    this.#now = init.now ?? (() => Date.now());
    this.#cap = init.cap ?? DEFAULT_BUFFER_CAP;
    this.#bodyWait = init.bodyWaitMs ?? BODY_WAIT_MS;
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
      // Playwright reports line/column 0-BASED; `url:line:col` is read (and opened
      // in an editor) 1-based, so the raw numbers point one line too high.
      location: loc.url ? `${loc.url}:${loc.line + 1}:${loc.column + 1}` : undefined,
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
    const at = this.#now();
    const error = request.failure()?.errorText ?? 'request failed';
    const answered = this.#entryOf.get(request);
    if (this.#responded.has(request)) {
      // An abort AFTER the response is teardown, not a failed request: Chrome fires
      // `requestfailed` with `net::ERR_ABORTED` when the connection is torn down
      // once the exchange is over (a logout that navigates, a fetch whose page
      // unloads, a stream we stopped reading). Logging that produced two rows for
      // one exchange — a clean `204` and a phantom `FAILED` — so drop the echo.
      if (error.includes('net::ERR_ABORTED')) return;
      // Anything else is a REAL failure that struck after the headers arrived (a
      // connection reset mid-body). Amend the exchange in place: reported as a
      // clean `200` it is indistinguishable from a body-less success.
      if (answered) {
        answered.error = error;
        answered.ok = false;
        if (this.#logged.has(answered)) this.#logNetwork(answered);
        return;
      }
    }
    const entry: NetworkEntry = {
      method: request.method(),
      url: redactUrl(request.url()),
      status: 0,
      ok: false,
      resourceType: request.resourceType(),
      error,
      timestamp: at,
      ...optional('durationMs', this.#elapsed(request, at)),
      ...optional('requestBody', this.#requestBodyOf(request)),
    };
    this.#bufferNetwork(entry);
    this.#logNetwork(entry);
  };

  /**
   * Record an exchange the moment its headers arrive, then enrich it in place.
   *
   * The row is buffered SYNCHRONOUSLY — a body only exists behind an await, and a
   * response that never finishes (SSE, long-poll, a stalled download) would
   * otherwise leave no trace at all: no row for the driver to see, no line in the
   * log. The bodies and headers land on the same object a moment later
   * ({@link #enrichResponse}), which is also when its log line is written, so the
   * durable trail still carries the payloads a `400` is explained by.
   */
  readonly #onResponse = (response: Response): void => {
    const at = this.#now();
    const request = response.request();
    // Marked SYNCHRONOUSLY, before the body await: an abort that lands while the
    // body is still resolving must already see this request as answered.
    this.#responded.add(request);
    const entry: NetworkEntry = {
      method: request.method(),
      url: redactUrl(response.url()),
      status: response.status(),
      ok: response.ok(),
      resourceType: request.resourceType(),
      timestamp: at,
      ...optional('durationMs', this.#elapsed(request, at)),
      ...optional('requestBody', this.#requestBodyOf(request)),
    };
    this.#entryOf.set(request, entry);
    this.#bufferNetwork(entry);
    // Playwright tolerates an async listener; a rejection here must not become an
    // unhandled rejection that kills the run, so everything is guarded.
    void this.#enrichResponse(entry, response, request).catch(() => undefined);
  };

  /** Attach bodies + headers to an already-buffered entry, then stream its log line. */
  async #enrichResponse(entry: NetworkEntry, response: Response, request: Request): Promise<void> {
    if (BODY_RESOURCE_TYPES.has(request.resourceType())) {
      const [body, requestHeaders, responseHeaders] = await Promise.all([
        readBodyWithin(response, this.#bodyWait),
        withTimeout(readHeaders(request), this.#bodyWait),
        withTimeout(readHeaders(response), this.#bodyWait),
      ]);
      if (body !== undefined) entry.responseBody = body;
      if (requestHeaders !== undefined) entry.requestHeaders = requestHeaders;
      if (responseHeaders !== undefined) entry.responseHeaders = responseHeaders;
    }
    this.#logNetwork(entry);
  }

  /** Ring-buffer a console entry and stream its formatted line to the sink. */
  #pushConsole(entry: ConsoleEntry): void {
    this.#console.push(entry);
    if (this.#console.length > this.#cap) this.#console.shift();
    this.#emit('console', formatConsoleLine(entry));
  }

  /** Ring-buffer a network entry. Its log line is written separately, once it is complete. */
  #bufferNetwork(entry: NetworkEntry): void {
    this.#network.push(entry);
    if (this.#network.length > this.#cap) this.#network.shift();
  }

  /** Stream a network entry's formatted line to the sink. */
  #logNetwork(entry: NetworkEntry): void {
    this.#logged.add(entry);
    this.#emit('network', formatNetworkLine(entry));
  }

  /** Hand one formatted line to the sink; a sink failure never crashes the handler. */
  #emit(channel: 'console' | 'network', line: string): void {
    try {
      this.#sink?.(channel, line);
    } catch (error) {
      // Sink failure must not crash the handler — log but continue.
      console.error(
        `CDP capture sink failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
