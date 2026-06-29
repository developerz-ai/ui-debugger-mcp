/**
 * `observe` — the driver's read tool (inner belt).
 *
 * One SQL-like reader, four "tables" picked by `kind`, each routed to one method
 * on the shared {@link Adapter} contract:
 *   - `tree`       → `readState`   (normalized UI nodes; DOM · a11y · view-hierarchy)
 *   - `screenshot` → `screenshot`  (PNG bytes, base64 — an evidence frame)
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
} from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';

/** The four observable channels `kind` selects (each routes to one contract method). */
const OBSERVE_KINDS = ['tree', 'screenshot', 'console', 'network'] as const;

/** Selectable {@link Node} columns — the `fields` projection whitelist (contract-level). */
const NODE_FIELDS = ['role', 'name', 'bounds', 'enabled'] as const satisfies readonly NodeField[];

/** One `filters` predicate value; arrays back `_in`-style set membership (matches `FilterValue`). */
const FilterValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]);

/** On-screen rectangle backing a {@link Node} `within` reference. */
const BoundsSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
});

/** A {@link Node} echoed back as a `within` scope (the alternative to a selector string). */
const NodeSchema = z.object({
  role: z.string(),
  name: z.string(),
  bounds: BoundsSchema,
  enabled: z.boolean(),
});

/** `observe` input — flat + SQL-like; `kind` picks the table, the rest compose the read. */
export const ObserveInputSchema = z.object({
  kind: z.enum(OBSERVE_KINDS).describe('channel to read: tree | screenshot | console | network'),
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
  limit: z.number().int().nonnegative().optional().describe('cap how many rows return'),
  within: z
    .union([z.string(), NodeSchema])
    .optional()
    .describe('tree scope: restrict to a subtree/region (a selector or a node)'),
});

export type ObserveInput = z.infer<typeof ObserveInputSchema>;

/** A tree node projected for the agent, plus a ready-to-use `target` selector for `act`. */
export type TreeNode = Partial<Node> & { target?: string };

/** Structured `observe` result, discriminated on `kind` (mirrors the input channel). */
export type ObserveResult =
  | { kind: 'tree'; count: number; nodes: TreeNode[] }
  | { kind: 'screenshot'; encoding: 'png'; bytes: number; data: string }
  | { kind: 'console'; count: number; entries: ConsoleEntry[] }
  | { kind: 'network'; count: number; entries: NetworkEntry[] };

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
 * The base selector for a node the agent can paste straight into `act`'s `target`.
 * Role + accessible name when the role is ARIA-addressable, else the visible text.
 * `null` for an unnamed, non-semantic node (the agent targets those by other means).
 */
function baseSelector(node: Node): string | null {
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
 * A `scoped` read (`within`/`filters`) returns a *subset*, so the `nth=` index —
 * and even a bare role/text selector — can resolve a different element when `act`
 * replays it with an unscoped `find`. In that case we emit no `target`: better the
 * agent falls back (visible text / `role "name"`) than act on the wrong node.
 */
function withTargets(nodes: Node[], fields?: readonly NodeField[], scoped = false): TreeNode[] {
  const seen = new Map<string, number>();
  return nodes.map((node) => {
    const projected: TreeNode = fields && fields.length > 0 ? pick(node, fields) : { ...node };
    if (scoped) return projected;
    const base = baseSelector(node);
    if (!base) return projected;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    projected.target = k === 0 ? base : `${base} >> nth=${k}`;
    return projected;
  });
}

/** Pick a subset of keys off an object (a typed `SELECT cols`) for the `fields` projection. */
function pick<T, K extends keyof T>(obj: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) out[key] = obj[key];
  return out;
}

/**
 * Route one `observe` call to the adapter and shape the result. Pure over the
 * {@link Adapter} seam (no `tool()` wrapper), so it unit-tests against a fake.
 */
export async function runObserve(adapter: Adapter, input: ObserveInput): Promise<ObserveResult> {
  const { kind, query, fields, filters, limit, within } = input;

  switch (kind) {
    case 'tree': {
      const nodes = await adapter.readState({ query, filters, limit, within });
      const scoped = within !== undefined || filters !== undefined;
      const projected = withTargets(nodes, fields, scoped);
      return { kind, count: projected.length, nodes: projected };
    }
    case 'screenshot': {
      const png = await adapter.screenshot();
      return {
        kind,
        encoding: 'png',
        bytes: png.byteLength,
        data: Buffer.from(png).toString('base64'),
      };
    }
    case 'console': {
      const entries = await adapter.console({ filters, limit });
      return { kind, count: entries.length, entries };
    }
    case 'network': {
      const entries = await adapter.network({ filters, limit });
      return { kind, count: entries.length, entries };
    }
    default: {
      const unreachable: never = kind;
      throw new AgentError(`unknown observe kind: ${String(unreachable)}`);
    }
  }
}

/** Build the `observe` tool bound to one adapter, for the debug agent's belt. */
export function createObserveTool(adapter: Adapter) {
  return tool({
    description:
      'Read the target without mutating it. Pick a channel with kind (tree=UI nodes, screenshot=PNG evidence, console=logs, network=requests); compose with query/fields/filters/limit/within. Use it to inspect state before and after acting.',
    inputSchema: ObserveInputSchema,
    execute: (input) => runObserve(adapter, input),
  });
}
