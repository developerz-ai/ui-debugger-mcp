/**
 * Shared console-line rendering for every adapter that streams to the run's
 * durable capture trail.
 *
 * Lives at the `src/adapters/` root (next to `budget.ts`, `limit.ts`) because
 * TWO adapters render it: the browser's CDP capture and the android logcat
 * drain. A helper shared by siblings belongs in a shared place — reaching into
 * one adapter's folder for it couples the two for no reason.
 *
 * The line primitives themselves (`stamp`, `tabMarker`) are shared one step
 * further: the browser's network renderer draws the same `<ISO> [tab]` prefix,
 * so it imports them from here rather than keeping a second copy.
 */

import type { ConsoleEntry } from './contract.js';

/** ISO-8601 stamp from epoch ms; deterministic given the injected clock. */
export function stamp(ts: number): string {
  return new Date(ts).toISOString();
}

/**
 * The tab marker, between the timestamp and the row — ` [tab-1]`.
 *
 * Empty when the entry carries no tab (a target without tabs — desktop,
 * mobile): such a row renders byte-identically to the line it rendered before
 * the marker existed.
 */
export function tabMarker(tab: string | undefined): string {
  return tab === undefined ? '' : ` [${tab}]`;
}

/**
 * Render a {@link ConsoleEntry} as one greppable `logs/console.log` line.
 *
 * Shape: `<ISO stamp> [tab] <LEVEL> <text> @ <location>` — the `@ location`
 * part is dropped when the entry has none, and so is the `[tab]` marker: a row
 * from a target without tabs renders exactly as it did before markers existed.
 */
export function formatConsoleLine(entry: ConsoleEntry): string {
  const where = entry.location ? ` @ ${entry.location}` : '';
  return `${stamp(entry.timestamp)}${tabMarker(entry.tab)} ${entry.level.toUpperCase()} ${entry.text}${where}`;
}
