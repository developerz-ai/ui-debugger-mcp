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

test('toToolResult links absolute screenshot/evidence paths as resource_link content', () => {
  const result = toToolResult({
    status: 'passed',
    steps: [{ step: 'click #save', ok: true, screenshot: '/ws/screenshots/001-click.png' }],
    bugs: [{ kind: 'console', detail: 'TypeError', evidence: 'line 42' }],
    visual: [
      { issue: 'blurry', where: 'header', severity: 'low', screenshot: '/ws/screenshots/002.png' },
    ],
    evidence: '/ws/replay.mp4',
  });

  const links = result.content.filter((c) => c.type === 'resource_link');
  expect(links).toHaveLength(3);
  expect(links.map((l) => (l as { uri: string }).uri)).toEqual(
    expect.arrayContaining([
      'file:///ws/screenshots/001-click.png',
      'file:///ws/screenshots/002.png',
      'file:///ws/replay.mp4',
    ]),
  );
  // Non-path evidence ("line 42") never becomes a resource_link.
  expect(links.some((l) => (l as { uri: string }).uri.includes('line'))).toBe(false);
});

test('toToolResult dedupes resource_link paths seen more than once', () => {
  const result = toToolResult({
    steps: [{ step: 'replay', ok: true, screenshot: '/ws/replay.mp4' }],
    evidence: '/ws/replay.mp4',
  });
  const links = result.content.filter((c) => c.type === 'resource_link');
  expect(links).toHaveLength(1);
});

test('toToolResult caps an over-long top-level array and appends a steering note', () => {
  const steps = Array.from({ length: 25 }, (_, i) => ({ step: `s${i}`, ok: true }));
  const result = toToolResult({ status: 'passed', steps });

  const parsed = JSON.parse(text(result)) as { steps: unknown[] };
  expect(parsed.steps).toHaveLength(20);
  expect((result.structuredContent as { steps: unknown[] }).steps).toHaveLength(20);

  const notes = result.content
    .filter((c) => c.type === 'text')
    .map((c) => (c as { text: string }).text);
  expect(notes.some((t) => t.includes('steps') && t.includes('get_findings'))).toBe(true);
});

test('toToolResult leaves short arrays untouched and adds no steering note', () => {
  const result = toToolResult({ status: 'passed', steps: [{ step: 's0', ok: true }] });
  expect(result.content).toHaveLength(1);
});
