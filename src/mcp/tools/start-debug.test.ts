import { expect, test } from 'bun:test';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DebugApi, StartInput } from '../../services/debug-service.js';
import type { McpTool } from '../server.js';
import { startDebugTool } from './start-debug.js';

type ToolHandler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<CallToolResult> | CallToolResult;

/** Register the tool against a stand-in server and capture its raw handler. */
function capture(tool: McpTool): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, cb: ToolHandler) {
      handler = cb;
    },
  } as unknown as McpServer;
  tool.register(server);
  if (!handler) throw new Error('tool did not register');
  return handler;
}

/** A fake service that just records the `start` args it was called with. */
function fakeApi(): { api: DebugApi; starts: StartInput[] } {
  const starts: StartInput[] = [];
  const api: DebugApi = {
    start: async (args: StartInput) => {
      starts.push(args);
      return { session_id: 's1' };
    },
    send: (args) => ({ ok: true, session_id: args.session_id }),
    getFindings: async () => ({ status: 'running', steps: [], bugs: [], visual: [] }),
    describe: () => ({
      targets: [],
      models: { driver: 'd', vision: 'v', summary: 's' },
      workspace: 'w',
    }),
    end: async (args) => ({ ok: true, session_id: args.session_id }),
  };
  return { api, starts };
}

test('start_debug converts timeout seconds to timeoutMs for the service', async () => {
  const { api, starts } = fakeApi();
  const handler = capture(startDebugTool(api));

  await handler({ target: 'web', goal: 'log in', timeout: 30 });

  expect(starts).toEqual([{ target: 'web', goal: 'log in', timeoutMs: 30_000 }]);
});

test('start_debug omits timeoutMs entirely when timeout is not provided', async () => {
  const { api, starts } = fakeApi();
  const handler = capture(startDebugTool(api));

  await handler({ target: 'web', goal: 'log in' });

  expect(starts).toEqual([{ target: 'web', goal: 'log in' }]);
  expect(starts[0] && 'timeoutMs' in starts[0]).toBe(false);
});

test('start_debug converts a 1-second timeout to exactly 1000ms', async () => {
  const { api, starts } = fakeApi();
  const handler = capture(startDebugTool(api));

  await handler({ target: 'web', goal: 'quick check', timeout: 1 });

  expect(starts[0]?.timeoutMs).toBe(1000);
});

test('start_debug forwards url and criteria alongside the converted timeout', async () => {
  const { api, starts } = fakeApi();
  const handler = capture(startDebugTool(api));

  await handler({
    target: 'web',
    goal: 'log in',
    url: 'https://example.com',
    criteria: 'must not 500',
    timeout: 45,
  });

  expect(starts).toEqual([
    {
      target: 'web',
      goal: 'log in',
      url: 'https://example.com',
      criteria: 'must not 500',
      timeoutMs: 45_000,
    },
  ]);
});
