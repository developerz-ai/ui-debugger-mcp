/**
 * Whitelisted `filters` for the console + network log channels. Split out of
 * `cdp.ts` to keep that file under the 500-LOC cap — no behavior change (same
 * split `filters.ts` got out of `browser-adapter.ts`).
 *
 * Filters fail loud: an unknown key or a wrong value type throws
 * {@link AdapterError}, never a silent ignore.
 */

import { AdapterError } from '../../errors.js';
import type { ConsoleEntry, Filters, FilterValue, NetworkEntry } from '../contract.js';

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
