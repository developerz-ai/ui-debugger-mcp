/**
 * Tree-node selectors for the belt — the `target` string `observe` attaches to
 * every node it returns, and the `within` scope it accepts back.
 *
 * Split from `observe.ts` (one responsibility per file): `observe` routes reads,
 * this module knows the two selector dialects ({@link SelectorDialect}) and how a
 * node round-trips between a read and the next `act`/`observe`.
 */

import { z } from 'zod';
import type {
  Adapter,
  Node,
  NodeField,
  NodeRef,
  SelectorDialect,
} from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';

/**
 * Columns a no-`fields` read returns. `style` (colour + contrast per text node)
 * is opt-in only — on a 200-node default read it would triple the payload the
 * text driver re-reads every step for data it rarely needs.
 */
const DEFAULT_PROJECTION = [
  'role',
  'name',
  'bounds',
  'enabled',
  'testid',
  'frame',
  'value',
  'checked',
] as const satisfies readonly NodeField[];

/** On-screen rectangle backing a {@link Node} `within` reference. */
const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/**
 * A {@link Node} echoed back as a `within` scope (the alternative to a selector string).
 *
 * `bounds`/`enabled` are OPTIONAL: a `fields:["role","name"]` read — what the web
 * addendum recommends for slim reads — returns neither, and rejecting the very node
 * observe just handed back is the kind of contradiction that burns steps. Role + name
 * are enough; {@link coerceWithin} turns a region-less node into a selector.
 */
export const NodeSchema = z.object({
  role: z.string(),
  name: z.string(),
  bounds: BoundsSchema.optional(),
  enabled: z.boolean().optional(),
  testid: z.string().optional(),
});

/** A `within` node as the driver may pass it — possibly projected down to role + name. */
type WithinNode = z.infer<typeof NodeSchema>;

/** A tree node projected for the agent, plus a ready-to-use `target` selector for `act`. */
export type TreeNode = Partial<Node> & { target?: string };

/**
 * The dialect an adapter speaks — READ from the adapter's own declaration
 * ({@link Adapter.selectorDialect}).
 *
 * It used to be inferred from `tabs`, which the contract marks optional and
 * web-only: a native target that grew a tab listing would silently flip to the
 * web dialect and hand the driver selectors its own parser cannot resolve. The
 * dialect is explicit now, and a missing or unknown declaration fails loud
 * instead of falling back to `web`.
 */
export function dialectOf(adapter: Adapter): SelectorDialect {
  // Read as `unknown`: the declaration is data, and a missing or misspelled one
  // must fail loud rather than slip through as the web default.
  const declared: unknown = adapter.selectorDialect;
  if (declared === 'web') return 'web';
  if (declared === 'native') return 'native';
  throw new AgentError(
    `adapter declares no usable selector dialect (got ${String(declared)}) — ` +
      'every adapter must declare `selectorDialect: "web" | "native"`',
  );
}

/** A role token both native parsers accept as the leading word of `role "name"`. */
const NATIVE_ROLE_TOKEN = /^[a-zA-Z][\w-]*$/;

/**
 * The base selector for a node on a NATIVE target (desktop AT-SPI · android
 * uiautomator). Their query parsers accept exactly two shapes — `role "name"`
 * (`/^([a-zA-Z][\w-]*)\s+["'](.+)["']$/`, role matched exactly, name as a
 * case-insensitive substring) and a bare name substring — so that is all we emit.
 *
 * A `testid` here is android's `resource-id` (`com.app:id/submit`), which its
 * matcher tests against `name + resourceId`: the bare id is both accepted and
 * near-unique, so it wins, exactly like `data-testid` does on web.
 */
function nativeSelector(node: Pick<Node, 'role' | 'name' | 'testid'>): string | null {
  if (node.testid) return node.testid;
  const name = node.name.trim();
  if (!name) return null;
  // A quote inside the name would close the parser's quoted group early; fall back
  // to the bare-name form rather than emit a selector that resolves the wrong node.
  if (NATIVE_ROLE_TOKEN.test(node.role) && !name.includes('"')) return `${node.role} "${name}"`;
  return name;
}

/** ARIA roles Playwright's `role=` engine accepts (others fall back to a text selector). */
const ARIA_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'textbox',
  'combobox',
  'slider',
  'heading',
  'img',
  'navigation',
  'main',
  'form',
  'list',
  'listitem',
  'tab',
  'menuitem',
  'switch',
  'dialog',
  'banner',
  'contentinfo',
  'region',
  'article',
  'search',
  'table',
]);

/**
 * The base selector for a node the agent can paste straight into `act`'s `target`,
 * in the target's own {@link SelectorDialect} (a `native` node goes to
 * {@link nativeSelector}). Web: role + accessible name when the role is
 * ARIA-addressable, else the visible text. `null` for an unnamed, non-semantic
 * node (the agent targets those by other means).
 */
function baseSelector(
  node: Pick<Node, 'role' | 'name' | 'testid'>,
  dialect: SelectorDialect,
): string | null {
  if (dialect === 'native') return nativeSelector(node);
  // A test hook beats everything: document-unique, stable across renames/moves.
  if (node.testid) return `data-testid=${JSON.stringify(node.testid)}`;
  const name = node.name.trim();
  if (node.role && ARIA_ROLES.has(node.role) && name) {
    return `role=${node.role}[name=${JSON.stringify(name)} i]`;
  }
  if (name) return `text=${name}`;
  return null;
}

/**
 * Attach a copy-paste `target` to each tree node, disambiguating duplicates with
 * `>> nth=` in document order — so the agent never has to invent a selector (the
 * #1 cause of wasted steps: a blind model guessing CSS that does not resolve).
 *
 * A `scoped` read (`query`/`within`/`filters`) returns a *subset*, so the `nth=`
 * index — and even a bare role/text selector — can resolve a different element when
 * `act` replays it with an unscoped, document-wide `find` (e.g. header "Settings"
 * instead of the sidebar "Settings" the narrowed read returned). In that case we
 * emit no `target` — EXCEPT a testid one, which is document-unique and survives
 * any scoping. Otherwise, better the agent falls back (visible text /
 * `role "name"`) than act on the wrong node.
 *
 * `>> nth=` is Playwright chaining and exists on WEB only; the native parsers read
 * it as part of a name substring and match nothing. So on a native target a
 * repeated selector yields a `target` for the FIRST node only — the others are
 * genuinely unaddressable there, and saying so beats handing out a string that
 * silently acts on the first one.
 */
export function withTargets(
  nodes: Node[],
  dialect: SelectorDialect,
  fields?: readonly NodeField[],
  scoped = false,
): TreeNode[] {
  const seen = new Map<string, number>();
  const projection = fields && fields.length > 0 ? fields : DEFAULT_PROJECTION;
  return nodes.map((node) => {
    const projected: TreeNode = pick(node, projection);
    if (scoped) {
      if (node.testid) {
        projected.target =
          dialect === 'native' ? node.testid : `data-testid=${JSON.stringify(node.testid)}`;
      }
      return projected;
    }
    const base = baseSelector(node, dialect);
    if (!base) return projected;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    if (k === 0) projected.target = base;
    else if (dialect === 'web') projected.target = `${base} >> nth=${k}`;
    return projected;
  });
}

/** Pick a subset of keys off an object (a typed `SELECT cols`) for the `fields` projection. */
function pick<T, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  // Skip absent optionals (testid/style) so they never serialize as explicit nulls.
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  return out;
}

/**
 * A `within` node as a contract {@link NodeRef}: its on-screen region when it has one,
 * else the selector its testid/role/name resolve to — the same string `observe` would
 * have attached to that node as `target`.
 *
 * Adapters scope a {@link Node} `within` by `bounds` ALONE, so a region-less node has
 * to become a selector or it would silently read nothing. `enabled` is never read when
 * scoping; the contract just requires the field, so a projection that dropped it
 * defaults to `true` rather than throwing away an exact region.
 */
function scopeOf(node: WithinNode, dialect: SelectorDialect): NodeRef {
  const { bounds } = node;
  if (bounds !== undefined) return { ...node, bounds, enabled: node.enabled ?? true };
  const selector = baseSelector(node, dialect);
  if (selector) return selector;
  throw new AgentError(
    'observe `within` node has no `bounds` and no name/testid to resolve it — re-read with `fields` including "bounds", or pass a selector string',
  );
}

/**
 * Resolve `within` to something the {@link Adapter} contract takes — a selector string
 * or a {@link Node}. Two coercions, each fixing a shape drivers actually produce:
 *
 *  - a JSON-*stringified* node (`within: "{\"role\": …}"`). Before this it fell through
 *    as a selector, normalized to `text={"role"…}`, matched nothing, and returned an
 *    empty tree with no clue why — the single biggest step-waster observed.
 *    Garbage-that-looks-like-JSON fails loud instead of reading the whole page.
 *  - a node projected without `bounds` (`fields:["role","name"]`) → {@link scopeOf}.
 */
export function coerceWithin(
  within: string | WithinNode | undefined,
  dialect: SelectorDialect,
): NodeRef | undefined {
  if (within === undefined) return undefined;
  if (typeof within !== 'string') return scopeOf(within, dialect);
  if (!within.trimStart().startsWith('{')) return within;
  let data: unknown;
  try {
    data = JSON.parse(within);
  } catch {
    throw new AgentError(
      'observe `within` looks like a JSON node but does not parse — pass the node OBJECT exactly as observe returned it, or a selector string',
    );
  }
  const parsed = NodeSchema.safeParse(data);
  if (!parsed.success) {
    throw new AgentError(
      'observe `within` was a JSON string but not a valid node (needs role + name) — pass a node from a previous observe, or a selector string',
    );
  }
  return scopeOf(parsed.data, dialect);
}
