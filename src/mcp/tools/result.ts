/**
 * Outer-tool result shaping — the one place a service value becomes a
 * {@link CallToolResult}. Every outer tool returns a record, so the value rides
 * back BOTH as pretty-printed `text` (human/log readable) and as
 * `structuredContent` (the typed channel MCP clients parse). Keeps the five tool
 * handlers a single `toToolResult(await service.x(args))` line each.
 *
 * Two spec-alignment behaviors live here too, so no tool handler has to think
 * about them:
 *  - **Truncation steering** (opt-in, see {@link ToolResultOptions.capLists}):
 *    a list over {@link MAX_LIST_ITEMS} gets capped, a `truncated` map records
 *    `{returned, total}` per capped field, and a trailing text block names the
 *    retrieval that returns it whole. Never capped without both — a dropped entry
 *    the caller cannot ask for again is silent data loss, and prose alone lets a
 *    caller that skips the note conclude there were exactly 20 findings.
 *  - **`resource_link`s**: evidence paths (screenshots, `replay.mp4`, logs) ride
 *    as `resource_link` content items (file:// URIs) alongside the text block —
 *    the spec-blessed form, not inline path strings the caller has to notice.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A plain object value (not an array) — what every outer tool returns. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Cap on a top-level array field before it gets truncated for the response. */
const MAX_LIST_ITEMS = 20;

/** Keys whose string value — when an absolute path — is evidence worth linking. */
const EVIDENCE_KEYS = new Set(['screenshot', 'evidence']);

type ResourceLinkContent = Extract<CallToolResult['content'][number], { type: 'resource_link' }>;

/** Guess a MIME type from an evidence path's extension; omit when unknown. */
function mimeTypeFor(path: string): string | undefined {
  if (path.endsWith('.png')) return 'image/png';
  if (path.endsWith('.jpg') || path.endsWith('.jpeg')) return 'image/jpeg';
  if (path.endsWith('.mp4')) return 'video/mp4';
  if (path.endsWith('.log')) return 'text/plain';
  return undefined;
}

/** Build one `resource_link` content item for an absolute evidence path. */
function resourceLink(path: string): ResourceLinkContent {
  const mimeType = mimeTypeFor(path);
  return {
    type: 'resource_link',
    uri: new URL(path, 'file://').href,
    name: path.split('/').pop() ?? path,
    ...(mimeType !== undefined && { mimeType }),
  };
}

/**
 * Walk a (findings-shaped) value collecting `resource_link`s for every absolute
 * path under an evidence-ish key. Only absolute paths qualify — `bugs[].evidence`
 * doubles as free-text ("line 42"), so a relative-looking string is left as text,
 * not linked. Dedupes by path (a replay path can be both `findings.evidence` and
 * on a step).
 */
function collectResourceLinks(value: unknown): ResourceLinkContent[] {
  const links: ResourceLinkContent[] = [];
  const seen = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, val] of Object.entries(node)) {
      if (typeof val === 'string' && EVIDENCE_KEYS.has(key) && val.startsWith('/')) {
        if (!seen.has(val)) {
          seen.add(val);
          links.push(resourceLink(val));
        }
      } else {
        walk(val);
      }
    }
  };
  walk(value);
  return links;
}

/** How much of one capped list actually came back. */
export interface Truncation {
  /** Items in this response. */
  returned: number;
  /** Items the run really has. */
  total: number;
}

/**
 * The key {@link toToolResult} attaches the per-list {@link Truncation} counts
 * under. Findings has no field by this name, so it can never shadow real data.
 */
export const TRUNCATED_KEY = 'truncated';

/** Cap any top-level array field over {@link MAX_LIST_ITEMS}; report what was dropped. */
function capLists(data: Record<string, unknown>): {
  capped: Record<string, unknown>;
  truncated: Record<string, Truncation>;
} {
  const truncated: Record<string, Truncation> = {};
  const capped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > MAX_LIST_ITEMS) {
      capped[key] = value.slice(0, MAX_LIST_ITEMS);
      truncated[key] = { returned: MAX_LIST_ITEMS, total: value.length };
    } else {
      capped[key] = value;
    }
  }
  return { capped, truncated };
}

/** Steering text appended when one or more lists got capped. */
function steeringNote(truncated: string[]): string {
  const fields = truncated.map((f) => `"${f}"`).join(', ');
  return (
    `Truncated ${truncated.join(', ')} to the first ${MAX_LIST_ITEMS} items (see "${TRUNCATED_KEY}" ` +
    'for the real totals). ' +
    `Call get_findings with fields=[${fields}] to read those arrays in full — ` +
    'a projected read is never truncated. The complete run also sits on disk: ' +
    'findings.json / replay.mp4 / the logs under the session workspace.'
  );
}

/** Per-call switches for {@link toToolResult}. */
export interface ToolResultOptions {
  /**
   * Cap over-long top-level arrays and append {@link steeringNote}.
   *
   * Opt-in, because the note has to name a retrieval that really returns the
   * dropped items. Only `get_findings` has one — and only for an unprojected
   * read, since `fields=[...]` comes back uncapped. Everything else stays whole:
   * `describe.targets` is the configured catalog, there is no page 2, so a
   * capped entry would be undiscoverable.
   */
  capLists?: boolean;
}

/** Wrap a service result as a tool response: pretty `text` plus `structuredContent` for records. */
export function toToolResult(data: unknown, options: ToolResultOptions = {}): CallToolResult {
  if (!isRecord(data)) {
    return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
  }

  const { capped, truncated } = options.capLists
    ? capLists(data)
    : { capped: data, truncated: {} as Record<string, Truncation> };
  const fields = Object.keys(truncated);
  // Structural, not just prose: a caller that skips the steering note below still
  // cannot read `steps: [20 items]` as "the run took 20 steps" — the counts say
  // otherwise, in the typed half of the result, where a client can assert on them.
  if (fields.length > 0) capped[TRUNCATED_KEY] = truncated;

  const content: CallToolResult['content'] = [
    { type: 'text', text: JSON.stringify(capped, null, 2) },
  ];
  if (fields.length > 0) {
    content.push({ type: 'text', text: steeringNote(fields) });
  }
  content.push(...collectResourceLinks(capped));

  return { content, structuredContent: capped };
}
