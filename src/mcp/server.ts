import type { Readable, Writable } from 'node:stream';
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

/** Wiring for {@link startStdioServer}. */
export interface StdioServerInit {
  /**
   * Called exactly once when the client connection drops for any reason — the
   * client process dying (stdin EOF) or an explicit close. The caller's hook to
   * tear a live run down: with nobody left to read findings or send
   * `end_session`, a browser must not outlive the client.
   */
  readonly onClose?: () => void;
  /** Stream the transport reads. Defaults to this process's stdin; a test seam. */
  readonly stdin?: Readable;
  /** Stream the transport writes. Defaults to this process's stdout; a test seam. */
  readonly stdout?: Writable;
}

/**
 * Boot the stdio MCP server: register the tools, connect the stdio transport,
 * and return the live server. Callers wire dependencies into the tools.
 */
export async function startStdioServer(
  tools: readonly McpTool[],
  { onClose, stdin = process.stdin, stdout = process.stdout }: StdioServerInit = {},
): Promise<McpServer> {
  const server = createMcpServer(tools);
  const transport = new StdioServerTransport(stdin, stdout);

  // Both drop paths below can reach this, so it fires at most once.
  let notified = false;
  const dropped = (): void => {
    if (notified) return;
    notified = true;
    onClose?.();
  };
  server.server.onclose = dropped;

  // The SDK's stdio transport listens for `data`/`error` on stdin and nothing
  // else — EOF (the client died) never reaches `onclose` on its own. Watch it
  // here and close the server, so client death and an explicit close land on the
  // same hook. Wired before `connect` starts the flow: no EOF can slip past.
  const clientGone = (): void => {
    void server
      .close()
      .catch(() => undefined)
      .finally(dropped);
  };
  stdin.once('end', clientGone);
  stdin.once('close', clientGone);

  await server.connect(transport);
  return server;
}
