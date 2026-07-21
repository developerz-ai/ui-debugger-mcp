/**
 * `createAdapter` — target lookup + per-kind dispatch. The factory's only job is
 * resolving `config.targets[name]` and handing it to the matching adapter class.
 *
 * Dispatch is proven against the REAL adapter classes, not mocks:
 *   - `DesktopAdapter.create` / `AndroidAdapter.create` are synchronous and
 *     side-effect-free (they just wire up closures; spawning only happens in
 *     `open()`, never called here), so constructing them for real and asserting
 *     `instanceof` is safe and fast.
 *   - `BrowserAdapter.create` does real I/O, so the browser case points `cdpUrl`
 *     at a closed local port — `connectOverCDP` refuses immediately, and the
 *     resulting error's wording (from `createFailure`) proves dispatch reached
 *     `BrowserAdapter` specifically (same technique as the existing
 *     `browser-adapter.test.ts` "create surfaces a failed CDP attach" case).
 *
 * (Module-mocking the three adapter classes was tried first and rejected: it
 * leaked into concurrently-running assertions in other test files — see
 * `browser-adapter.lifecycle.test.ts`'s header for the same finding.)
 */

import { expect, test } from 'bun:test';
import type { Config } from '../config/schema.js';
import { AdapterError, TargetNotFoundError } from '../errors.js';
import { AndroidAdapter } from './android/android-adapter.js';
import { DesktopAdapter } from './desktop/desktop-adapter.js';
import { createAdapter } from './factory.js';

const baseConfig = (targets: Config['targets']): Config => ({ targets });

// --- unknown target -----------------------------------------------------------

test('createAdapter throws TargetNotFoundError for a target name absent from config', async () => {
  const config = baseConfig({});
  await expect(createAdapter('web', config, '/tmp/profile')).rejects.toThrow(TargetNotFoundError);
  await expect(createAdapter('web', config, '/tmp/profile')).rejects.toThrow(/"web"/);
});

test('createAdapter names only the requested target, not the ones that DO exist', async () => {
  const config = baseConfig({ mobile: { adapter: 'android', avd: 'pixel' } });
  await expect(createAdapter('web', config, '/tmp/profile')).rejects.toThrow(TargetNotFoundError);
});

// --- per-kind dispatch ---------------------------------------------------------

test('createAdapter dispatches a `browser` target to BrowserAdapter', async () => {
  // Port 1 is never listening — `connectOverCDP` refuses immediately, no real
  // browser needed. `createFailure`'s attach-mode wording names the cdpUrl,
  // which only the browser branch would ever see.
  const target = {
    adapter: 'browser' as const,
    cdpUrl: 'http://127.0.0.1:1',
    headless: true,
  };
  const config = baseConfig({ web: target });

  const created = createAdapter('web', config, '/tmp/unused-profile');
  await expect(created).rejects.toThrow(AdapterError);
  await expect(created).rejects.toThrow(/cannot attach to http:\/\/127\.0\.0\.1:1/);
});

test('createAdapter dispatches a `desktop` target to DesktopAdapter', async () => {
  const target = { adapter: 'desktop' as const, launch: '/usr/bin/true' };
  const config = baseConfig({ desktop: target });

  const adapter = await createAdapter('desktop', config, '/tmp/unused-profile');

  expect(adapter).toBeInstanceOf(DesktopAdapter);
});

test('createAdapter dispatches an `android` target to AndroidAdapter', async () => {
  const target = { adapter: 'android' as const, avd: 'pixel_7' };
  const config = baseConfig({ mobile: target });

  const adapter = await createAdapter('mobile', config, '/tmp/unused-profile');

  expect(adapter).toBeInstanceOf(AndroidAdapter);
});
