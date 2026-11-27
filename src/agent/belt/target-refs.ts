/**
 * Opaque target references — how a node stays addressable when its selector
 * would carry one of the run's secrets.
 *
 * `observe` builds each node's `target` from its accessible name. A page that
 * echoes a persona value in visible text ("Signed in as …") therefore puts the
 * secret into a selector the driver reads and the SDK re-sends every step.
 * Masking the selector would break it; omitting it leaves the node unreachable
 * (its name is masked too). So the belt hands out `ref=N` instead and keeps the
 * real selector here, keyed by the run's adapter — `observe` issues, `act`
 * (and `observe`'s own `query`/`within`) resolve. One adapter per run, so a
 * reference can never resolve against another run's page.
 */

import type { Adapter } from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';

/** The exact shape of an issued reference — nothing else is ever treated as one. */
const REF = /^ref=(\d+)$/;

/** Per-adapter registry: real selectors in issue order (`ref=N` is index N-1). */
const registries = new WeakMap<Adapter, string[]>();

/** The reference standing in for `selector` on this adapter — stable across re-reads. */
export function targetRefFor(adapter: Adapter, selector: string): string {
  let issued = registries.get(adapter);
  if (!issued) {
    issued = [];
    registries.set(adapter, issued);
  }
  const known = issued.indexOf(selector);
  if (known !== -1) return `ref=${known + 1}`;
  issued.push(selector);
  return `ref=${issued.length}`;
}

/**
 * The real selector behind `target` when it is an issued reference; any other
 * string passes through untouched. A reference this adapter never issued fails
 * loud — acting on a guess is how a run tests the wrong element.
 */
export function resolveTargetRef(adapter: Adapter, target: string): string {
  const match = REF.exec(target.trim());
  if (!match) return target;
  const selector = registries.get(adapter)?.[Number(match[1]) - 1];
  if (selector === undefined) {
    throw new AgentError(
      `unknown target reference ${JSON.stringify(target)} — copy a \`target\` from a fresh observe({kind:"tree"})`,
    );
  }
  return selector;
}
