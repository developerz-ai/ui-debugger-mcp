/**
 * Outer-tool result shaping — the one place a service value becomes a
 * {@link CallToolResult}. Every outer tool returns a record, so the value rides
 * back BOTH as pretty-printed `text` (human/log readable) and as
 * `structuredContent` (the typed channel MCP clients parse). Keeps the five tool
 * handlers a single `toToolResult(await service.x(args))` line each.
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** A plain object value (not an array) — what every outer tool returns. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Wrap a service result as a tool response: pretty `text` plus `structuredContent` for records. */
export function toToolResult(data: unknown): CallToolResult {
  const text = JSON.stringify(data, null, 2);
  return {
    content: [{ type: 'text', text }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
  };
}
