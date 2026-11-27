/**
 * Opaque target references — how a node stays addressable when its selector
 * would carry one of the run's secrets.
 *
 * `observe` builds each node's `target` from its accessible name. A page that
 * echoes a persona value in visible text ("Signed in as …") therefore puts the
 * secret into a selector the driver reads and the SDK re-sends every step.
 * Masking the selector would break it; omitting it leaves the node unreachable
 * (its name is masked too). So the belt hands out a reference instead and keeps
 * the real selector here, keyed by the run's adapter — `observe` issues, `act`
 * (and `observe`'s own `query`/`within`) resolve. One adapter per run, so a
 * reference can never resolve against another run's page.
 *
 * ## The spelling: `@@ref:N`
 *
 * It must not collide with a selector a driver could mean. Both dialects accept
 * ANY string as visible text in the end, so no printable spelling is impossible
 * outright — this one is chosen to mean nothing ELSE, and resolution is by exact
 * issued string, never by shape alone:
 *   - web (`browser/query.ts`): not an engine (`css=`, `text=`, `role=`, `id=`,
 *     `data-testid=`, `xpath=`, `internal:…=` — and Playwright's own `aria-ref=`
 *     — all need `name=`; this has no `=`), not `role "name"`, not a bare tag,
 *     and not valid CSS (`@` cannot start a selector).
 *   - native (`desktop/atspi-parse.ts`, `android/uiautomator.ts`): not
 *     `role "name"`; it could only be a literal name substring.
 * So the one reading left is "visible text that literally says `@@ref:3`" — and
 * that passes through untouched unless this run issued exactly that string. A
 * plain `ref=1` selector is never touched at all.
 */

import type { Adapter } from '../../adapters/contract.js';

/** One run's references: selectors in issue order, plus the reverse index. */
interface Registry {
  /** `@@ref:N` → selector (reference N is index N-1). */
  selectors: string[];
  /** selector → its reference, so issuing is O(1) however many a run holds. */
  refs: Map<string, string>;
}

const registries = new WeakMap<Adapter, Registry>();

/** The exact shape of an issued reference; capture = its 1-based number. */
const REF = /^@@ref:([1-9]\d*)$/;

/** The reference standing in for `selector` on this adapter — stable across re-reads. */
export function targetRefFor(adapter: Adapter, selector: string): string {
  let registry = registries.get(adapter);
  if (!registry) {
    registry = { selectors: [], refs: new Map() };
    registries.set(adapter, registry);
  }
  const known = registry.refs.get(selector);
  if (known !== undefined) return known;
  registry.selectors.push(selector);
  const ref = `@@ref:${registry.selectors.length}`;
  registry.refs.set(selector, ref);
  return ref;
}

/**
 * The real selector behind `target` when it is EXACTLY a reference this adapter
 * issued; every other string — including a reference-shaped one nobody issued —
 * passes through untouched and the adapter reports the miss as it would for any
 * selector that matches nothing.
 */
export function resolveTargetRef(adapter: Adapter, target: string): string {
  const match = REF.exec(target);
  if (!match) return target;
  return registries.get(adapter)?.selectors[Number(match[1]) - 1] ?? target;
}
