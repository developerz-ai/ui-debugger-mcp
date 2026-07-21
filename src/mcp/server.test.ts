import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { McpServerError } from '../errors.js';
import { FindingsSchema } from '../findings/schema.js';
import { DebugService } from '../services/debug-service.js';
import { SessionManager } from '../session/manager.js';
import type { Session } from '../session/session.js';
import { _resetCounter } from '../session/workspace.js';
import { createMcpServer, type McpTool } from './server.js';
import { CONFIG, CWD, fakeBuilder, NOW } from './server.test-helpers.js';
import { outerTools } from './tools/index.js';

const fakeTool = (name: string, onRegister?: (server: McpServer) => void): McpTool => ({
  name,
  register: (server) => onRegister?.(server),
});

test('createMcpServer registers every provided tool once, against the server', () => {
  const seen: Array<{ name: string; isServer: boolean }> = [];
  const tools = ['start_debug', 'send_message', 'get_findings', 'describe', 'end_session'].map(
    (name) =>
      fakeTool(name, (server) => seen.push({ name, isServer: server instanceof McpServer })),
  );

  const server = createMcpServer(tools);

  expect(server).toBeInstanceOf(McpServer);
  expect(seen.map((s) => s.name)).toEqual([
    'start_debug',
    'send_message',
    'get_findings',
    'describe',
    'end_session',
  ]);
  expect(seen.every((s) => s.isServer)).toBe(true);
});

test('createMcpServer rejects duplicate tool names with McpServerError', () => {
  const tools = [fakeTool('start_debug'), fakeTool('start_debug')];
  expect(() => createMcpServer(tools)).toThrow(McpServerError);
});

test('createMcpServer accepts an empty tool set', () => {
  expect(createMcpServer([])).toBeInstanceOf(McpServer);
});

// ---------------------------------------------------------------------------
// Integration tests — real outer tools wired to a fake DebugService via an
// in-memory MCP transport. No stdio, no browser, no network.
// ---------------------------------------------------------------------------

/** Cast the opaque return of `client.callTool()` to the concrete SDK result type. */
const callResult = (r: unknown): CallToolResult => r as CallToolResult;
/** Extract the JSON text from the first content item of a tool result. */
const resultText = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

// Variables shared across integration tests.
let tmpDir: string;
let manager: SessionManager<Session>;
let client: Client;
let serverTransport: InMemoryTransport;
let clientTransport: InMemoryTransport;

describe('integration: real MCP server + outer tools + fake DebugService', () => {
  beforeEach(async () => {
    _resetCounter();
    tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-server-test-'));
    manager = new SessionManager<Session>();

    const service = new DebugService({
      manager,
      config: CONFIG,
      cwd: CWD,
      build: fakeBuilder(tmpDir),
      now: () => NOW,
    });

    const server = createMcpServer(outerTools(service));
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'test', version: '0.0.1' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    if (manager.has(CWD)) await manager.end(CWD).catch(() => undefined);
    await client.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  test('listTools returns exactly 5 tools in catalog order', async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toEqual([
      'start_debug',
      'send_message',
      'get_findings',
      'describe',
      'end_session',
    ]);
  });

  test('every tool carries its declared annotations in tools/list', async () => {
    const { tools } = await client.listTools();
    const annotations = new Map(tools.map((t) => [t.name, t.annotations]));

    expect(annotations.get('start_debug')).toMatchObject({
      destructiveHint: false,
      openWorldHint: true,
    });
    expect(annotations.get('send_message')).toMatchObject({ destructiveHint: false });
    expect(annotations.get('get_findings')).toMatchObject({ readOnlyHint: true });
    expect(annotations.get('describe')).toMatchObject({ readOnlyHint: true });
    expect(annotations.get('end_session')).toMatchObject({ idempotentHint: true });
  });

  test('a thrown service error surfaces as isError:true, not a protocol-level failure', async () => {
    // get_findings for an id nobody started throws SessionNotFoundError inside the
    // handler. The SDK must turn that into a normal (non-throwing) tool result with
    // isError:true — a caller polling findings shouldn't need a try/catch around
    // every call just to notice a stale id.
    const res = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id: 'no-such-session' },
      }),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/no active debug session/i);
  });

  test('every tool declares an object outputSchema in tools/list', async () => {
    const { tools } = await client.listTools();
    const schemas = new Map(tools.map((t) => [t.name, t.outputSchema]));

    for (const [name, schema] of schemas) {
      expect(schema, `${name} declares no outputSchema`).toBeDefined();
      expect(schema?.type).toBe('object');
    }
    expect(schemas.get('start_debug')?.required).toEqual(['session_id']);
    expect(schemas.get('send_message')?.required).toEqual(['ok', 'session_id']);
    expect(schemas.get('end_session')?.required).toEqual(['ok', 'session_id']);
    expect(schemas.get('describe')?.required).toEqual(['targets', 'models', 'workspace']);
    // get_findings can project a subset (`fields`), so no key is promised.
    expect(schemas.get('get_findings')?.required).toBeUndefined();
    expect(Object.keys(schemas.get('get_findings')?.properties ?? {})).toEqual([
      'status',
      'steps',
      'bugs',
      'visual',
      'summary',
      'evidence',
    ]);
  });

  test('every tool result carries structuredContent the client validates', async () => {
    // listTools compiles + caches the client-side output validators; a payload
    // that misses its declared schema makes the following callTool throw.
    await client.listTools();

    const start = callResult(
      await client.callTool({ name: 'start_debug', arguments: { target: 'web', goal: 'typed' } }),
    );
    const { session_id } = start.structuredContent as { session_id: string };
    expect(start.structuredContent).toEqual(JSON.parse(resultText(start)));

    const send = callResult(
      await client.callTool({ name: 'send_message', arguments: { session_id, message: 'hi' } }),
    );
    expect(send.structuredContent).toEqual({ ok: true, session_id });

    const described = callResult(await client.callTool({ name: 'describe', arguments: {} }));
    expect(described.structuredContent).toEqual(JSON.parse(resultText(described)));

    const findings = callResult(
      await client.callTool({ name: 'get_findings', arguments: { session_id } }),
    );
    expect(findings.structuredContent).toEqual(JSON.parse(resultText(findings)));

    const ended = callResult(
      await client.callTool({ name: 'end_session', arguments: { session_id } }),
    );
    expect(ended.structuredContent).toEqual({ ok: true, session_id });
  });

  test('a projected get_findings read still satisfies the declared outputSchema', async () => {
    await client.listTools();
    const startRes = callResult(
      await client.callTool({ name: 'start_debug', arguments: { target: 'web', goal: 'sparse' } }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const findRes = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id, fields: ['status', 'bugs'] },
      }),
    );
    expect(findRes.isError).toBeFalsy();
    expect(findRes.structuredContent).toEqual({ status: 'running', bugs: [] });
  });

  test('describe returns Zod-valid output', async () => {
    const DescribeResultSchema = z.object({
      targets: z.array(
        z.object({
          name: z.string(),
          adapter: z.string(),
          mode: z.enum(['managed', 'attach']),
          operational: z.boolean(),
        }),
      ),
      models: z.object({ driver: z.string(), vision: z.string(), summary: z.string() }),
      workspace: z.string(),
    });

    const res = callResult(await client.callTool({ name: 'describe', arguments: {} }));
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(resultText(res));
    expect(() => DescribeResultSchema.parse(data)).not.toThrow();
    expect(data.targets).toHaveLength(1);
    expect(data.targets[0].name).toBe('web');
  });

  test('start_debug returns Zod-valid { session_id }', async () => {
    const StartResultSchema = z.object({ session_id: z.string().min(1) });

    const res = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'log in and verify dashboard' },
      }),
    );
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(resultText(res));
    expect(() => StartResultSchema.parse(data)).not.toThrow();
  });

  test('get_findings returns Zod-valid findings after start_debug', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'check header' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const findRes = callResult(
      await client.callTool({ name: 'get_findings', arguments: { session_id } }),
    );
    expect(findRes.isError).toBeFalsy();
    const data = JSON.parse(resultText(findRes));
    expect(() => FindingsSchema.parse(data)).not.toThrow();
    expect(data.status).toBe('running');
  });

  test('get_findings rejects an empty fields array at the schema boundary', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'check sidebar' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const findRes = callResult(
      await client.callTool({ name: 'get_findings', arguments: { session_id, fields: [] } }),
    );
    expect(findRes.isError).toBe(true);
    expect(resultText(findRes)).toMatch(/too_small|at least 1|fields/i);
  });

  test('end_session returns { ok: true, session_id }', async () => {
    const AckSchema = z.object({ ok: z.literal(true), session_id: z.string().min(1) });

    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'check footer' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const endRes = callResult(
      await client.callTool({ name: 'end_session', arguments: { session_id } }),
    );
    expect(endRes.isError).toBeFalsy();
    const data = JSON.parse(resultText(endRes));
    expect(() => AckSchema.parse(data)).not.toThrow();
    expect(manager.has(CWD)).toBe(false);
  });

  test('start_debug rejects a malformed url at the schema boundary', async () => {
    const res = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'go somewhere', url: 'not-a-url' },
      }),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/url/i);
  });

  test('start_debug rejects a timeout above the max', async () => {
    const res = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'go somewhere', timeout: 2_147_484 },
      }),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/timeout|too_big|2147483/i);
  });

  test('start_debug rejects a missing goal at the schema boundary', async () => {
    const res = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web' },
      }),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/goal/i);
  });

  test('get_findings rejects a wait above the max', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'check wait bound' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const res = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id, wait: 120_001 },
      }),
    );
    expect(res.isError).toBe(true);
    expect(resultText(res)).toMatch(/wait|too_big|120000/i);
  });

  test('second start_debug on the same cwd returns isError (SessionBusyError)', async () => {
    await client.callTool({ name: 'start_debug', arguments: { target: 'web', goal: 'first run' } });

    const second = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'second run' },
      }),
    );
    expect(second.isError).toBe(true);
    expect(resultText(second)).toMatch(/busy|already active/i);
    // The manager still holds the first session.
    expect(manager.has(CWD)).toBe(true);
  });
});
