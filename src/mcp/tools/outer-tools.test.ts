import { expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type {
  DebugApi,
  DescribeInput,
  EndInput,
  GetFindingsInput,
  SendInput,
  StartInput,
} from '../../services/debug-service.js';
import { createMcpServer, type McpTool } from '../server.js';
import { outerTools } from './index.js';
import { toToolResult } from './result.js';

interface Call {
  method: string;
  args: unknown;
}

/** A fake service recording every call; each method returns a fixed record. */
function fakeApi(): { api: DebugApi; calls: Call[] } {
  const calls: Call[] = [];
  const api: DebugApi = {
    start: async (args: StartInput) => {
      calls.push({ method: 'start', args });
      return { session_id: 's1' };
    },
    send: (args: SendInput) => {
      calls.push({ method: 'send', args });
      return { ok: true, session_id: args.session_id };
    },
    getFindings: async (args: GetFindingsInput) => {
      calls.push({ method: 'getFindings', args });
      return { status: 'running', steps: [], bugs: [], visual: [] };
    },
    describe: (args: DescribeInput) => {
      calls.push({ method: 'describe', args });
      return { targets: [], models: { driver: 'd', vision: 'v', summary: 's' }, workspace: 'w' };
    },
    end: async (args: EndInput) => {
      calls.push({ method: 'end', args });
      return { ok: true, session_id: args.session_id };
    },
  };
  return { api, calls };
}

type ToolHandler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<CallToolResult> | CallToolResult;

/** Register a tool against a stand-in server and capture the name + raw handler. */
function capture(tool: McpTool): { name: string; handler: ToolHandler } {
  let name: string | undefined;
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(toolName: string, _config: unknown, cb: ToolHandler) {
      name = toolName;
      handler = cb;
    },
  } as unknown as McpServer;
  tool.register(server);
  if (name === undefined || handler === undefined) throw new Error('tool did not register');
  return { name, handler };
}

const text = (result: CallToolResult): string => (result.content[0] as { text: string }).text;

test('outerTools exposes exactly the five tools in catalog order', () => {
  const { api } = fakeApi();
  expect(outerTools(api).map((t) => t.name)).toEqual([
    'start_debug',
    'send_message',
    'get_findings',
    'describe',
    'end_session',
  ]);
});

test('the five tools register on a real McpServer with their Zod raw shapes', () => {
  const { api } = fakeApi();
  expect(createMcpServer(outerTools(api))).toBeInstanceOf(McpServer);
});

test('each handler forwards its args to the service and shapes the result', async () => {
  const { api, calls } = fakeApi();
  const [startDebug, sendMessage, getFindings, describe, endSession] = outerTools(api);
  if (!startDebug || !sendMessage || !getFindings || !describe || !endSession) {
    throw new Error('missing tool');
  }

  const start = capture(startDebug);
  expect(start.name).toBe('start_debug');
  const startRes = await start.handler({ target: 'web', goal: 'log in' });
  expect(startRes.structuredContent).toEqual({ session_id: 's1' });
  expect(JSON.parse(text(startRes))).toEqual({ session_id: 's1' });

  await capture(sendMessage).handler({ session_id: 's1', message: 'hi' });
  await capture(getFindings).handler({ session_id: 's1', fields: ['status'] });
  await capture(describe).handler({ target: 'web' });
  await capture(endSession).handler({ session_id: 's1' });

  expect(calls).toEqual([
    { method: 'start', args: { target: 'web', goal: 'log in' } },
    { method: 'send', args: { session_id: 's1', message: 'hi' } },
    { method: 'getFindings', args: { session_id: 's1', fields: ['status'] } },
    { method: 'describe', args: { target: 'web' } },
    { method: 'end', args: { session_id: 's1' } },
  ]);
});

test('toToolResult carries records as text + structuredContent', () => {
  const result = toToolResult({ a: 1 });
  expect(result.structuredContent).toEqual({ a: 1 });
  expect(JSON.parse(text(result))).toEqual({ a: 1 });
});

test('toToolResult omits structuredContent for a non-record value', () => {
  const result = toToolResult('hi');
  expect(result.structuredContent).toBeUndefined();
  expect(text(result)).toBe('"hi"');
});
