#!/usr/bin/env node
import { resolveModels } from './agent/models.js';
import { createOpenRouterProvider } from './agent/provider.js';
import { runStatus, runStop } from './cli/control.js';
import { runHelp, runVersion } from './cli/help.js';
import { runInit } from './cli/init.js';
import { loadConfig } from './config/load.js';
import { NAME, VERSION } from './index.js';
import { startStdioServer } from './mcp/server.js';
import { outerTools } from './mcp/tools/index.js';
import { DebugService } from './services/debug-service.js';
import { makeSessionBuilder } from './services/session-builder.js';
import { SessionManager } from './session/manager.js';
import type { Session } from './session/session.js';
import { FileStatePort } from './session/state-file.js';
import { ensureWorkspace, workspacePaths } from './session/workspace.js';

async function main(): Promise<void> {
  // Dispatch help/version and CLI subcommands before loading project config (none need API key).
  const [, , subcmd] = process.argv;

  // Help and version exit immediately.
  if (subcmd === '--help' || subcmd === '-h') {
    runHelp();
    return;
  }
  if (subcmd === '--version' || subcmd === '-v') {
    runVersion();
    return;
  }

  // Subcommands: init, status, stop.
  if (subcmd === 'init' || subcmd === 'status' || subcmd === 'stop') {
    try {
      if (subcmd === 'init') runInit();
      else if (subcmd === 'status') await runStatus();
      else await runStop();
    } catch (err) {
      console.error(`${NAME}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    return;
  }

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
      models: {
        driver: roleModels.driver,
        vision: roleModels.vision,
        summary: roleModels.summary,
      },
      workspace,
    });
    const service = new DebugService({
      manager,
      config,
      cwd,
      build: builder,
      state: new FileStatePort(workspace),
    });

    // Graceful stop: a CLI `stop` (or any SIGTERM/SIGINT) tears the run down —
    // abort the loop, close the browser, free the profile — then exits cleanly.
    const shutdown = (signal: NodeJS.Signals) => {
      service
        .endActive()
        .catch(() => undefined)
        .finally(() => process.exit(signal === 'SIGINT' ? 130 : 0));
    };
    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));

    // Boot stdio MCP server with outer tools
    const tools = outerTools(service);
    await startStdioServer(tools);
  } catch (err) {
    console.error(`${NAME} v${VERSION}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
