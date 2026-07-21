/**
 * Browser lifecycle guards — the failure paths of {@link BrowserAdapter.create}.
 *
 * Two rules, both about not poisoning the NEXT run:
 *   - **No zombie Chrome.** Anything that throws after the browser is already up
 *     must close it before rethrowing. A leaked persistent context keeps holding
 *     the per-project profile lock, so every later launch dies on it.
 *   - **No raw Playwright errors.** `create` failures leave as {@link AdapterError}
 *     like every other adapter call (see the adapter's header contract). The
 *     profile-lock case — by far the most common — says how to unblock it.
 *
 * Lives beside the adapter rather than inside it: same reason `query.ts`/`cdp.ts` do.
 */

import { AdapterError } from '../../errors.js';

/** A Playwright handle opened by a lifecycle: the context (managed) or the browser (attach). */
export interface Closable {
  close(): Promise<void>;
}

/**
 * Run post-connect setup, closing `handle` if it throws. On success the value is
 * returned untouched and the handle stays open — the caller owns it from then on.
 *
 * A failing `close()` is swallowed on purpose: the setup failure is the real news
 * and a teardown error must not mask it. Best-effort teardown still beats leaking
 * the profile lock.
 */
export async function closeOnFailure<T>(handle: Closable, setup: () => Promise<T>): Promise<T> {
  try {
    return await setup();
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Chrome's profile-lock signatures, as they reach us through Playwright's
 * "Browser output:" dump — `process_singleton_posix.cc` prints the first, the
 * lock-file variants print the others.
 */
const PROFILE_LOCK_SIGNATURES = [
  /profile appears to be in use/i,
  /SingletonLock/i,
  /ProcessSingleton/i,
];

/** Which lifecycle failed — decides what the error message can usefully point at. */
export type CreateContext =
  | { mode: 'managed'; profileDir: string }
  | { mode: 'attach'; cdpUrl: string };

/**
 * Translate a `create` failure into a loud {@link AdapterError}. An AdapterError
 * passes through as-is — it already names the problem, and double-wrapping would
 * only bury it.
 */
export function createFailure(error: unknown, ctx: CreateContext): AdapterError {
  if (error instanceof AdapterError) return error;
  const detail = error instanceof Error ? error.message : String(error);

  if (ctx.mode === 'attach') {
    return new AdapterError(`browser.create failed: cannot attach to ${ctx.cdpUrl} — ${detail}`);
  }
  if (PROFILE_LOCK_SIGNATURES.some((signature) => signature.test(detail))) {
    return new AdapterError(
      `browser.create failed: Chrome profile ${ctx.profileDir} is locked by another Chrome — ` +
        'one debug run per project. End the other run (`ui-debugger-mcp stop`) or close that ' +
        `Chrome, then retry — ${detail}`,
    );
  }
  return new AdapterError(`browser.create failed: cannot launch Chrome — ${detail}`);
}
