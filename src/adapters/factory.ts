/**
 * Adapter factory — resolve a target name to a concrete Adapter implementation.
 *
 * Maps config targets (`web`, `desktop`, `mobile`, …) to their adapter protocols
 * (CDP browser, X11-Wayland, ADB). Throws {@link TargetNotFoundError} if the target
 * name doesn't exist in the config; throws {@link AdapterError} only for an unknown
 * adapter kind. `browser` (CDP), `desktop` (X11) and `android` (ADB) are operational.
 */

import type { Config } from '../config/schema.js';
import { AdapterError, TargetNotFoundError } from '../errors.js';
import { AndroidAdapter } from './android/android-adapter.js';
import { BrowserAdapter, type BrowserAdapterInit } from './browser/browser-adapter.js';
import type { Adapter } from './contract.js';
import { DesktopAdapter } from './desktop/desktop-adapter.js';

/**
 * Create an adapter for a named target from the resolved config.
 *
 * @param targetName — the key in config.targets (e.g., "web")
 * @param config — the resolved `.ui-debugger-mcp.json` config
 * @param profileDir — absolute path to persistent profile dir (for managed browser adapter)
 * @param onLog — optional sink for streaming console/network logs to findings store
 * @returns the wired Adapter instance
 * @throws TargetNotFoundError if targetName doesn't exist in config.targets
 * @throws AdapterError if the adapter type is not yet implemented
 */
export async function createAdapter(
  targetName: string,
  config: Config,
  profileDir: string,
  onLog?: BrowserAdapterInit['onLog'],
): Promise<Adapter> {
  const target = config.targets[targetName];

  if (!target) {
    throw new TargetNotFoundError(`target "${targetName}" not found in config.targets`);
  }

  switch (target.adapter) {
    case 'browser':
      return BrowserAdapter.create({ config: target, profileDir, onLog });

    case 'desktop':
      // Desktop is managed-only (no attach handle), so `profileDir`/`onLog` don't apply.
      return DesktopAdapter.create({ config: target });

    case 'android':
      // Managed (boot `emulator @avd`) unless `adbSerial` attaches — `create` reads that
      // off the config. No page profile or CDP log sink applies, so neither is threaded.
      return AndroidAdapter.create({ config: target });

    default: {
      const unreachable: never = target;
      throw new AdapterError(`unknown adapter type: ${unreachable}`);
    }
  }
}
