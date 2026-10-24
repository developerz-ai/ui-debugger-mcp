/**
 * Adapter availability — the DERIVED fact behind `describe`'s `operational` flag.
 *
 * Two independent conditions, both required:
 *   1. the kind is WIRED in this build — the factory ships an implementation for
 *      it (see {@link isAdapterWired});
 *   2. the host platform is one the kind supports (the table below).
 *
 * The flag is bounded to WIRING/CAPABILITY availability. It NEVER promises that
 * the target is up, that a browser/emulator/device is installed or connected, or
 * that the next `start_debug` will succeed — those fail loud at launch, where
 * the real cause is visible.
 */

import type { Target } from '../config/schema.js';
import { isAdapterWired } from './factory.js';

/**
 * The host platforms each adapter kind supports (node `process.platform` ids).
 *
 * browser — CDP + Chromium are cross-platform.
 * desktop — X11/Wayland + AT-SPI + xdotool + scrot/grim are Linux tooling.
 * android — ADB + the Android SDK ship on Linux and macOS.
 *
 * The ids are typed `NodeJS.Platform`, NOT `string`: a typo'd id ('linuix')
 * would otherwise compile and silently make its kind non-operational on every
 * host. The key type is the config-schema union (`Target['adapter']`), so an
 * adapter kind added to the schema without a row here is a TYPE error too.
 */
export const SUPPORTED_PLATFORMS: Readonly<Record<Target['adapter'], readonly NodeJS.Platform[]>> =
  {
    browser: ['linux', 'darwin', 'win32'],
    desktop: ['linux'],
    android: ['linux', 'darwin'],
  };

/**
 * The lookup view of {@link SUPPORTED_PLATFORMS} — same rows, but each row is
 * OPTIONAL.
 *
 * The table above is TOTAL over the config-schema union, so every wired kind
 * HAS a row by construction — the type forbids the missing-row case. This view
 * keeps the lookup total anyway, so a row that goes missing at runtime (the
 * exported table is mutable) answers `false` instead of throwing a bare
 * `TypeError` on `undefined.includes(...)`.
 */
const SUPPORTED_ROWS: Readonly<Partial<Record<Target['adapter'], readonly NodeJS.Platform[]>>> =
  SUPPORTED_PLATFORMS;

/**
 * Whether an adapter kind is usable HERE — wired in this build AND supported
 * on the host platform.
 *
 * An unknown kind is simply not wired: the lookup never throws, it answers
 * `false`. (A config naming one is rejected at load time anyway — the schema is
 * a closed union — so this only guards the off-schema case.)
 *
 * @param kind — the adapter kind (e.g. "browser"); may be unknown
 * @param platform — the host platform; defaults to this process's
 */
export function isAdapterOperational(
  kind: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!isAdapterWired(kind)) return false;
  // The guard above narrowed `kind` to the schema union, whose every member has
  // a row in the total table. `SUPPORTED_ROWS` still admits a missing row, so
  // this answers false for one — it never throws.
  return SUPPORTED_ROWS[kind]?.includes(platform) ?? false;
}
