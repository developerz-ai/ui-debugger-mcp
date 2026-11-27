/**
 * Resolving `start_debug({as})` to a configured persona — the config half of the
 * pre-run login (`login.ts` performs it). Split out for the 500-LOC cap.
 */

import type { AuthPersona, Target } from '../config/schema.js';
import { ConfigError } from '../errors.js';

/** What `start_debug({as})` resolved to — the persona plus the key that named it. */
export interface ResolvedAuth {
  /** The `as` key, as the caller typed it — every failure names it. */
  name: string;
  persona: AuthPersona;
}

/**
 * Resolve `start_debug({as})` against the target's configured personas.
 *
 * Fails loud ({@link ConfigError}) on an unknown key, listing the valid ones — an
 * `as` typo must NEVER fall through to a signed-out run, because every screen
 * behind the login then reads as a broken UI.
 */
export function resolveAuth(
  target: Target,
  targetName: string,
  as: string | undefined,
): ResolvedAuth | undefined {
  if (as === undefined) return undefined;
  if (target.adapter !== 'browser') {
    throw new ConfigError(
      `'as' (auth persona) only applies to web targets, but '${targetName}' is '${target.adapter}'`,
    );
  }
  const auth = target.auth;
  // `hasOwn`, never a plain index read — `auth['constructor']` walks the prototype
  // chain and answers truthy, and the run would die deeper with a persona of `{}`.
  const persona = auth && Object.hasOwn(auth, as) ? auth[as] : undefined;
  if (persona) return { name: as, persona };

  const configured = Object.keys(auth ?? {});
  const known =
    configured.length > 0
      ? `configured personas: ${configured.map((k) => `'${k}'`).join(', ')}`
      : `target '${targetName}' has no 'auth' block`;
  throw new ConfigError(
    `unknown auth persona '${as}' for target '${targetName}' — ${known}. ` +
      `Add it under targets.${targetName}.auth in .ui-debugger-mcp.json, or omit 'as' to run signed out.`,
  );
}
