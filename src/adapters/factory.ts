/**
 * Adapter factory — resolve a target name to a concrete Adapter implementation.
 *
 * Maps config targets (`web`, `desktop`, `mobile`, …) to their adapter protocols
 * (CDP browser, X11-Wayland, ADB). Throws {@link TargetNotFoundError} if the target
 * name doesn't exist in the config; throws {@link AdapterError} only for an unknown
 * adapter kind. The dispatch below WIRES three kinds — `browser` (CDP), `desktop`
 * (X11/Wayland) and `android` (ADB) — and {@link isAdapterWired} is the one place
 * that says so. Whether a kind is usable also depends on the host platform; see
 * `adapters/availability.ts`.
 */

import type { Config, Target } from '../config/schema.js';
import { AdapterError, TargetNotFoundError } from '../errors.js';
import { AndroidAdapter } from './android/android-adapter.js';
import { BrowserAdapter } from './browser/browser-adapter.js';
import type { Adapter, CaptureSink } from './contract.js';
import { DesktopAdapter } from './desktop/desktop-adapter.js';

/**
 * The adapter kinds this build wires — the exact set the dispatch switch below
 * handles.
 *
 * `satisfies` (not `:`) ties the map to `Target['adapter']`: a kind added to the
 * config schema without a wiring entry here is a TYPE error, and an entry here
 * without a schema kind is an excess-property error. The switch's `never`
 * default ties the dispatch to the same union — so the map, the dispatch and
 * the schema cannot drift apart.
 */
const WIRED_ADAPTERS = {
  browser: true,
  desktop: true,
  android: true,
} satisfies Record<Target['adapter'], true>;

/**
 * Whether this build wires an adapter kind — a pure lookup that never throws
 * on an unknown kind (it is simply not wired).
 */
export function isAdapterWired(kind: string): kind is Target['adapter'] {
  return Object.hasOwn(WIRED_ADAPTERS, kind);
}

/**
 * Create an adapter for a named target from the resolved config.
 *
 * @param targetName — the key in config.targets (e.g., "web")
 * @param config — the resolved `.ui-debugger-mcp.json` config
 * @param profileDir — absolute path to persistent profile dir (for managed browser adapter)
 * @param onLog — optional sink for streaming console/network logs to findings store
 * @param timeoutMs — the run's remaining wall-clock budget for getting the target up;
 *   only the browser launches/connects here, so only it shortens its wait by it
 * @returns the wired Adapter instance
 * @throws TargetNotFoundError if targetName doesn't exist in config.targets
 * @throws AdapterError if the adapter type is not yet implemented
 */
export async function createAdapter(
  targetName: string,
  config: Config,
  profileDir: string,
  onLog?: CaptureSink,
  timeoutMs?: number,
): Promise<Adapter> {
  // `hasOwn`, never a plain index read: `targets` is a plain object, so
  // `targets['constructor']` (and `toString`, `valueOf`, `__proto__`) walks the
  // prototype chain and answers truthy — the guard passes and the run dies deeper
  // as "unknown adapter type: undefined". Mirrors the same guard in `buildSession`.
  const target = Object.hasOwn(config.targets, targetName) ? config.targets[targetName] : undefined;

  if (!target) {
    throw new TargetNotFoundError(`target "${targetName}" not found in config.targets`);
  }

  switch (target.adapter) {
    case 'browser':
      return BrowserAdapter.create({ config: target, profileDir, onLog, timeoutMs });

    case 'desktop':
      // Desktop is managed-only (no attach handle), so `profileDir`/`onLog` don't apply.
      // Nothing launches here either — `open` spawns the app, and caps itself there.
      return DesktopAdapter.create({ config: target });

    case 'android':
      // Managed (boot `emulator @avd`) unless `adbSerial` attaches — `create` reads that
      // off the config. No page profile applies, but the capture sink does: the logcat
      // rows reach the same redacting durable trail the browser writes.
      // The emulator boots in `open`, which is where the run budget caps it.
      return AndroidAdapter.create({ config: target, onLog });

    default: {
      const unreachable: never = target;
      throw new AdapterError(`unknown adapter type: ${unreachable}`);
    }
  }
}
