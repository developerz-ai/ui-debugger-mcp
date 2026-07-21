/**
 * Shared `limit` guard for adapter reads.
 *
 * `limit` reaches adapters straight from agent input, and `Array.slice` misreads
 * bad values SILENTLY: `-1` drops only the last row, `NaN` yields `[]`, `1.5`
 * rounds. A blind driver would then reason over a quietly truncated tree, so
 * every read cap goes through here and fails loud instead.
 */

import { AdapterError } from '../errors.js';

/** Cap `items` at `limit` (`undefined` = uncapped). Throws on a negative/non-integer limit. */
export function capToLimit<T>(items: T[], limit?: number): T[] {
  if (limit === undefined) return items;
  if (!Number.isInteger(limit) || limit < 0) {
    throw new AdapterError('`limit` must be a non-negative integer');
  }
  return items.slice(0, limit);
}
