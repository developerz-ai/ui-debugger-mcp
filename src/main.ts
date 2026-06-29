#!/usr/bin/env node
import { resolveModels } from './agent/models.js';
import { createOpenRouterProvider } from './agent/provider.js';
import { loadConfig } from './config/load.js';
import { NAME, VERSION } from './index.js';
import { startStdioServer } from './mcp/server.js';
import { outerTools } from './mcp/tools/index.js';
import { DebugService } from './services/debug-service.js';
import { makeSessionBuilder } from './services/session-builder.js';
import { SessionManager } from './session/manager.js';
import type { Session } from './session/session.js';
import { ensureWorkspace, workspacePaths } from './session/workspace.js';

async function main(): Promise<void> {
  try {
    // Load project config (cwd-keyed)
    const config = loadConfig();
    const cwd = process.cwd();

    // Bootstrap workspace directories (chrome-user-data/, sessions/)
    const workspace = workspacePaths(cwd, config.workspace);
    await ensureWorkspace(workspace);

    // Resolve provider + per-role models (driver, vision, summary)
    const provider = createOpenRouterProvider({
      apiKey: config.provider.apiKey,
      baseURL: config.provider.baseUrl,
    });
    const roleModels = resolveModels(provider, config.models);

    // Wire the debug session service
    const manager = new SessionManager<Session>();
    const builder = makeSessionBuilder({
      config,
      models: { driver: roleModels.driver, vision: roleModels.vision },
      workspace,
    });
    const service = new DebugService({
      manager,
      config,
      cwd,
      build: builder,
    });

    // Boot stdio MCP server with outer tools
    const tools = outerTools(service);
    await startStdioServer(tools);
  } catch (err) {
    console.error(`${NAME} v${VERSION}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
