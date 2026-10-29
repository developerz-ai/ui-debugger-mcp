#!/usr/bin/env node
import { bootServer } from './boot.js';
import { runStatus, runStop } from './cli/control.js';
import { printUsage, runHelp, runVersion } from './cli/help.js';
import { runInit } from './cli/init.js';
import { NAME, VERSION } from './index.js';

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
    // The boot owns the server: the owner-lock backend gate, then the config,
    // the workspace, the provider/models and the stdio MCP server.
    await bootServer(process.cwd());
  } catch (err) {
    console.error(`${NAME} v${VERSION}: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
