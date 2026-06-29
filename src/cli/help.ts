/**
 * `ui-debugger-mcp --help` / `--version` — usage and version info.
 *
 * No project config needed. Print and exit(0).
 */

import { NAME, VERSION } from '../index.js';

const USAGE = `${NAME} — autonomous UI debugger (MCP server)

USAGE:
  ${NAME} [subcommand] [options]

SUBCOMMANDS:
  init                  Scaffold a new project (.ui-debugger-mcp.json, workspace)
  status                Print the active debug run's state + findings summary
  stop                  Signal the server to tear down the active run gracefully
  (no subcommand)       Boot the stdio MCP server (default, for Claude use)

OPTIONS:
  --help, -h            Show this message and exit
  --version, -v         Show version and exit

EXAMPLES:
  ui-debugger-mcp init                   Set up a new project
  ui-debugger-mcp status                 Check the current run
  ui-debugger-mcp stop                   Stop the active run
  ui-debugger-mcp                        Boot the server (via .mcp.json)

DOCS:
  https://github.com/developerz-ai/ui-debugger-mcp
`;

/** Print usage and exit. */
export function runHelp(): void {
  console.log(USAGE);
  process.exit(0);
}

/** Print version and exit. */
export function runVersion(): void {
  console.log(`${NAME} v${VERSION}`);
  process.exit(0);
}
