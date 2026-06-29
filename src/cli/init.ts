/**
 * `ui-debugger-mcp init` — scaffold a project for use with this server.
 *
 * Idempotent: never clobbers existing files. Runs in `process.cwd()`.
 *
 * Steps:
 *  1. mkdir ./tmp/ui-debugger-mcp/
 *  2. write .ui-debugger-mcp.json (only if absent)
 *  3. add `tmp/` to .gitignore (only if the line is missing)
 *  4. print .mcp.json snippet (never writes the API key)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODELS, DEFAULT_WORKSPACE } from '../config/load.js';
import { UiDebuggerError } from '../errors.js';

export class InitError extends UiDebuggerError {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
    Object.setPrototypeOf(this, InitError.prototype);
  }
}

/** Starter project config written on `init` (only if absent). */
const STARTER_CONFIG = JSON.stringify(
  {
    models: {
      driver: DEFAULT_MODELS.driver,
      vision: DEFAULT_MODELS.vision,
      summary: DEFAULT_MODELS.summary,
    },
    workspace: DEFAULT_WORKSPACE,
    targets: {
      web: {
        adapter: 'browser',
        url: 'http://localhost:3000',
        headless: true,
      },
    },
  },
  null,
  2,
);

/** `.mcp.json` snippet printed to stdout (API key placeholder — never written). */
const MCP_JSON_SNIPPET = `{
  "mcpServers": {
    "ui-debugger": {
      "command": "npx",
      "args": ["-y", "@developerz.ai/ui-debugger-mcp"],
      "env": {
        "OPENAI_API_KEY": "<your-key-here>",
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1"
      }
    }
  }
}`;

/**
 * Run the init scaffold in `cwd`.
 * Throws `InitError` on filesystem failures.
 */
export function runInit(cwd: string = process.cwd()): void {
  // 1. mkdir workspace
  const workspaceDir = join(cwd, 'tmp', 'ui-debugger-mcp');
  try {
    mkdirSync(workspaceDir, { recursive: true });
  } catch (e) {
    throw new InitError(
      `Failed to create workspace dir: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  console.log(`✓ workspace  ${workspaceDir}`);

  // 2. write .ui-debugger-mcp.json (only if absent)
  const configPath = join(cwd, '.ui-debugger-mcp.json');
  if (existsSync(configPath)) {
    console.log(`  (skip)     .ui-debugger-mcp.json already exists`);
  } else {
    try {
      writeFileSync(configPath, `${STARTER_CONFIG}\n`, 'utf8');
    } catch (e) {
      throw new InitError(
        `Failed to write .ui-debugger-mcp.json: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.log(`✓ created    .ui-debugger-mcp.json`);
  }

  // 3. add `tmp/` to .gitignore (only if line absent)
  const gitignorePath = join(cwd, '.gitignore');
  ensureGitignoreLine(gitignorePath, 'tmp/');

  // 4. print .mcp.json snippet
  console.log(`
Paste into your .mcp.json (do NOT commit your API key):

${MCP_JSON_SNIPPET}
`);
}

/**
 * Ensure `line` appears in `.gitignore`. Creates the file if absent.
 * Appends only; never rewrites existing content.
 */
function ensureGitignoreLine(path: string, line: string): void {
  let existing = '';
  if (existsSync(path)) {
    try {
      existing = readFileSync(path, 'utf8');
    } catch (e) {
      throw new InitError(
        `Failed to read .gitignore: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  const lines = existing.split('\n');
  const already = lines.some((l) => l.trim() === line.trim());

  if (already) {
    console.log(`  (skip)     .gitignore already contains \`${line}\``);
    return;
  }

  const append = `${(existing.endsWith('\n') || existing === '' ? '' : '\n') + line}\n`;
  try {
    writeFileSync(path, existing + append, 'utf8');
  } catch (e) {
    throw new InitError(
      `Failed to update .gitignore: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  console.log(`✓ .gitignore  added \`${line}\``);
}
