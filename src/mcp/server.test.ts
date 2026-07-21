import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { ResolvedConfig } from '../config/load.js';
import { McpServerError } from '../errors.js';
import { FindingsSchema } from '../findings/schema.js';
import { DebugService } from '../services/debug-service.js';
import type { BuiltSession } from '../services/session-builder.js';
import { FindingsStore } from '../session/findings-store.js';
import { SessionManager } from '../session/manager.js';
import type { LoopRunner, SessionAdapter } from '../session/session.js';
import { Session } from '../session/session.js';
import { _resetCounter, sessionPaths, workspacePaths } from '../session/workspace.js';
import { createMcpServer, type McpTool, startStdioServer } from './server.js';
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

const CWD = '/project/app';
const NOW = 1_700_000_000_000;

const CONFIG: ResolvedConfig = {
  models: { driver: 'deepseek/x', vision: 'glm/y', summary: 'deepseek/z' },
  workspace: './tmp/ui-debugger-mcp',
  targets: {
    web: { adapter: 'browser', url: 'http://localhost:3000', headless: true },
  },
  provider: { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1' },
};

class FakeAdapter implements SessionAdapter {
  async close(): Promise<void> {}
}

/** A run that idles until aborted. */
const idleRun: LoopRunner = ({ signal }) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

function fakeBuilder() {
  return async (params: { id: string; target: string; goal: string; criteria?: string }) => {
    const adapter = new FakeAdapter();
    const store = new FindingsStore(sessionPaths(workspacePaths(CWD, tmpDir), params.id));
    const session = new Session<SessionAdapter>({
      id: params.id,
      story: params.goal,
      criteria: params.criteria,
      adapter,
      findingsStore: store,
    });
    const built: BuiltSession = {
      session,
      open: async () => {},
      run: idleRun,
    };
    return built;
  };
}

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
      build: fakeBuilder(),
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

// ---------------------------------------------------------------------------
// Client death — stdio EOF must reach the caller's close hook. Fake streams
// stand in for the process's own stdin/stdout; no real stdio is touched.
// ---------------------------------------------------------------------------

/** A stdout that swallows everything the transport writes. */
const sink = (): Writable =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

/** A promise plus the resolver a callback fires — lets a test await a hook. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Let pending stream events ('close' after 'end') land before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('startStdioServer close hook', () => {
  test('a dead client (stdin EOF) fires the hook exactly once', async () => {
    const stdin = new PassThrough();
    const fired = gate();
    let calls = 0;
    const server = await startStdioServer([], {
      stdin,
      stdout: sink(),
      onClose: () => {
        calls += 1;
        fired.open();
      },
    });
    expect(server.isConnected()).toBe(true);

    stdin.end(); // the client's write end goes away

    await fired.wait;
    await settle(); // 'close' follows 'end' — the guard must hold
    expect(calls).toBe(1);
    expect(server.isConnected()).toBe(false);
  });

  test('an explicit close fires the same hook, and EOF after it does not repeat', async () => {
    const stdin = new PassThrough();
    let calls = 0;
    const server = await startStdioServer([], {
      stdin,
      stdout: sink(),
      onClose: () => {
        calls += 1;
      },
    });

    await server.close();
    expect(calls).toBe(1);

    stdin.end();
    await settle();
    expect(calls).toBe(1);
  });

  test('EOF closes the server even with no hook wired', async () => {
    const stdin = new PassThrough();
    const server = await startStdioServer([], { stdin, stdout: sink() });

    stdin.end();

    await settle();
    expect(server.isConnected()).toBe(false);
  });

  test('client death ends the active run (main.ts wiring)', async () => {
    _resetCounter();
    const dir = await mkdtemp(join(tmpdir(), 'ui-dbg-eof-test-'));
    tmpDir = dir;
    const runManager = new SessionManager<Session>();
    const service = new DebugService({
      manager: runManager,
      config: CONFIG,
      cwd: CWD,
      build: fakeBuilder(),
      now: () => NOW,
    });
    const stdin = new PassThrough();
    const ended = gate();
    await startStdioServer(outerTools(service), {
      stdin,
      stdout: sink(),
      onClose: () => {
        void service
          .endActive()
          .catch(() => undefined)
          .finally(ended.open);
      },
    });

    await service.start({ target: 'web', goal: 'client dies mid-run' });
    expect(runManager.has(CWD)).toBe(true);

    stdin.end(); // client process dies

    await ended.wait;
    expect(runManager.has(CWD)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
