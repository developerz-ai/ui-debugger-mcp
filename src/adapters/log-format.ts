/**
 * Shared console-line rendering for every adapter that streams to the run's
 * durable capture trail.
 *
 * Lives at the `src/adapters/` root (next to `budget.ts`, `limit.ts`) because
 * TWO adapters render it: the browser's CDP capture and the android logcat
 * drain. A helper shared by siblings belongs in a shared place — reaching into
 * one adapter's folder for it couples the two for no reason.
 */

import type { ConsoleEntry } from './contract.js';

/** ISO-8601 stamp from epoch ms; deterministic given the injected clock. */
export function stamp(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * Render a {@link ConsoleEntry} as one greppable `logs/console.log` line.
 *
 * Shape: `<ISO stamp> <LEVEL> <text> @ <location>` — the `@ location` part is
 * dropped when the entry has none.
 */
export function formatConsoleLine(entry: ConsoleEntry): string {
  const where = entry.location ? ` @ ${entry.location}` : '';
  return `${stamp(entry.timestamp)} ${entry.level.toUpperCase()} ${entry.text}${where}`;
}
