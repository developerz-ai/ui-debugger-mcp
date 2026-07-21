/**
 * `ui-debugger-mcp init` — scaffold a project for use with this server.
 *
 * Idempotent: never clobbers existing files. Runs in `process.cwd()`.
 *
 * Steps:
 *  1. mkdir the workspace dir (an existing config's `workspace` wins over the
 *     `./tmp/ui-debugger-mcp` default — see {@link existingWorkspace})
 *  2. write .ui-debugger-mcp.json (only if absent)
 *  3. add the workspace dir to .gitignore (only if the line is missing)
 *  4. print .mcp.json snippet (never writes the API key)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { CONFIG_FILENAME, DEFAULT_MODELS, DEFAULT_WORKSPACE } from '../config/load.js';
import { InitError } from '../errors.js';

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

/** Default ignore line — matches the `workspace` default (`./tmp/ui-debugger-mcp`). */
const DEFAULT_IGNORE_LINE = 'tmp/';

/**
 * Read the `workspace` field of an already-present `.ui-debugger-mcp.json`, if any.
 * Deliberately lenient — not a full `ConfigSchema` parse — because `init` only needs
 * to know where to mkdir/gitignore, not validate the whole file; a config with an
 * unrelated schema error must not block re-running `init`. Falls back to
 * {@link DEFAULT_WORKSPACE} when the file is absent, unparseable, or has no string
 * `workspace` field.
 */
function existingWorkspace(cwd: string): string {
  const configPath = join(cwd, CONFIG_FILENAME);
  if (!existsSync(configPath)) return DEFAULT_WORKSPACE;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new InitError(
      `Failed to read ${CONFIG_FILENAME}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }

  try {
    const data: unknown = JSON.parse(raw);
    const workspace = (data as { workspace?: unknown } | null)?.workspace;
    if (typeof workspace === 'string' && workspace.length > 0) return workspace;
  } catch {
    // not JSON, or no usable `workspace` field — fall back to the default; full
    // validation happens at server boot (`loadConfig`), not here.
  }
  return DEFAULT_WORKSPACE;
}

/**
 * The `.gitignore` line for `workspaceDir`. The default workspace keeps the
 * historical broad `tmp/` line; a custom workspace gets its own relative,
 * trailing-slash line so it's actually ignored instead of missed. `null` when the
 * workspace resolves outside `cwd` — nothing to add, the caller must handle it.
 */
function gitignoreLineFor(
  cwd: string,
  workspaceDir: string,
  workspaceValue: string,
): string | null {
  if (workspaceValue === DEFAULT_WORKSPACE) return DEFAULT_IGNORE_LINE;
  const rel = relative(cwd, workspaceDir);
  if (rel.startsWith('..')) return null;
  return `${rel.split(sep).join('/')}/`;
}

/**
 * Run the init scaffold in `cwd`.
 * Throws `InitError` on filesystem failures.
 */
export function runInit(cwd: string = process.cwd()): void {
  // 1. mkdir workspace — respects an already-present config's `workspace` field.
  const workspaceValue = existingWorkspace(cwd);
  const workspaceDir = resolve(cwd, workspaceValue);
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

  // 3. add the workspace dir to .gitignore (only if the line is missing)
  const gitignorePath = join(cwd, '.gitignore');
  const ignoreLine = gitignoreLineFor(cwd, workspaceDir, workspaceValue);
  if (ignoreLine) {
    ensureGitignoreLine(gitignorePath, ignoreLine);
  } else {
    console.log(
      `  (skip)     workspace is outside the project root — add it to .gitignore manually`,
    );
  }

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
