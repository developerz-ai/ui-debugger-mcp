/**
 * Getting Chrome open and pointed at the app — which binary, which URL, and the
 * failure paths of {@link BrowserAdapter.create}.
 *
 * Resolution first (binary, navigation target, login-bypass param, the default
 * waits the run budget may only shorten), then two rules about not poisoning the
 * NEXT run:
 *   - **No zombie Chrome.** Anything that throws after the browser is already up
 *     must close it before rethrowing. A leaked persistent context keeps holding
 *     the per-project profile lock, so every later launch dies on it.
 *   - **No raw Playwright errors.** `create` failures leave as {@link AdapterError}
 *     like every other adapter call (see the adapter's header contract). The
 *     profile-lock case — by far the most common — says how to unblock it.
 *
 * Lives beside the adapter rather than inside it: same reason `query.ts`/`cdp.ts` do.
 */

import { existsSync } from 'node:fs';
import { URL } from 'node:url';
import { chromium } from 'playwright-core';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';

// --- What to launch, and where to point it ----------------------------------

/** System Chrome channel used as the last resort when no binary can be resolved. */
const DEFAULT_CHANNEL = 'chrome';

/**
 * Playwright's own defaults for launching/connecting and for a navigation, restated
 * so the run budget can only SHORTEN them (`capWait`). Left implicit, these two sit
 * OUTSIDE the caller's cap and a `start_debug` with `timeout: 10` could still burn a
 * minute before the driver takes its first step.
 */
export const LAUNCH_TIMEOUT_MS = 30_000;
export const NAV_TIMEOUT_MS = 30_000;

/** Detect the Playwright-managed Chromium binary; null if it isn't installed. */
function detectManagedChromium(): string | null {
  try {
    const p = chromium.executablePath();
    return p && existsSync(p) ? p : null;
  } catch {
    return null; // Playwright browser not installed
  }
}

/**
 * Pick the Chromium binary for a managed launch. Order:
 *   1. explicit `executablePath` from config
 *   2. the Playwright-managed Chromium, if it's installed (`npx playwright install chromium`)
 *   3. fall back to the system Google Chrome channel
 * Without (2) the adapter failed on hosts that have the managed Chromium but no
 * system Chrome — the common dev setup. `detect` is injected so the ordering is
 * unit-testable without a real browser install.
 */
export function resolveLaunchBinary(
  config: WebTarget,
  detect: () => string | null = detectManagedChromium,
): { executablePath: string } | { channel: string } {
  if (config.executablePath) return { executablePath: config.executablePath };
  const managed = detect();
  if (managed) return { executablePath: managed };
  return { channel: DEFAULT_CHANNEL };
}

/**
 * Resolve a navigate target against the configured base URL. Drivers often pass
 * a relative path (`/`, `/login`) — `page.goto` rejects those as "invalid URL",
 * so anchor them to `base`. Absolute targets pass through unchanged.
 */
export function resolveTargetUrl(target: string, base?: string): string {
  try {
    return new URL(target, base).toString();
  } catch {
    return target; // relative target with no usable base — let `goto` surface a clear error
  }
}

/**
 * Append the login-bypass query param (`?<param>=true`) when `debugLogin` is configured.
 * A relative `target` (no config `url` base to anchor it) can't carry a query param —
 * fail loud with an {@link AdapterError} instead of leaking a raw `TypeError: Invalid URL`.
 */
export function appendDebugLogin(target: string, debugLogin?: { param: string }): string {
  if (!debugLogin) return target;
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    throw new AdapterError(
      `cannot append debug-login param to relative target ${JSON.stringify(target)} — set the web target's \`url\` in .ui-debugger-mcp.json so it resolves to an absolute URL`,
    );
  }
  url.searchParams.set(debugLogin.param, 'true');
  return url.toString();
}

// --- Not poisoning the next run ---------------------------------------------

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
