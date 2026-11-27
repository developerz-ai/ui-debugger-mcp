import { tool } from 'ai';
import { z } from 'zod';
import type {
  Adapter,
  ConsoleEntry,
  NetworkEntry,
  Node,
  NodeField,
  NodeRef,
  SelectorDialect,
  TabInfo,
} from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';
import type { Redactor } from '../../redact.js';
import type { EvidenceRecorder } from './look.js';
import type { ActTrail } from './trail.js';

/**
 * The observable channels `kind` selects (each routes to one contract method).
 * Exported so the prompt-vs-schema drift guard (`prompts/schema-drift.test.ts`) can
 * assert every `kind:"…"` example the prompts teach is one the belt actually accepts.
 */
export const OBSERVE_KINDS = ['tree', 'screenshot', 'console', 'network', 'tabs'] as const;

/** Selectable {@link Node} columns — the `fields` projection whitelist (contract-level). */
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

/** Columns a no-`fields` read returns. `style` is opt-in only — on a 200-node default read it triples the payload the text driver re-reads every step. */
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

const DEFAULT_LOG_LIMIT = 50;

const API_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'websocket', 'eventsource', 'document']);

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
 * The type lives in the shared contract ({@link Adapter.selectorDialect}) — the
 * dialect is a property of the ADAPTER, not of the belt that reads it. It is
 * re-exported here so the belt's own public name still resolves.
 */
export type { SelectorDialect };

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
 * `>> nth=` in document order — so the agent never invents a selector (#1 cause of
 * wasted steps: a blind model guessing CSS that does not resolve).
 *
 * A `scoped` read returns a *subset*, so the `nth=` index — and even a bare
 * role/text selector — can resolve a *different* element when `act` replays it with
 * an unscoped document-wide `find`. In that case we emit no `target` — EXCEPT a
 * testid one, which is document-unique and survives any scoping. Better the agent
 * falls back (visible text / `role "name"`) than act on the wrong node.
 *
 * `>> nth=` is Playwright chaining (WEB only); native parsers read it as a name
 * substring and match nothing. So on native a repeated selector yields a `target`
 * for the FIRST node only — the others are genuinely unaddressable there.
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
 * A `within` node as a contract {@link NodeRef}: its region when it has one,
 * else the selector its testid/role/name resolve to — the same string `observe`
 * attaches to that node as `target`.
 *
 * Adapters scope `within` by `bounds` ALONE, so a region-less node has to become
 * a selector or it would silently read nothing. `enabled` defaults to `true` when
 * a projection dropped it — never thrown away.
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
 *
 * `redact` is the run's secret redactor, defaulting to identity so an un-wired
 * call is unchanged. Applied to console text/location and network URL/headers/
 * body — never to tree/screenshot/tabs.
 */
export async function runObserve(
  adapter: Adapter,
  recorder: EvidenceRecorder,
  input: ObserveInput,
  redact: Redactor = (line) => line,
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
    // Both log channels default to a bounded tail (DEFAULT_LOG_LIMIT); an explicit
    // `limit` — including `0` — wins, invalid ones die in the adapter. Both read the
    // adapter UNCAPPED and cap HERE, so dropped rows can be counted/reported; the
    // buffers behind them are already bounded (1000-entry ring on web, 500-line logcat
    // tail on android), so the extra rows cost nothing.
    case 'console': {
      const cap = limit ?? DEFAULT_LOG_LIMIT;
      const matched = await adapter.console({ filters });
      // Cap first, then redact the kept rows: a persona value typed into the app
      // is echoed back in console text and source locations (`url?token=…`),
      // and these rows are what the driver reads AND what the trail records as
      // bugs — both must carry the redactor's marker, never the raw value.
      const entries = matched.slice(0, cap).map((entry) => redactConsoleEntry(entry, redact));
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
      const entries = kept.slice(0, cap).map((entry) => redactNetworkEntry(entry, redact));
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

/**
 * Redact one `console` entry: text and source location (`url?token=…`) carry a
 * typed credential echoed back by the app under test.
 */
export function redactConsoleEntry(entry: ConsoleEntry, redact: Redactor): ConsoleEntry {
  return {
    ...entry,
    text: redact(entry.text),
    ...(entry.location !== undefined && { location: redact(entry.location) }),
  };
}

/**
 * Redact one `network` entry — request URL, headers and body — so typed auth
 * values never reach the driver via observe. JSON-serialized headers/bodies are
 * redacted too, catching percent-encoded and JSON-escaped spellings of a secret.
 */
export function redactNetworkEntry(entry: NetworkEntry, redact: Redactor): NetworkEntry {
  return {
    ...entry,
    url: redact(entry.url),
    ...(entry.requestHeaders !== undefined && {
      requestHeaders: redact(JSON.stringify(entry.requestHeaders)),
    }),
    ...(entry.responseHeaders !== undefined && {
      responseHeaders: redact(JSON.stringify(entry.responseHeaders)),
    }),
    ...(entry.requestBody !== undefined && { requestBody: redact(entry.requestBody) }),
    ...(entry.responseBody !== undefined && { responseBody: redact(entry.responseBody) }),
  };
}
