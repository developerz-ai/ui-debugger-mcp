/**
 * Desktop adapter — integration test.
 *
 * What it needs
 * =============
 * - A running X11 display (Xvfb is fine):
 *     Xvfb :99 -screen 0 1280x720x24 & DISPLAY=:99 bun test
 * - `xdotool` (xdotool package) for input/window activation.
 * - `scrot` (X11) or `grim` (Wayland) for screenshots.
 * - `xmessage` (x11-apps / xorg-x11-apps) for the managed-process tests
 *   (the `open` / `close` case is skipped automatically if it's absent).
 *
 * Skip conditions (any one → whole suite skips):
 *   - `SKIP_DESKTOP_TESTS=1` env is set, OR
 *   - `DISPLAY` env is not set (no X11 server reachable), OR
 *   - `xdotool` binary is absent from PATH.
 *
 * What it tests
 * =============
 * Exercises the real {@link DesktopAdapter} code paths against live system tools
 * (no fakes). AT-SPI may or may not be configured — the tests are written so
 * they pass in either case:
 *
 *   - `screenshot` — captures the live display; validates the PNG magic header.
 *   - `waitFor`    — times out loud on a widget that never appears; confirms that
 *                    `networkIdle` is rejected (desktop has no network channel).
 *                    Both code paths throw {@link AdapterError} whether the
 *                    AT-SPI stack is up or not.
 *   - `console`    — confirmed unsupported (always throws AdapterError).
 *   - `network`    — confirmed unsupported (always throws AdapterError).
 *   - `open`       — (gated on `xmessage`) launches a self-closing dialog and
 *                    activates the window via xdotool.
 *   - `close`      — graceful teardown; second call is a no-op.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import type { DesktopTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import { DesktopAdapter } from './desktop-adapter.js';

// ---------------------------------------------------------------------------
// Skip guard — mirror the browser integration pattern
// ---------------------------------------------------------------------------

function canRun(): boolean {
  if (process.env.SKIP_DESKTOP_TESTS) return false;
  if (!process.env.DISPLAY) return false;
  try {
    execSync('which xdotool', { stdio: 'pipe' });
  } catch {
    return false;
  }
  return true;
}

function hasCmd(cmd: string): boolean {
  try {
    execSync(`which ${cmd} 2>/dev/null`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const RUNNABLE = canRun();

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

(RUNNABLE ? describe : describe.skip)('DesktopAdapter integration', () => {
  /**
   * A self-closing xmessage dialog (10 s timeout) so a stuck process never
   * blocks CI. `-nearmouse` puts it near the cursor so xdotool can find it
   * without needing to know the exact screen position.
   */
  const config: DesktopTarget = {
    adapter: 'desktop',
    launch: 'xmessage -nearmouse -timeout 10 "UIDebugger integration test"',
    window: { title: 'xmessage' },
  };

  let adapter: DesktopAdapter;

  beforeAll(() => {
    adapter = DesktopAdapter.create({ config });
  });

  afterAll(async () => {
    await adapter?.close().catch(() => {});
  });

  // -------------------------------------------------------------------------
  // open — launch the managed process (skipped if xmessage is not installed)
  // -------------------------------------------------------------------------

  (hasCmd('xmessage') ? test : test.skip)(
    'open: launches xmessage and activates the window via xdotool',
    async () => {
      // Resolves once xdotool confirms the window is visible.
      await adapter.open('xmessage');
    },
    15_000,
  );

  // -------------------------------------------------------------------------
  // screenshot — always works on a live display (no AT-SPI required)
  // -------------------------------------------------------------------------

  test('screenshot: returns valid PNG bytes from the live display', async () => {
    const bytes = await adapter.screenshot();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic: \x89 P N G
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // 'P'
    expect(bytes[2]).toBe(0x4e); // 'N'
    expect(bytes[3]).toBe(0x47); // 'G'
  }, 10_000);

  // -------------------------------------------------------------------------
  // waitFor — both failure modes surface as AdapterError regardless of whether
  // AT-SPI is running (query loop times out OR AT-SPI backend rejects → both
  // are AdapterError, so the test holds in either environment).
  // -------------------------------------------------------------------------

  test('waitFor: times out loud when the query never appears', async () => {
    await expect(
      adapter.waitFor({ query: '____no_such_widget____', timeout: 100 }),
    ).rejects.toThrow(AdapterError);
  }, 5_000);

  test('waitFor: rejects networkIdle (unsupported on desktop)', async () => {
    await expect(adapter.waitFor({ networkIdle: true })).rejects.toThrow(AdapterError);
  });

  test('waitFor: rejects an empty WaitOptions (no query, no networkIdle)', async () => {
    await expect(adapter.waitFor({})).rejects.toThrow(AdapterError);
  });

  // -------------------------------------------------------------------------
  // Unsupported channels — always throw regardless of environment
  // -------------------------------------------------------------------------

  test('console: throws AdapterError (no console channel on desktop)', async () => {
    await expect(adapter.console()).rejects.toThrow(AdapterError);
  });

  test('network: throws AdapterError (no network channel on desktop)', async () => {
    await expect(adapter.network()).rejects.toThrow(AdapterError);
  });

  // -------------------------------------------------------------------------
  // close — graceful teardown; second call is a no-op
  // -------------------------------------------------------------------------

  test('close: terminates the managed process; second call is a no-op', async () => {
    await expect(adapter.close()).resolves.toBeUndefined();
    await expect(adapter.close()).resolves.toBeUndefined();
  });
});
