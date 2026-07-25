/**
 * `observe` — the driver's read tool (inner belt).
 *
 * One SQL-like reader, four "tables" picked by `kind`, each routed to one method
 * on the shared {@link Adapter} contract:
 *   - `tree`       → `readState`   (normalized UI nodes; DOM · a11y · view-hierarchy)
 *   - `screenshot` → `screenshot`  (an evidence frame, SAVED to `screenshots/` — the
 *     driver is a blind text model and the SDK re-sends tool results every step, so
 *     the result carries the saved path, never the PNG bytes)
 *   - `console`    → `console`     (captured console/error log, newest first)
 *   - `network`    → `network`     (captured network exchanges, newest first)
 *
 * Adapter-blind: routes through the contract only — it never learns the protocol
 * underneath. Composition lives in params (`query`/`fields`/`filters`/`limit`/
 * `within`), like a `SELECT` — see `idea/mcp-tools.md`.
 *
 * Whitelisting is split, and neither side is an injection surface:
 *   - **fields** (the `SELECT` projection) are whitelisted HERE to the contract's
 *     {@link NodeField}s via the Zod enum, then projected after the read.
 *   - **filters** (`WHERE field_op`) pass through and are whitelisted by the
 *     ADAPTER, which throws on an unknown key (per-adapter key sets differ).
 *
 * Fails loud: a bad filter/limit surfaces the adapter's `AdapterError`; we never
 * swallow it or silently fall back.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type {
  Adapter,
  ConsoleEntry,
  NetworkEntry,
  Node,
  NodeField,
  NodeRef,
  TabInfo,
} from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';
import type { EvidenceRecorder } from './look.js';

/**
 * The four observable channels `kind` selects (each routes to one contract method).
 * Exported so the prompt-vs-schema drift guard (`prompts/schema-drift.test.ts`) can
 * assert every `kind:"…"` example the prompts teach is one the belt actually accepts.
 */
export const OBSERVE_KINDS = ['tree', 'screenshot', 'console', 'network', 'tabs'] as const;

/**
 * Selectable {@link Node} columns — the `fields` projection whitelist (contract-level).
 * Exported for the same drift guard as {@link OBSERVE_KINDS}.
 */
export const NODE_FIELDS = [
  'role',
  'name',
  'bounds',
  'enabled',
  'testid',
  'style',
  'frame',
  'value',
  'checked',
] as const satisfies readonly NodeField[];

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

/**
 * Rows a no-`limit` `console`/`network` read returns (newest first, so the cap keeps
 * what just happened). The ring buffers hold 1000 entries each (`browser/cdp.ts`), the
 * driver is told to check both channels after acting, and the SDK re-sends every tool
 * result on every later step — so one unbounded read on a chatty page costs
 * entries × remaining steps of context. An explicit `limit` (including `0`) still wins.
 */
const DEFAULT_LOG_LIMIT = 50;

/**
 * Resource types a default `network` read keeps: the app talking to its backend,
 * plus the navigation itself.
 *
 * A page's traffic is overwhelmingly static assets — measured on a Vite dev
 * server, one real API call for every fifteen `script` loads (HMR re-requests
 * every module). Reading the newest 50 rows there returns fifty module fetches
 * and not one API call, which makes the channel useless exactly where it matters
 * most. Assets stay one explicit `resource_in` away (see {@link keepByDefault}).
 */
const API_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'websocket', 'eventsource', 'document']);

/**
 * Whether a default (unfiltered) `network` read shows this entry.
 *
 * Anything that FAILED is kept whatever its type — a 404 stylesheet or a broken
 * image is a real bug, and hiding it to cut noise would defeat the point. An
 * entry with no resource type is kept too: unknown is not the same as static.
 */
function keepByDefault(entry: NetworkEntry): boolean {
  if (!entry.ok) return true;
  return entry.resourceType === undefined || API_RESOURCE_TYPES.has(entry.resourceType);
}

/** One `filters` predicate value; arrays back `_in`-style set membership (matches `FilterValue`). */
const FilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

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
const NodeSchema = z.object({
  role: z.string(),
  name: z.string(),
  bounds: BoundsSchema.optional(),
  enabled: z.boolean().optional(),
  testid: z.string().optional(),
});

/** A `within` node as the driver may pass it — possibly projected down to role + name. */
type WithinNode = z.infer<typeof NodeSchema>;

/** `observe` input — flat + SQL-like; `kind` picks the table, the rest compose the read. */
export const ObserveInputSchema = z.object({
  kind: z
    .enum(OBSERVE_KINDS)
    .describe('channel to read: tree | screenshot | console | network | tabs'),
  query: z
    .string()
    .optional()
    .describe('tree selector: CSS/role/text (web), a11y role+name (desktop), id/text (android)'),
  fields: z
    .array(z.enum(NODE_FIELDS))
    .optional()
    .describe('tree projection: return only these node columns (omit for all)'),
  filters: z
    .record(z.string(), FilterValueSchema)
    .optional()
    .describe(
      'WHERE-style predicates, e.g. { visible_eq: true } | { status_gte: 400 }; per-channel',
    ),
  limit: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe(`cap how many rows return (console/network default ${DEFAULT_LOG_LIMIT})`),
  within: z
    .union([z.string(), NodeSchema])
    .optional()
    .describe(
      'tree scope: restrict to a subtree/region (a selector string, or a node OBJECT exactly as observe returned it — role + name is enough, not a JSON string)',
    ),
});

export type ObserveInput = z.infer<typeof ObserveInputSchema>;

/** A tree node projected for the agent, plus a ready-to-use `target` selector for `act`. */
export type TreeNode = Partial<Node> & { target?: string };

/** Structured `observe` result, discriminated on `kind` (mirrors the input channel). */
export type ObserveResult =
  | { kind: 'tree'; count: number; nodes: TreeNode[] }
  | { kind: 'screenshot'; path: string; bytes: number }
  | {
      kind: 'console';
      count: number;
      entries: ConsoleEntry[];
      /** Older rows the `limit` cut off (absent when none were). */
      truncated?: number;
      /** How to see the missing rows — present only alongside {@link truncated}. */
      hint?: string;
    }
  | { kind: 'tabs'; count: number; tabs: TabInfo[] }
  | {
      kind: 'network';
      count: number;
      entries: NetworkEntry[];
      /** Static-asset rows a default read held back (absent when none were). */
      hidden?: number;
      /** Older rows the `limit` cut off, after the asset default (absent when none were). */
      truncated?: number;
      /** How to see the missing rows — present only alongside {@link hidden}/{@link truncated}. */
      hint?: string;
    };

/**
 * Which selector grammar a target's `find({query})` parses — the belt emits the
 * `target` of every tree node in it, and the driver is told to copy that string
 * verbatim, so a `target` in the wrong dialect makes every click and type fail.
 *
 *  - `web` — Playwright engines (`data-testid="…"`, `role=button[name="…" i]`,
 *    `text=…`, `>> nth=N`), normalized by `adapters/browser/query.ts`.
 *  - `native` — the desktop (AT-SPI) and android (uiautomator) parsers, which take
 *    `role "name"` or a bare name substring and NOTHING else: an engine-prefixed
 *    selector degrades to a literal name substring, matches nothing, and `act`
 *    throws `no element matched …`.
 */
export type SelectorDialect = 'web' | 'native';

/**
 * The dialect an adapter speaks. Inferred from `tabs`, which the contract marks
 * web-only ("implemented by targets that have a tab concept (web); absent
 * elsewhere") — the one structural difference between the browser adapter and the
 * two native ones, since the rest of the contract is deliberately identical.
 */
export function dialectOf(adapter: Adapter): SelectorDialect {
  return typeof adapter.tabs === 'function' ? 'web' : 'native';
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
function withTargets(
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
  within: ObserveInput['within'],
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

/**
 * The `truncated` + `hint` pair for log rows the `limit` cut off; `{}` when the cap
 * dropped nothing.
 *
 * Silent truncation is the failure this exists to prevent: a submit flow that
 * produced 120 failing requests, read back capped at 50, tells a blind driver
 * "there were 50 failures" — and it reports that truncated picture as the finding.
 */
function truncation(dropped: number, cap: number): { truncated?: number; hint?: string } {
  if (dropped <= 0) return {};
  return {
    truncated: dropped,
    hint: `${dropped} older row(s) cut off by limit ${cap}; raise \`limit\` or narrow \`filters\` to see them`,
  };
}

/**
 * Route one `observe` call to the adapter and shape the result. Pure over the
 * {@link Adapter} + {@link EvidenceRecorder} seams (no `tool()` wrapper), so it
 * unit-tests against fakes.
 */
export async function runObserve(
  adapter: Adapter,
  recorder: EvidenceRecorder,
  input: ObserveInput,
): Promise<ObserveResult> {
  const { kind, query, fields, filters, limit, within } = input;

  switch (kind) {
    case 'tree': {
      const dialect = dialectOf(adapter);
      const scope = coerceWithin(within, dialect);
      const nodes = await adapter.readState({ query, filters, limit, within: scope });
      const scoped = query !== undefined || scope !== undefined || filters !== undefined;
      const projected = withTargets(nodes, dialect, fields, scoped);
      return { kind, count: projected.length, nodes: projected };
    }
    case 'screenshot': {
      // Save the frame as evidence and return its path — never the base64 bytes:
      // the driver is blind, and the SDK re-sends tool results on every later step,
      // so an inlined PNG would permanently flood the text model's context.
      const png = await adapter.screenshot();
      const path = await recorder.saveScreenshot('observe', png);
      return { kind, path, bytes: png.byteLength };
    }
    // Both log channels default to a bounded tail (see DEFAULT_LOG_LIMIT); an explicit
    // `limit` — including `0` — wins, invalid ones still die in the adapter. Both read
    // the adapter UNCAPPED and cap HERE, so the rows the cap drops can be counted and
    // reported: the buffers behind them are already bounded (a 1000-entry in-memory
    // ring on web, a 500-line logcat tail on android), so the extra rows cost nothing.
    case 'console': {
      const cap = limit ?? DEFAULT_LOG_LIMIT;
      const matched = await adapter.console({ filters });
      const entries = matched.slice(0, cap);
      return { kind, count: entries.length, entries, ...truncation(matched.length - cap, cap) };
    }
    case 'network': {
      // Read the caller's filters UNCAPPED, then apply the asset default and the
      // limit here: capping first would spend the whole budget on static assets
      // and leave nothing to hide, reporting `hidden: 0` on a page that is 90%
      // noise. The read is an in-memory ring, so the extra rows cost nothing.
      const cap = limit ?? DEFAULT_LOG_LIMIT;
      const matched = await adapter.network({ filters });
      // An explicit `resource_in` is the caller naming the types they want —
      // never second-guess it.
      const explicitTypes = filters !== undefined && 'resource_in' in filters;
      const kept = explicitTypes ? matched : matched.filter(keepByDefault);
      const entries = kept.slice(0, cap);
      const hidden = matched.length - kept.length;
      const cut = truncation(kept.length - cap, cap);
      // Never truncate silently: say what was held back and how to see it.
      const assetHint =
        hidden > 0
          ? `${hidden} static asset request(s) hidden; add filters:{resource_in:["script","stylesheet","image","font"]} to see them`
          : undefined;
      const hint = [assetHint, cut.hint].filter((part) => part !== undefined).join('; ');
      return {
        kind,
        count: entries.length,
        entries,
        ...(hidden > 0 && { hidden }),
        ...(cut.truncated !== undefined && { truncated: cut.truncated }),
        ...(hint !== '' && { hint }),
      };
    }
    case 'tabs': {
      if (!adapter.tabs) {
        throw new AgentError(
          "observe kind 'tabs' is not supported on this target — only web targets have tabs",
        );
      }
      const tabs = await adapter.tabs();
      return { kind, count: tabs.length, tabs };
    }
    default: {
      const unreachable: never = kind;
      throw new AgentError(`unknown observe kind: ${String(unreachable)}`);
    }
  }
}

/** Build the `observe` tool bound to one adapter + recorder, for the debug agent's belt. */
export function createObserveTool(adapter: Adapter, recorder: EvidenceRecorder) {
  return tool({
    description:
      'Read the target without mutating it. Pick a channel with kind (tree=UI nodes incl. iframe content, screenshot=PNG evidence saved to screenshots/ — returns its path, console=logs, network=requests with status/timing/payloads, tabs=open tabs); compose with query/fields/filters/limit/within. Use it to inspect state before and after acting.',
    inputSchema: ObserveInputSchema,
    execute: (input) => runObserve(adapter, recorder, input),
  });
}
