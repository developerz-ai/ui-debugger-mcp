/**
 * The target catalog behind `describe` — the projection of configured targets
 * onto their public, secret-free shape.
 *
 * Split out of `debug-service.ts` to keep that file under the 500-LOC cap. This
 * half is PURE: no session, no manager, no fs — a target's config in, its
 * public entry out. `managed` vs `attach` is DERIVED from the target itself (a
 * `cdpUrl` / `adbSerial` means "connect to a running one", never start/stop it),
 * `operational` from the host platform, and the persona NAMES are the only half
 * of the auth block that ever leaves the config.
 */

import { isAdapterOperational } from '../adapters/availability.js';
import type { Target } from '../config/schema.js';
import { TargetNotFoundError } from '../errors.js';
import type { TargetInfo } from './debug-api.js';

/** Whether a target is in attach mode (connects to a running instance, never start/stop). */
export function isAttach(target: Target): boolean {
  if (target.adapter === 'browser') return target.cdpUrl != null;
  if (target.adapter === 'android') return target.adbSerial != null;
  return false;
}

/**
 * Project one configured target onto its public {@link TargetInfo} (no secrets).
 *
 * `operational` is DERIVED, never hardcoded: the adapter kind must be wired in
 * this build AND supported on the host platform (see `adapters/availability.ts`).
 */
export function describeTarget(
  name: string,
  target: Target,
  platform: NodeJS.Platform,
): TargetInfo {
  const base: TargetInfo = {
    name,
    adapter: target.adapter,
    mode: isAttach(target) ? 'attach' : 'managed',
    operational: isAdapterOperational(target.adapter, platform),
    // What the project declares is EXPECTED of this app — the driver already gets
    // it in its prompt; the caller sees it here so "the table is empty" coming back
    // as a non-finding is explainable without opening the config file.
    ...(target.notes !== undefined && { notes: target.notes }),
  };
  if (target.adapter === 'browser') {
    // Persona NAMES are the discoverable half — a caller can pick a valid `as`
    // without opening the config file, and never sees the values.
    const personas = Object.keys(target.auth ?? {});
    return {
      ...base,
      url: target.url,
      headless: target.headless,
      ...(personas.length > 0 && { personas }),
    };
  }
  return base;
}

/**
 * The catalog `describe` reports — every configured target, or just the one
 * named. An unknown name fails loud: a silently empty list would read as "this
 * project has no targets" and send the caller looking for the wrong bug.
 */
export function selectTargets(
  targets: Record<string, Target>,
  named: string | undefined,
  platform: NodeJS.Platform,
): TargetInfo[] {
  const entries = Object.entries(targets);
  const selected = named === undefined ? entries : entries.filter(([name]) => name === named);
  if (named !== undefined && selected.length === 0) {
    throw new TargetNotFoundError(`target '${named}' not found in config.targets`);
  }
  return selected.map(([name, config]) => describeTarget(name, config, platform));
}
