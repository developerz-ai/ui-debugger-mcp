/**
 * Node-filter application for the browser adapter. Split out of `browser-adapter.ts`
 * to keep that file under the 500-LOC cap — no behavior change.
 */

import { AdapterError } from '../../errors.js';
import type { Bounds, Filters, FilterValue } from '../contract.js';
import type { RawNode } from './extractor.js';

/** Whitelisted `filters` keys for this adapter — anything else is rejected, not ignored. */
export const NODE_FILTER_KEYS = [
  'visible_eq',
  'enabled_eq',
  'role_in',
  'name_contains',
  'contrast_lt',
] as const;

function expectBoolean(key: string, value: FilterValue): boolean {
  if (typeof value !== 'boolean') {
    throw new AdapterError(`filter \`${key}\` expects a boolean`);
  }
  return value;
}

function expectString(key: string, value: FilterValue): string {
  if (typeof value !== 'string') {
    throw new AdapterError(`filter \`${key}\` expects a string`);
  }
  return value;
}

function expectNumber(key: string, value: FilterValue): number {
  if (typeof value !== 'number') {
    throw new AdapterError(`filter \`${key}\` expects a number`);
  }
  return value;
}

function expectStringArray(key: string, value: FilterValue): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new AdapterError(`filter \`${key}\` expects a string[]`);
  }
  return value;
}

/**
 * Apply the whitelisted node `filters` in JS. Throws {@link AdapterError} on an
 * unknown key (no silent injection surface) or a wrong value type.
 */
export function applyNodeFilters(nodes: RawNode[], filters?: Filters): RawNode[] {
  if (!filters) return nodes;
  let out = nodes;
  for (const [key, value] of Object.entries(filters)) {
    switch (key) {
      case 'visible_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.visible === want);
        break;
      }
      case 'enabled_eq': {
        const want = expectBoolean(key, value);
        out = out.filter((n) => n.enabled === want);
        break;
      }
      case 'role_in': {
        const roles = expectStringArray(key, value);
        out = out.filter((n) => roles.includes(n.role));
        break;
      }
      case 'name_contains': {
        const needle = expectString(key, value).toLowerCase();
        out = out.filter((n) => n.name.toLowerCase().includes(needle));
        break;
      }
      case 'contrast_lt': {
        // Keep only VISIBLE text nodes whose contrast is BELOW the threshold —
        // the one-call "find unreadable text" sweep runs without `visible_eq`,
        // so hidden nodes with coincidentally low contrast must drop out here or
        // they surface as false "hard-to-read text" findings (nodes without
        // style drop out too).
        const threshold = expectNumber(key, value);
        out = out.filter(
          (n) => n.visible && n.style?.contrast !== undefined && n.style.contrast < threshold,
        );
        break;
      }
      default:
        throw new AdapterError(
          `unknown filter \`${key}\` for browser adapter (allowed: ${NODE_FILTER_KEYS.join(', ')})`,
        );
    }
  }
  return out;
}

/** True when a node's center sits inside `region` — used to scope by a {@link Node} `within`. */
export function centerWithin(node: RawNode, region: Bounds): boolean {
  const cx = node.bounds.x + node.bounds.width / 2;
  const cy = node.bounds.y + node.bounds.height / 2;
  return (
    cx >= region.x &&
    cx <= region.x + region.width &&
    cy >= region.y &&
    cy <= region.y + region.height
  );
}
