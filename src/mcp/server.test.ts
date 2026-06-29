import { expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { McpServerError } from '../errors.js';
import { createMcpServer, type McpTool } from './server.js';

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
