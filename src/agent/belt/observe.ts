/**
 * `observe` — the driver's read tool (inner belt).
 *
 * One SQL-like reader, with "tables" picked by `kind`, each routed to one method
 * on the shared {@link Adapter} contract:
 *   - `tree`       → `readState`   (normalized UI nodes; DOM · a11y · view-hierarchy)
 *   - `screenshot` → `screenshot`  (an evidence frame, SAVED to `screenshots/` — the
 *     driver is a blind text model and the SDK re-sends tool results every step, so
 *     the result carries the saved path, never the PNG bytes)
 *   - `console`    → `console`     (captured console/error log, newest first)
 *   - `network`    → `network`     (captured network exchanges, newest first)
 *   - `tabs`       → `tabs`        (open browser tabs)
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
  NodeField,
  TabInfo,
} from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';
import type { Redactor } from '../../redact.js';
import type { EvidenceRecorder } from './look.js';
import type { ActTrail } from './trail.js';
import { coerceWithin, dialectOf, NodeSchema, type TreeNode, withTargets } from './tree-targets.js';

/**
 * The observable channels `kind` selects (each routes to one contract method).
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

/** Header map with every value run through the redactor (names stay diagnostic). */
function redactHeaderValues(headers: Record<string, string>, redact: Redactor) {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, redact(value)]));
}

/**
 * One network exchange with the run's secrets masked in every free-text field.
 * The pre-run login's own POST sits in the capture buffer with the persona's
 * password in its `requestBody` — unredacted, the first `observe network` hands
 * it to the provider, and the SDK re-sends that result on every later step.
 * Everything else (status, timing, any field a later contract adds) passes through.
 */
function redactExchange(entry: NetworkEntry, redact: Redactor): NetworkEntry {
  return {
    ...entry,
    url: redact(entry.url),
    ...(entry.error !== undefined && { error: redact(entry.error) }),
    ...(entry.requestBody !== undefined && { requestBody: redact(entry.requestBody) }),
    ...(entry.responseBody !== undefined && { responseBody: redact(entry.responseBody) }),
    ...(entry.requestHeaders && {
      requestHeaders: redactHeaderValues(entry.requestHeaders, redact),
    }),
    ...(entry.responseHeaders && {
      responseHeaders: redactHeaderValues(entry.responseHeaders, redact),
    }),
  };
}

/**
 * Route one `observe` call to the adapter and shape the result. Pure over the
 * {@link Adapter} + {@link EvidenceRecorder} seams (no `tool()` wrapper), so it
 * unit-tests against fakes.
 *
 * `redact` is the run's secret redactor (`createSecretRedactor`, bound per run to
 * the auth persona's values); it defaults to identity, so an un-wired call is
 * unchanged. It is applied to every free-text field the driver reads back —
 * console text/location, each network exchange ({@link redactExchange}), tab
 * urls/titles and tree `value`s — because any of them can echo a typed
 * credential. The one exception is a tree node's `name`: `target` selectors are
 * built on it, and a masked name would hand the driver a selector that resolves
 * nothing.
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
      const projected = withTargets(nodes, dialect, fields, scoped).map((node) =>
        node.value === undefined ? node : { ...node, value: redact(node.value) },
      );
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
      // Cap first, then redact the kept rows: a persona value typed into the app
      // is echoed back in console text and source locations (`url?token=…`),
      // and these rows are what the driver reads AND what the trail records as
      // bugs — both must carry the redactor's marker, never the raw value.
      const entries = matched.slice(0, cap).map((entry) => ({
        ...entry,
        text: redact(entry.text),
        ...(entry.location !== undefined && { location: redact(entry.location) }),
      }));
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
      const entries = kept.slice(0, cap).map((entry) => redactExchange(entry, redact));
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
      const tabs = (await adapter.tabs()).map((tab) => ({
        ...tab,
        url: redact(tab.url),
        title: redact(tab.title),
      }));
      return { kind, count: tabs.length, tabs };
    }
    default: {
      const unreachable: never = kind;
      throw new AgentError(`unknown observe kind: ${String(unreachable)}`);
    }
  }
}

/**
 * Build the `observe` tool bound to one adapter + recorder, for the debug agent's belt.
 * `trail` (when wired by the loop) is the run's evidence trail: every error-level
 * console row a read returns is recorded there BEFORE the gate releases — dedupe
 * is the trail's job, so re-reads of the ring buffer add nothing — and a `report`
 * racing in the SAME step carries them even when the driver's `bugs` array omits
 * them. Other kinds record nothing; a failed read records nothing.
 *
 * `redact` threads through to {@link runObserve} (identity when omitted), so both
 * the rows the driver reads and the error rows recorded on the trail below
 * arrive persona-redacted.
 */
export function createObserveTool(
  adapter: Adapter,
  recorder: EvidenceRecorder,
  trail?: ActTrail,
  redact: Redactor = (line) => line,
) {
  return tool({
    description:
      'Read the target without mutating it. Pick a channel with kind (tree=UI nodes incl. iframe content, screenshot=PNG evidence saved to screenshots/ — returns its path, console=logs, network=requests with status/timing/payloads, tabs=open tabs); compose with query/fields/filters/limit/within. Use it to inspect state before and after acting.',
    inputSchema: ObserveInputSchema,
    execute: async (input) => {
      // Enter the trail's gate BEFORE the first await (same discipline as `act`),
      // so a same-step terminal read sees this read in flight rather than an idle
      // gate.
      const settle = trail?.begin();
      try {
        const result = await runObserve(adapter, recorder, input, redact);
        // Record AFTER the result exists, BEFORE releasing: the read succeeded, so
        // its error rows are real surfaced findings.
        if (result.kind === 'console') {
          for (const entry of result.entries) {
            // Error rows only — warn/log/info are working noise, not findings.
            if (entry.level !== 'error') continue;
            trail?.recordBug({
              kind: 'console',
              detail: entry.text,
              ...(entry.location !== undefined && { evidence: entry.location }),
            });
          }
        }
        return result;
      } finally {
        settle?.();
      }
    },
  });
}
