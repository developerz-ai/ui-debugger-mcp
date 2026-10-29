/**
 * `ui-debugger-mcp init` — scaffold a project for use with this server.
 *
 * Idempotent: never clobbers existing files. Runs in `process.cwd()`.
 *
 * Steps:
 *  1. mkdir the workspace dir (an existing config's `workspace` wins over the
 *     `./tmp/ui-debugger-mcp` default — see {@link existingWorkspace})
 *  2. write the project config (only if absent) at the location
 *     {@link resolveConfigPath} picks: `.dz/ui-debugger/ui-debugger-mcp.json`
 *     when the repo has a `.dz/` dir, else the root `.ui-debugger-mcp.json`.
 *     The starter is validated against `ConfigSchema` FIRST — the file `init`
 *     writes must satisfy the same schema the server parses it with
 *  3. add the workspace dir to .gitignore (only if the line is missing)
 *  4. print .mcp.json snippet (never writes the API key)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
  DEFAULT_MODELS,
  DEFAULT_WORKSPACE,
  ignoredRootConfig,
  resolveConfigPath,
} from '../config/load.js';
import { type Config, ConfigSchema } from '../config/schema.js';
import { InitError } from '../errors.js';

/**
 * Starter project config written on `init` (only if absent).
 *
 * Bound to the parser's contract, twice over:
 *  - `satisfies Config` — the schema's own type, so `bun run typecheck` fails
 *    the moment the starter drifts from `ConfigSchema`'s shape
 *  - {@link validateStarterConfig} — the same schema at runtime, on the write
 *    path, because a schema is a runtime contract too and `init` is the one
 *    place that HANDS OUT a config file
 */
export const STARTER_CONFIG = {
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
} satisfies Config;

/**
 * Validate a starter config candidate against the parser's contract.
 *
 * `init` writes the starter to disk, so the file must satisfy the SAME schema
 * the server parses it with — otherwise `init` scaffolds a config the server
 * rejects at boot. Throws `InitError` naming every schema issue (never a raw
 * `ZodError`); returns the parsed config on success.
 */
export function validateStarterConfig(candidate: unknown): Config {
  const result = ConfigSchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new InitError(`Starter config is invalid — ${issues}`);
  }
  return result.data;
}

/**
 * `.mcp.json` snippet printed to stdout (API key placeholder — never written).
 *
 * The spec is pinned to `@latest`, not left bare. `npx -y <pkg>` REUSES a cached
 * install when one exists, so an unpinned entry keeps launching whatever version
 * first landed in `~/.npm/_npx` — observed in the wild: a client still booting
 * 1.4.0 days after 1.5.0 shipped, with no signal that anything was stale.
 * `@latest` forces the registry check on every cold start.
 */
const MCP_JSON_SNIPPET = `{
  "mcpServers": {
    "ui-debugger": {
      "command": "npx",
      "args": ["-y", "@developerz.ai/ui-debugger-mcp@latest"],
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
 * Read the `workspace` field of an already-present project config (`.dz/` copy
 * first, root fallback — the loader's candidate order), if any. Deliberately
 * lenient — not a full `ConfigSchema` parse — because `init` only needs to know
 * where to mkdir/gitignore, not validate the whole file; a config with an
 * unrelated schema error must not block re-running `init`. Falls back to
 * {@link DEFAULT_WORKSPACE} when the file is absent, unparseable, or has no
 * string `workspace` field.
 */
function existingWorkspace(cwd: string): string {
  const configPath = resolveConfigPath(cwd);
  if (!existsSync(configPath)) return DEFAULT_WORKSPACE;

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new InitError(
      `Failed to read ${relative(cwd, configPath)}: ${e instanceof Error ? e.message : String(e)}`,
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
 * trailing-slash line so it's actually ignored instead of missed. The path is
 * written as an escaped LITERAL per gitignore(5): backslash, `!`, `#`, `*`,
 * `?`, `[` and space are backslash-prefixed (`/` and `]` need no escape), so a
 * workspace named `#ws` or `my ws` matches itself instead of parsing as a
 * comment, negation or glob. gitignore(5) rules are line-based, so a workspace
 * path carrying a newline or CR cannot be expressed at all — `InitError`, never
 * a silently corrupt pair of rules. `null` when the workspace resolves outside
 * `cwd` — nothing to add, the caller must handle it.
 */
function gitignoreLineFor(
  cwd: string,
  workspaceDir: string,
  workspaceValue: string,
): string | null {
  if (workspaceValue === DEFAULT_WORKSPACE) return DEFAULT_IGNORE_LINE;
  const rel = relative(cwd, workspaceDir);
  if (rel.startsWith('..')) return null;
  const line = `${rel
    .split(sep)
    .join('/')
    .replace(/[\\!#*?[ ]/g, '\\$&')}/`;
  if (line.includes('\n') || line.includes('\r')) {
    throw new InitError(
      `workspace ${JSON.stringify(workspaceValue)} contains a line break — .gitignore rules are line-based and cannot ignore it; use a single-line workspace path`,
    );
  }
  return line;
}

/** Options for {@link runInit}. */
export interface InitOptions {
  /**
   * The starter config to write when the project has none yet. Defaults to
   * {@link STARTER_CONFIG}. Whatever is passed is validated against
   * `ConfigSchema` BEFORE anything is written — an invalid starter throws
   * `InitError` and leaves the project untouched (no config file, no
   * `.gitignore` line, no workspace dir).
   */
  starter?: unknown;
}

/**
 * Run the init scaffold in `cwd`.
 * Throws `InitError` on filesystem failures or an invalid starter config.
 */
export function runInit(cwd: string = process.cwd(), opts: InitOptions = {}): void {
  // 0. validate the starter — before ANY filesystem effect. A starter that
  // violates the schema must not leave a half-scaffolded project behind.
  // Only `undefined` means "no starter given" — every other candidate
  // (`null` included) is validated, never silently replaced by the default.
  const starter = opts.starter === undefined ? STARTER_CONFIG : opts.starter;
  validateStarterConfig(starter);

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

  // 2. write the project config (only if absent) — resolveConfigPath owns the
  // location: an existing `.dz/` or root copy is found, else `.dz/` when the repo
  // already has a `.dz/` dir, else the root file.
  const configPath = resolveConfigPath(cwd);
  const configName = relative(cwd, configPath);
  if (existsSync(configPath)) {
    console.log(`  (skip)     ${configName} already exists`);
    const ignoredRoot = ignoredRootConfig(cwd);
    if (ignoredRoot) {
      console.log(`  (notice)   ${ignoredRoot} also exists — ignored, ${configName} wins`);
    }
  } else {
    try {
      // The `.dz/` candidate needs its parent dir; for the root candidate this
      // is a no-op on the (existing) project root.
      mkdirSync(dirname(configPath), { recursive: true });
      // The validated starter, serialized as-is: the parse is a gate, not a
      // transform — the bytes on disk stay exactly the documented ones.
      writeFileSync(configPath, `${JSON.stringify(starter, null, 2)}\n`, 'utf8');
    } catch (e) {
      throw new InitError(
        `Failed to write ${configName}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    console.log(`✓ created    ${configName}`);
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
