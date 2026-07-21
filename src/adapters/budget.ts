/**
 * Shared wall-clock budget guard for adapter waits.
 *
 * A run's `timeout` is a cap measured from `start_debug` receipt, so everything
 * the caller waits on — Chrome launch, the first navigation, an emulator boot —
 * has to fit INSIDE it. The service hands each of those the budget it has left;
 * this is the one place that decides what a budget means: it only ever SHORTENS
 * an adapter's own wait, never extends it past the adapter's default.
 *
 * Two ways a budget could quietly become an INFINITE wait, both guarded here:
 * `Math.min(30_000, NaN)` is `NaN`, and `0` means "no timeout at all" to Playwright.
 * A spent budget floors at 1ms instead — fail fast, never hang (same reasoning as
 * `remainingTimeout` in the browser adapter).
 */

import { AdapterError } from '../errors.js';

/** The adapter's own wait, shortened to `budgetMs` when the caller has less left. */
export function capWait(defaultMs: number, budgetMs?: number): number {
  if (budgetMs === undefined) return defaultMs;
  if (!Number.isFinite(budgetMs) || budgetMs < 0) {
    throw new AdapterError(
      `\`timeoutMs\` must be a non-negative, finite number of ms (got ${budgetMs})`,
    );
  }
  return Math.max(1, Math.min(defaultMs, budgetMs));
}
