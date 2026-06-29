import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { McpServerError } from '../errors.js';
import { NAME, VERSION } from '../index.js';

/**
 * A self-registering outer MCP tool.
 *
 * Boot (this file) owns the server lifecycle + transport; each tool owns its own
 * config and handler and attaches itself via {@link register}. The registrar
 * stays tool-blind: the five outer tools (`start_debug`, `send_message`,
 * `get_findings`, `describe`, `end_session`) are injected, never hardcoded here.
 */
export interface McpTool {
  /** Tool name exposed to MCP clients (e.g. `start_debug`). */
  readonly name: string;
  /** Attach this tool's config + handler to the given server. */
  readonly register: (server: McpServer) => void;
}

/**
 * Build an {@link McpServer} and register every provided tool.
 * Fails fast on a duplicate tool name so collisions surface loud.
 */
export function createMcpServer(tools: readonly McpTool[]): McpServer {
  const server = new McpServer({ name: NAME, version: VERSION });
  const registered = new Set<string>();
  for (const tool of tools) {
    if (registered.has(tool.name)) {
      throw new McpServerError(`duplicate MCP tool registration: '${tool.name}'`);
    }
    registered.add(tool.name);
    tool.register(server);
  }
  return server;
}

/**
 * Boot the stdio MCP server: register the tools, connect the stdio transport,
 * and return the live server. Callers wire dependencies into the tools.
 */
export async function startStdioServer(tools: readonly McpTool[]): Promise<McpServer> {
  const server = createMcpServer(tools);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
