/**
 * Logcat for the android adapter — `logcat -v epoch` parsing, the console filters,
 * and the coverage bookkeeping that keeps the durable console trail free of repeats
 * (`logcat -t N` re-dumps the same tail on every read). Pure; the adapter owns the I/O.
 */

import { AdapterError } from '../../errors.js';
import type { CaptureSink, ConsoleEntry, Filters } from '../contract.js';
import { formatConsoleLine } from '../log-format.js';

/**
 * Cap on the retained console-coverage keys — the raw keys of the covered rows
 * still remembered individually. Bounded no matter how long the run or how wide
 * a one-off `limit` was. Trimming a span's oldest keys does NOT forget their
 * coverage: the rows stay covered as the span's `below` count, anchored by the
 * span's first retained key (a drain reaching them still contains that key —
 * the logcat buffer drops rows oldest first, and the anchor is newer).
 */
const MAX_COVERED_KEYS = 4096;

/** Android logcat priority letter → normalized console {@link ConsoleEntry} level. */
const LOGCAT_LEVEL: Record<string, ConsoleEntry['level']> = {
  V: 'log',
  D: 'debug',
  I: 'info',
  W: 'warn',
  E: 'error',
  F: 'error',
};

/**
 * One raw logcat row — the record exactly as logcat emitted it, before
 * normalization. This is the row's dedup identity: keying the NORMALIZED entry
 * instead would merge distinct rows (the timestamp rounds to whole milliseconds,
 * `F` and `E` fold into one level, and PID/TID are dropped entirely).
 */
export interface RawLogcatRow {
  /** Raw `sec.frac` text — the full precision logcat emitted, never rounded. */
  time: string;
  pid: string;
  tid: string;
  /** Raw priority letter — `F` and `E` normalize alike but are distinct rows. */
  priority: string;
  tag: string;
  text: string;
}

/** The occurrence identity of a raw row: the whole record, at full precision. */
function rawRowKey(row: RawLogcatRow): string {
  return `${row.time}|${row.pid}|${row.tid}|${row.priority}|${row.tag}|${row.text}`;
}

/** True when `needle` appears in `hay` contiguously starting at `start`. */
function matchesAt(hay: readonly string[], start: number, needle: readonly string[]): boolean {
  for (let i = 0; i < needle.length; i++) {
    if (hay[start + i] !== needle[i]) return false;
  }
  return true;
}

/** True when the last `r` entries of `covered` equal the first `r` of `keys`. */
function overlapAtHead(covered: readonly string[], keys: readonly string[], r: number): boolean {
  for (let i = 0; i < r; i++) {
    if (covered[covered.length - r + i] !== keys[i]) return false;
  }
  return true;
}

/**
 * One disjoint covered run — a contiguous stretch of log rows the durable
 * trail already holds. Drains are contiguous windows of one append-only log
 * and end up wholly covered, so each drain merges into one span; spans stay
 * disjoint and ordered oldest first.
 */
interface CoveredSpan {
  /**
   * Covered rows that sit directly below `keys[0]`, remembered as a count once
   * {@linkcode AndroidAdapter.capCoverage} trims their keys. They stay covered:
   * `keys[0]` anchors them (a drain reaching them still contains it), so their
   * coverage survives the trim without the keys.
   */
  below: number;
  /** Retained raw keys, oldest first; `keys[0]` anchors the span in a drain. */
  keys: string[];
}

/**
 * Where one covered span sits inside a drain: the covered drain range
 * (inclusive indexes), plus the span's covered rows OUTSIDE the drain — the
 * count below its head with the retained keys anchoring them, and the retained
 * keys above its tail — so the post-drain merge can keep covering them.
 */
interface SpanHit {
  from: number;
  to: number;
  /** Span rows covered below the drain's head, minus the retained `headKeys`. */
  belowAnchored: number;
  /** The span's retained keys below the drain's head (still covered). */
  headKeys: string[];
  /** The span's retained keys above the drain's tail (still covered). */
  tailKeys: string[];
}

/** The raw epoch time a row key starts with — `1546300800.000|1000|…` → 1546300800. */
function keyTime(key: string): number {
  return Number(key.slice(0, key.indexOf('|')));
}

/** Merge the hits' covered ranges into one sorted, disjoint union (overlaps fold). */
function unionOfRanges(hits: readonly SpanHit[]): Array<{ from: number; to: number }> {
  const sorted = [...hits].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Array<{ from: number; to: number }> = [];
  for (const hit of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && hit.from <= last.to + 1) {
      last.to = Math.max(last.to, hit.to);
    } else {
      out.push({ from: hit.from, to: hit.to });
    }
  }
  return out;
}

/** `1546300800.000  1000  1000 I Tag: message` — unmatched lines are skipped. */
const LOGCAT_ROW = /^\s*(\d+)\.(\d+)\s+(\d+)\s+(\d+)\s+([VDIWEF])\s+([^:]*):\s?(.*)$/;

/** Parse `logcat -v epoch` output into raw rows (oldest first, as emitted). */
export function parseRawLogcat(raw: string): RawLogcatRow[] {
  const out: RawLogcatRow[] = [];
  for (const line of raw.split('\n')) {
    const match = LOGCAT_ROW.exec(line);
    if (!match) continue;
    const [, sec, frac, pid, tid, priority, tag, text] = match;
    if (
      sec === undefined ||
      frac === undefined ||
      pid === undefined ||
      tid === undefined ||
      priority === undefined ||
      text === undefined
    ) {
      continue;
    }
    // A time `Date` cannot represent would make the console line's ISO stamp throw a
    // bare RangeError mid-read. Fail loud and name the row; dropping it silently would
    // hide a log line.
    if (!Number.isFinite(new Date(Number(`${sec}.${frac}`) * 1000).getTime())) {
      throw new AdapterError(
        `android: logcat row has an out-of-range time: ${JSON.stringify(line)}`,
      );
    }
    out.push({ time: `${sec}.${frac}`, pid, tid, priority, tag: (tag ?? '').trim(), text });
  }
  return out;
}

/** Normalize a raw row onto the adapter-agnostic {@link ConsoleEntry} shape. */
export function toConsoleEntry(row: RawLogcatRow): ConsoleEntry {
  return {
    level: LOGCAT_LEVEL[row.priority] ?? 'log',
    text: row.text,
    location: row.tag === '' ? undefined : row.tag,
    timestamp: Math.round(Number(row.time) * 1000),
  };
}

/**
 * Parse `logcat -v epoch` output into {@link ConsoleEntry}s (oldest first, as emitted).
 * Line shape: `1546300800.000  1000  1000 I Tag: message` — unmatched lines are skipped.
 */
export function parseLogcat(raw: string): ConsoleEntry[] {
  return parseRawLogcat(raw).map(toConsoleEntry);
}

/** Apply the whitelisted console `filters` (logcat). Loud on an unknown key or wrong type. */
export function applyLogFilters(entries: ConsoleEntry[], filters?: Filters): ConsoleEntry[] {
  if (!filters) return entries;
  let out = entries;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'level_eq': {
        if (typeof value !== 'string') throw new AdapterError('filter `level_eq` expects a string');
        out = out.filter((e) => e.level === value);
        break;
      }
      case 'level_in': {
        if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
          throw new AdapterError('filter `level_in` expects a string[]');
        }
        out = out.filter((e) => value.includes(e.level));
        break;
      }
      case 'text_contains': {
        if (typeof value !== 'string') {
          throw new AdapterError('filter `text_contains` expects a string');
        }
        const needle = value.toLowerCase();
        out = out.filter((e) => e.text.toLowerCase().includes(needle));
        break;
      }
      default:
        throw new AdapterError(
          `unknown filter \`${key}\` for android console (allowed: level_eq, level_in, text_contains)`,
        );
    }
  }
  return out;
}

/**
 * The covered runs: disjoint spans of raw keys — every row the durable trail
 * already holds, oldest first, capped at {@linkcode MAX_COVERED_KEYS} retained
 * keys (see {@linkcode LogcatCoverage.stream} and {@linkcode LogcatCoverage.capCoverage}).
 */
export class LogcatCoverage {
  #covered: CoveredSpan[] = [];

  /**
   * Stream the drained logcat rows to the capture sink — one formatted line per row.
   *
   * The sink is the run's redacting durable writer (the session layer binds it);
   * the adapter itself never writes to disk. `logcat -t N` re-dumps the same tail
   * on every read, so the durable trail would otherwise repeat it — coverage
   * prevents that without an ever-growing row set:
   *
   * Drains are chronological tails of one append-only log: each is a contiguous
   * run of rows, and the log's newest row only moves forward. What the trail
   * already holds is therefore a set of DISJOINT covered runs —
   * {@linkcode CoveredSpan}, oldest first — and this drain decides each of its
   * rows by locating every span inside it ({@linkcode LogcatCoverage.spanHit}):
   *
   *   - the span's retained keys found as one contiguous block of the drain →
   *     the block and the span's rows directly below it are covered → skipped;
   *     rows above the block sit below the earlier tail's cutoff, never drained
   *     → streamed now (a wider `limit` back-fills them, once);
   *   - the drain found inside a span's retained keys (a narrower read of an
   *     already-covered stretch) → the whole drain is covered → skipped;
   *   - only the span's key suffix found at the drain's head (the span
   *     straddles the drain's cutoff — a narrower drain, the span's oldest rows
   *     slid out of the buffer, or fresh rows arrived past it) → that overlap
   *     is skipped, everything after it streams;
   *   - no span located → the drain's rows are all fresh → they stream.
   *
   * Everything outside the covered ranges streams — the fresh suffix, back-fill
   * below an earlier cutoff, AND the unseen middle of a drain that bridged two
   * disjoint spans. Matching whole key SEQUENCES — never a boundary key — keeps
   * byte-identical records honest: a drain holding two copies of one record ends
   * on the second copy, and only a sequence match finds it; a first-key
   * `findIndex` would stop at the first copy and re-stream the rest. Under a
   * fully periodic drain an overlap is genuinely ambiguous; the earliest
   * (largest-skip) match wins, which never duplicates: two rows sharing a raw
   * key format to the same trail line, so a skipped twin loses no content.
   *
   * After the drain its whole extent is covered (every row streamed or
   * skipped), so it merges into one span — absorbing the spans it bridged,
   * keeping a straddling span's retained rows on either side of the drain, and
   * filing spans wholly below or above it where they were — and
   * {@linkcode LogcatCoverage.capCoverage} bounds the retained keys, folding
   * the oldest into the span's `below` count without forgetting their coverage.
   *
   * A failing sink never fails the read.
   */
  stream(rows: RawLogcatRow[], sink: CaptureSink | undefined): void {
    const oldest = rows[0];
    if (sink === undefined || oldest === undefined) return;
    const keys = rows.map(rawRowKey);
    // Locate every covered span inside this drain, and file the spans it does
    // not touch: disjoint from the drain, a span sits wholly below it (older
    // than the drain's oldest row) or wholly above (newer than its newest).
    const hits: SpanHit[] = [];
    const below: CoveredSpan[] = [];
    const above: CoveredSpan[] = [];
    const drainStart = keyTime(rawRowKey(oldest));
    for (const span of this.#covered) {
      const hit = this.#spanHit(span, keys);
      if (hit !== null) {
        hits.push(hit);
        continue;
      }
      const newest = span.keys[span.keys.length - 1];
      if (newest !== undefined && keyTime(newest) < drainStart) below.push(span);
      else above.push(span);
    }
    // Stream every row outside the union of the covered ranges.
    const ranges = unionOfRanges(hits);
    let cursor = 0;
    for (const [index, row] of rows.entries()) {
      let range = ranges[cursor];
      while (range !== undefined && range.to < index) {
        cursor++;
        range = ranges[cursor];
      }
      if (range !== undefined && index >= range.from) continue;
      try {
        sink('console', formatConsoleLine(toConsoleEntry(row)));
      } catch (error) {
        // A sink failure must not crash the read — the entries still come back.
        console.error(
          `android capture sink failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    // The drain's whole extent is covered now — every row streamed or skipped —
    // so it becomes one span. A straddling span's retained rows stay remembered
    // on either side of the drain; when several spans straddle (fully periodic
    // content), the most coverage kept wins, which never duplicates.
    let belowAnchored = 0;
    let headKeys: string[] = [];
    let tailKeys: string[] = [];
    for (const hit of hits) {
      if (hit.belowAnchored + hit.headKeys.length > belowAnchored + headKeys.length) {
        belowAnchored = hit.belowAnchored;
        headKeys = hit.headKeys;
      }
      if (hit.tailKeys.length > tailKeys.length) tailKeys = hit.tailKeys;
    }
    this.#covered = [
      ...below,
      { below: belowAnchored, keys: [...headKeys, ...keys, ...tailKeys] },
      ...above,
    ];
    this.#capCoverage();
  }

  /**
   * Locate one covered span inside this drain's keys (both oldest first).
   * Returns where the span's covered rows sit inside the drain — inclusive
   * `[from, to]` indexes plus the span's covered rows outside the drain — or
   * null when none of the span appears in it.
   */
  #spanHit(span: CoveredSpan, keys: string[]): SpanHit | null {
    const m = span.keys.length;
    const n = keys.length;
    if (m === 0 || n === 0) return null;
    // The span's retained keys as one contiguous block of the drain — a drain
    // at least as wide as the span's retained window. Earliest alignment wins
    // (see the streamRows note). The span's rows below the block are covered
    // too: the retained ones are anchored by the block, the trimmed ones by the
    // span's `below` count.
    if (n >= m) {
      for (let i = 0; i + m <= n; i++) {
        if (matchesAt(keys, i, span.keys)) {
          return {
            from: Math.max(0, i - span.below),
            to: i + m - 1,
            belowAnchored: span.below - Math.min(span.below, i),
            headKeys: [],
            tailKeys: [],
          };
        }
      }
    }
    // The drain as one contiguous block of the span's retained keys — a
    // narrower read of an already-covered stretch. The whole drain is covered,
    // and the span's retained rows on either side of it stay covered.
    if (m >= n) {
      for (let q = 0; q + n <= m; q++) {
        if (matchesAt(span.keys, q, keys)) {
          return {
            from: 0,
            to: n - 1,
            belowAnchored: span.below,
            headKeys: span.keys.slice(0, q),
            tailKeys: span.keys.slice(q + n),
          };
        }
      }
    }
    // Otherwise the drain's head sits inside the span: its longest suffix that
    // matches the drain's prefix is the overlap (the span straddles the drain's
    // cutoff, or its oldest rows slid out of the buffer).
    for (let r = Math.min(m, n); r >= 1; r--) {
      if (overlapAtHead(span.keys, keys, r)) {
        return {
          from: 0,
          to: r - 1,
          belowAnchored: span.below,
          headKeys: span.keys.slice(0, m - r),
          tailKeys: [],
        };
      }
    }
    return null;
  }

  /**
   * Bound the retained coverage keys at {@linkcode MAX_COVERED_KEYS}, oldest
   * first. A span's trimmed keys stay covered as its `below` count — the rows
   * sit directly below the span's new first key, contiguous with it and
   * anchored by it, so a later drain reaching them still skips them. A span
   * always keeps one anchor key; when every span is down to its anchor and the
   * cap still bites, the oldest spans drop whole — by then their rows left the
   * logcat buffer long before (the anchor is newer, and the buffer drops rows
   * oldest first).
   */
  #capCoverage(): void {
    let total = this.#covered.reduce((sum, span) => sum + span.keys.length, 0);
    for (const span of this.#covered) {
      if (total <= MAX_COVERED_KEYS) break;
      const droppable = span.keys.length - 1;
      if (droppable <= 0) continue;
      const drop = Math.min(droppable, total - MAX_COVERED_KEYS);
      span.below += drop;
      span.keys.splice(0, drop);
      total -= drop;
    }
    while (total > MAX_COVERED_KEYS && this.#covered.length > 1) {
      const dropped = this.#covered.shift();
      if (dropped === undefined) break;
      total -= dropped.keys.length;
    }
  }
}
