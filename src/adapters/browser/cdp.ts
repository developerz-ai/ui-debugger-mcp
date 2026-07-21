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

/** Render a {@link NetworkEntry} as one greppable `logs/network.log` line. */
export function formatNetworkLine(entry: NetworkEntry): string {
  const head = `${stamp(entry.timestamp)} ${entry.method} ${entry.url}`;
  if (entry.error !== undefined) return `${head} → FAILED ${entry.error}`;
  const type = entry.resourceType ? ` [${entry.resourceType}]` : '';
  return `${head} → ${entry.status}${type}`;
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
 * Captures and buffers console + network activity for one browser adapter.
 * Construct with the open page/context, then {@link CdpCapture.start}; release the
 * listeners with {@link CdpCapture.stop} before the page closes.
 */
export class CdpCapture {
  readonly #page: Page;
  readonly #sink: CaptureSink | undefined;
  readonly #now: () => number;
  readonly #cap: number;

  readonly #console: ConsoleEntry[] = [];
  readonly #network: NetworkEntry[] = [];
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
    this.#page.on('requestfailed', this.#onRequestFailed);
    this.#page.on('response', this.#onResponse);
    this.#detachers.push(
      () => this.#page.off('console', this.#onConsole),
      () => this.#page.off('pageerror', this.#onPageError),
      () => this.#page.off('requestfailed', this.#onRequestFailed),
      () => this.#page.off('response', this.#onResponse),
    );
  }

  /** Detach every listener. Idempotent; safe to call after the page is gone. */
  stop(): void {
    for (const detach of this.#detachers.splice(0)) detach();
    this.#started = false;
  }

  /** Captured console messages, newest first, narrowed by {@link LogQuery}. */
  console(opts: LogQuery = {}): ConsoleEntry[] {
    return newestFirst(filterConsole(this.#console, opts.filters), opts.limit);
  }

  /** Captured network exchanges, newest first, narrowed by {@link LogQuery}. */
  network(opts: LogQuery = {}): NetworkEntry[] {
    return newestFirst(filterNetwork(this.#network, opts.filters), opts.limit);
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

  readonly #onRequestFailed = (request: Request): void => {
    this.#pushNetwork({
      method: request.method(),
      url: request.url(),
      status: 0,
      ok: false,
      resourceType: request.resourceType(),
      error: request.failure()?.errorText ?? 'request failed',
      timestamp: this.#now(),
    });
  };

  readonly #onResponse = (response: Response): void => {
    const request = response.request();
    this.#pushNetwork({
      method: request.method(),
      url: response.url(),
      status: response.status(),
      ok: response.ok(),
      resourceType: request.resourceType(),
      timestamp: this.#now(),
    });
  };

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
