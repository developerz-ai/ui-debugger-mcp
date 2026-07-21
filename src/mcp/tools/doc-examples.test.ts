// Doc-lint guard: every fenced `tool_name { ... }` example in README.md and
// docs/reference.md must validate against that tool's real Zod input shape —
// catches drift like a stale `wait: true` example after `wait` became an int.

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { DebugApi } from '../../services/debug-service.js';
import { outerTools } from './index.js';

const ROOT = join(import.meta.dir, '../../..');
const TOOL_LINE = /^(start_debug|send_message|get_findings|describe|end_session)\s+(\{.*\})$/;
const BARE_KEY = /([{,]\s*)(\w+)(\s*:)/g;

/** Register every outer tool against a stub server, capturing each raw Zod shape. */
function inputSchemas(): Record<string, z.ZodTypeAny> {
  const schemas: Record<string, z.ZodTypeAny> = {};
  const server = {
    registerTool(name: string, config: { inputSchema?: z.ZodRawShape }) {
      schemas[name] = z.object(config.inputSchema ?? {});
    },
  } as unknown as McpServer;
  for (const tool of outerTools({} as unknown as DebugApi)) tool.register(server);
  return schemas;
}

function extractExamples(file: string): Array<{ tool: string; json: string }> {
  return readFileSync(join(ROOT, file), 'utf8')
    .split('\n')
    .map((line) => line.trim().match(TOOL_LINE))
    .filter((m): m is RegExpMatchArray => m !== null)
    .map((m) => ({ tool: m[1] as string, json: (m[2] as string).replace(BARE_KEY, '$1"$2"$3') }));
}

test('fenced tool-call examples in README.md + docs/reference.md match their Zod schemas', () => {
  const schemas = inputSchemas();
  const examples = [...extractExamples('README.md'), ...extractExamples('docs/reference.md')];
  expect(examples.length).toBeGreaterThan(0);
  for (const { tool, json } of examples) {
    const schema = schemas[tool];
    expect(schema, `no schema registered for ${tool}`).toBeDefined();
    const parsed = schema?.safeParse(JSON.parse(json));
    expect(parsed?.success, `${tool} ${json} → ${JSON.stringify(parsed?.error?.issues)}`).toBe(
      true,
    );
  }
});
