#!/usr/bin/env node
import { isAbsolute, join } from 'node:path';
import { supportsImageInput } from './agent/capabilities.js';
import { resolveModels } from './agent/models.js';
import { createOpenRouterProvider, resolveProviderConfig } from './agent/provider.js';
import { runStatus, runStop } from './cli/control.js';
import { printUsage, runHelp, runVersion } from './cli/help.js';
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

  // Unknown subcommand → print usage and exit 1 (runHelp() would exit 0 first).
  if (subcmd !== undefined) {
    console.error(`${NAME}: unknown subcommand '${subcmd}'.`);
    printUsage();
    process.exit(1);
  }

  try {
    // Load project config (cwd-keyed)
    const config = loadConfig();
    const cwd = process.cwd();

    // Bootstrap workspace directories (chrome-user-data/, sessions/)
    // Anchor relative workspace paths to the project root.
    const workspaceBase = isAbsolute(config.workspace)
      ? config.workspace
      : join(cwd, config.workspace);
    const workspace = workspacePaths(cwd, workspaceBase);
    await ensureWorkspace(workspace);

    // Resolve provider + per-role models (driver, vision, summary)
    const providerOptions = {
      apiKey: config.provider.apiKey,
      baseURL: config.provider.baseUrl,
    };
    const provider = createOpenRouterProvider(providerOptions);
    const roleModels = resolveModels(provider, config.models);

    // Self-look: control + vision on the SAME model AND the provider catalog
    // confirms it takes image input → `look` hands the frame to the driver
    // itself (full context, no second call). Unknown capability (null) keeps
    // the safe separate-call path — its vision latch fails soft, while an
    // image pushed at a text-only driver would poison every later step.
    let selfLook = false;
    if (config.models.driver === config.models.vision) {
      const { apiKey, baseURL } = resolveProviderConfig(providerOptions);
      selfLook = (await supportsImageInput(baseURL, apiKey, config.models.driver)) === true;
    }

    // Wire the debug session service
    const manager = new SessionManager<Session>();
    const builder = makeSessionBuilder({
      config,
      models: {
        driver: roleModels.driver,
        vision: roleModels.vision,
        summary: roleModels.summary,
        selfLook,
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
    const shutdown = (exitCode: number) => {
      service
        .endActive()
        .catch(() => undefined)
        .finally(() => process.exit(exitCode));
    };
    process.once('SIGTERM', () => shutdown(0));
    process.once('SIGINT', () => shutdown(130));

    // Boot stdio MCP server with outer tools. A dead client is a shutdown too:
    // nothing can read findings or `end_session` any more, so the run must not
    // keep a browser (and the profile lock) alive until its cap. Same idempotent
    // teardown path as the signals above.
    const tools = outerTools(service);
    await startStdioServer(tools, { onClose: () => shutdown(0) });
  } catch (err) {
    console.error(`${NAME} v${VERSION}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
