// Doc-lint guard: every fenced `tool_name { ... }` example in README.md and
// docs/reference.md must validate against that tool's real Zod input shape —
// catches drift like a stale `wait: true` example after `wait` became an int.
//
// The tool names come from the LIVE catalog (`outerTools`), never from a list
// written here: a new tool is covered without touching this file, and an
// example naming a tool the server does not expose fails loud instead of
// being skipped as "not an example".

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DebugApi } from '../../services/debug-service.js';
import { outerTools } from './index.js';

const ROOT = join(import.meta.dir, '../../..');
/** The docs that carry fenced tool-call examples. */
const DOCS = ['README.md', 'docs/reference.md'];
/** A tool-call-shaped line: `tool_name { … }` — the shape every example uses. */
const TOOL_CALL = /^([a-z][a-z0-9_]*)\s+(\{.*\})$/;
/** A bare (unquoted) key inside an example's argument object. */
const BARE_KEY = /([{,]\s*)(\w+)(\s*:)/g;

/** One outer tool as the server registers it: its name, input shape, params. */
interface RegisteredTool {
  readonly name: string;
  readonly schema: z.ZodTypeAny;
  readonly params: readonly string[];
}

/**
 * Register every outer tool against a stub server, capturing the name it
 * registers under and its raw Zod shape.
 *
 * The catalog is the only authority for the names: a sixth tool is picked up
 * automatically, and a doc naming a tool that does not exist is caught by the
 * lookup below instead of being skipped as "not an example".
 */
function registeredTools(): RegisteredTool[] {
  const registered: RegisteredTool[] = [];
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }) {
      // Strict: a doc that teaches a param the tool does not accept is drift
      // too — a plain object would strip the unknown key and pass.
      registered.push({
        name,
        schema: z.strictObject(config.inputSchema ?? {}),
        params: Object.keys(config.inputSchema ?? {}),
      });
    },
  } as unknown as McpServer;
  for (const tool of outerTools({} as unknown as DebugApi)) tool.register(server);
  return registered;
}

/** A tool-call example found in a doc: the tool it calls + its argument object. */
interface Example {
  readonly tool: string;
  readonly args: string;
}

/** Every tool-call-shaped line in `text`, with the bare keys quoted. */
function parseExamples(text: string): Example[] {
  return text
    .split('\n')
    .map((line) => line.trim().match(TOOL_CALL))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ tool: m[1] ?? '', args: (m[2] ?? '').replace(BARE_KEY, '$1"$2"$3') }));
}

/** The drift in one doc's examples: an unknown tool, or a shape the tool rejects. */
function findDrift(examples: Example[], tools: RegisteredTool[]): string[] {
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const drift: string[] = [];
  for (const { tool, args } of examples) {
    const found = byName.get(tool);
    if (!found) {
      drift.push(`unknown tool "${tool}" — the live catalog has: ${[...byName.keys()].join(', ')}`);
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(args);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      drift.push(`${tool} ${args} → not valid JSON (${reason})`);
      continue;
    }
    const parsed = found.schema.safeParse(value);
    if (!parsed.success) {
      drift.push(`${tool} ${args} → ${JSON.stringify(parsed.error.issues)}`);
    }
  }
  return drift;
}

test('fenced tool-call examples in README.md + docs/reference.md match their Zod schemas', () => {
  const tools = registeredTools();
  expect(tools.length).toBeGreaterThan(0);
  for (const doc of DOCS) {
    const examples = parseExamples(readFileSync(join(ROOT, doc), 'utf8'));
    // The anchor: a parser that finds nothing must FAIL, not pass vacuously.
    expect(examples.length, `${doc}: no tool-call examples found`).toBeGreaterThan(0);
    const drift = findDrift(examples, tools);
    expect(drift, `${doc}: ${drift.join(' | ')}`).toEqual([]);
  }
});

test('the guard fails when a doc example names a tool the catalog does not expose', () => {
  const tools = registeredTools();
  const original = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // The name comes from the catalog, so this test tracks the live tools.
  const name = tools[0]?.name ?? '';
  const renamed = `${name}_renamed`;
  const mutated = original.replaceAll(`${name} {`, `${renamed} {`);
  expect(mutated, `README.md has no "${name} {" example to rename`).not.toBe(original);
  const drift = findDrift(parseExamples(mutated), tools);
  expect(drift.join('\n')).toContain(`unknown tool "${renamed}"`);
});

test('the guard fails when a doc example renames a parameter', () => {
  const tools = registeredTools();
  const original = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Rename the first key of the first example — a doc that teaches a param the
  // tool does not accept is drift, and it must not pass unnoticed.
  let renamed = '';
  const mutated = original.replace(
    /^([a-z][a-z0-9_]*\s+\{\s*)([a-z_][a-z0-9_]*)(\s*:)/m,
    (_full: string, head: string, key: string, colon: string): string => {
      renamed = `${key}_renamed`;
      return `${head}${renamed}${colon}`;
    },
  );
  expect(renamed, 'README.md has no tool-call example to mutate').not.toBe('');
  const drift = findDrift(parseExamples(mutated), tools);
  expect(drift.join('\n')).toContain(renamed);
});

test('the guard fails when a doc example teaches a param the tool does not accept', () => {
  const tools = registeredTools();
  const original = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // An extra key is drift the other way round: the call would still work (the
  // server strips what it does not know), but the doc teaches a no-op param.
  const mutated = original.replace(
    /^([a-z][a-z0-9_]*\s+\{.*)(\})$/m,
    (_full: string, head: string): string => `${head}, not_a_param: 1 }`,
  );
  expect(mutated, 'README.md has no tool-call example to mutate').not.toBe(original);
  const drift = findDrift(parseExamples(mutated), tools);
  expect(drift.join('\n')).toContain('not_a_param');
});

test('the guard reports an example whose args are not valid JSON', () => {
  const tools = registeredTools();
  const tool = tools[0];
  expect(tool, 'the live catalog has no tools').toBeDefined();
  // The tool and its first param come from the live catalog — the example
  // below restates neither.
  const name = tool?.name ?? '';
  const key = tool?.params[0] ?? 'arg';
  // A single-quoted value survives the bare-key quoting, so JSON.parse fails:
  // the guard must REPORT that, not throw out of the loop.
  const examples = parseExamples(`${name} { ${key}: 'web' }`);
  expect(examples).toHaveLength(1);
  const drift = findDrift(examples, tools);
  expect(drift.length).toBeGreaterThan(0);
  expect(drift.join('\n')).toContain('not valid JSON');
});

test('a tool the docs never show an example for is still known to the guard', () => {
  const tools = registeredTools();
  // The catalog is the authority, not a list of names in this file: a tool with
  // no doc example is still recognized, so a sixth tool needs no edit here.
  const any = tools.find((tool) => tool.schema.safeParse({}).success);
  expect(any, 'no catalog tool accepts an empty argument object').toBeDefined();
  const examples = parseExamples(`${any?.name ?? ''} { }`);
  expect(findDrift(examples, tools)).toEqual([]);
});
