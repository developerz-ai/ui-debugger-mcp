/**
 * End-to-end: dummy/web Nimbus Store fixture → agent findings loop.
 *
 * Builds the dummy/web Vite app (once per test run), serves the resulting
 * `dist/` via a Bun.serve static-file handler, then drives a full
 * start_debug → get_findings cycle against it. The LLM is replaced by a
 * scripted `MockLanguageModelV3` that reports the planted bugs documented in
 * `dummy/web/BUGS.md`:
 *
 *   - network 404  (/api/featured, /images/logo.png, /images/product-3.png)
 *   - console error on load  (Failed to load featured products)
 *   - JS ReferenceError on click  (quantityToAdd is not defined)
 *   - invisible text  (hero subtitle: white on near-white)
 *
 * The same Chrome guard as `e2e.test.ts` applies — set SKIP_BROWSER_TESTS=1
 * or run without a Chromium binary to skip the whole suite.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { MockLanguageModelV3 } from 'ai/test';
import { chromium } from 'playwright-core';
import type { ResolvedConfig } from './config/load.js';
import { FindingsSchema } from './findings/schema.js';
import { createMcpServer } from './mcp/server.js';
import { outerTools } from './mcp/tools/index.js';
import { DebugService } from './services/debug-service.js';
import { makeSessionBuilder } from './services/session-builder.js';
import { SessionManager } from './session/manager.js';
import type { Session } from './session/session.js';
import { ensureWorkspace, workspacePaths } from './session/workspace.js';

// ---------------------------------------------------------------------------
// Skip guard — identical detection order to e2e.test.ts
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  if (process.env.SKIP_BROWSER_TESTS) return null;
  const envPath = process.env.CHROMIUM_PATH;
  if (envPath && existsSync(envPath)) return envPath;
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  for (const cmd of ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']) {
    try {
      const p = execSync(`which ${cmd} 2>/dev/null`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (p && existsSync(p)) return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

const CHROME = findChrome();

// ---------------------------------------------------------------------------
// Static-file server for the built dummy/web dist/
// ---------------------------------------------------------------------------

const DUMMY_WEB_DIR = join(import.meta.dir, '..', 'dummy', 'web');
const DIST_DIR = join(DUMMY_WEB_DIR, 'dist');

/** Serve built static files; missing files → real 404 (matches planted bugs). */
function createStaticServer() {
  return Bun.serve({
    port: 0, // auto-assign
    async fetch(req) {
      const url = new URL(req.url);
      const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = Bun.file(join(DIST_DIR, pathname));
      if (await file.exists()) {
        return new Response(file);
      }
      return new Response('Not Found', { status: 404 });
    },
  });
}

// ---------------------------------------------------------------------------
// Mock model helper — same shape as e2e.test.ts
// ---------------------------------------------------------------------------

function toolCallResponse(id: string, toolName: string, args: unknown) {
  return {
    content: [
      { type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(args) },
    ],
    finishReason: { unified: 'tool-calls' as const, raw: 'tool_calls' },
    usage: {
      inputTokens: {
        total: 1,
        noCache: 1 as number | undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: 1, text: 1 as number | undefined, reasoning: undefined },
    },
    warnings: [] as [],
  };
}

// ---------------------------------------------------------------------------
// MCP call helpers
// ---------------------------------------------------------------------------

const callResult = (r: unknown): CallToolResult => r as CallToolResult;
const resultText = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

// ---------------------------------------------------------------------------
// Suite — only runs when a Chromium binary is available
// ---------------------------------------------------------------------------

(CHROME ? describe : describe.skip)('dummy-web e2e: Nimbus Store fixture → findings', () => {
  let fixtureServer: ReturnType<typeof Bun.serve>;
  let fixturePort: number;
  let tmpDir: string;
  let cwd: string;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let manager: SessionManager<Session>;

  // Build once; serve throughout the suite.
  beforeAll(() => {
    if (!CHROME) return; // suite is skipped; skip side-effectful setup too
    // Build the dummy app if dist/ is absent (or always in CI).
    if (!existsSync(join(DIST_DIR, 'index.html'))) {
      execSync('bun run build', {
        cwd: DUMMY_WEB_DIR,
        stdio: 'pipe',
        timeout: 120_000,
      });
    }

    fixtureServer = createStaticServer();
    const port = fixtureServer.port;
    if (port === undefined) throw new Error('fixture server did not bind a port');
    fixturePort = port;
  });

  afterAll(() => {
    fixtureServer?.stop(true);
  });

  // Fresh workspace + MCP server per test.
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ui-dbg-dw-e2e-'));
    cwd = tmpDir;

    // Scripted mock driver: observe console once, then report the planted bugs
    // from dummy/web/BUGS.md (network 404, console error, ReferenceError,
    // invisible text).
    let callCount = 0;
    const mockDriver = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return toolCallResponse('c1', 'observe', { kind: 'console' });
        }
        return toolCallResponse('c2', 'report', {
          status: 'failed',
          bugs: [
            { kind: 'network', detail: '404 on /api/featured' },
            { kind: 'network', detail: '404 on /images/logo.png' },
            { kind: 'network', detail: '404 on /images/product-3.png' },
            {
              kind: 'console',
              detail:
                'Failed to load featured products — SyntaxError: Unexpected end of JSON input',
            },
            { kind: 'flow', detail: 'ReferenceError: quantityToAdd is not defined (product 4)' },
          ],
          visual: [
            {
              issue: 'invisible_text',
              where: 'hero .subtitle — white text (#ffffff) on near-white background (#fdfdfd)',
              severity: 'high',
            },
          ],
          summary:
            'Three 404s on load (/api/featured, two broken images); ' +
            'console.error with JSON SyntaxError; ' +
            'ReferenceError when clicking product 4; ' +
            'hero subtitle invisible (white on near-white).',
        });
      },
    });

    const chromePath = typeof CHROME === 'string' ? CHROME : undefined;
    const workspaceBase = join(tmpDir, 'workspace');

    const config: ResolvedConfig = {
      models: { driver: 'mock/driver', vision: 'mock/vision', summary: 'mock/summary' },
      workspace: workspaceBase,
      targets: {
        web: {
          adapter: 'browser',
          url: `http://localhost:${fixturePort}`,
          headless: true,
          ...(chromePath ? { executablePath: chromePath } : {}),
        },
      },
      provider: { apiKey: 'sk-dw-e2e-test', baseUrl: 'https://openrouter.ai/api/v1' },
    };

    const workspace = workspacePaths(cwd, workspaceBase);
    await ensureWorkspace(workspace);

    const builder = makeSessionBuilder({
      config,
      models: {
        driver: mockDriver,
        vision: new MockLanguageModelV3(),
        summary: new MockLanguageModelV3(),
      },
      workspace,
    });

    manager = new SessionManager<Session>();
    const service = new DebugService({
      manager,
      config,
      cwd,
      build: builder,
      now: () => 1_700_000_000_000,
    });

    const server = createMcpServer(outerTools(service));
    [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);

    client = new Client({ name: 'dw-e2e-test', version: '0.0.1' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    if (manager.has(cwd)) await manager.end(cwd).catch(() => undefined);
    await client.close().catch(() => undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('get_findings returns terminal status with network + console + flow bugs', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'find all bugs in the Nimbus Store fixture' },
      }),
    );
    expect(startRes.isError).toBeFalsy();
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };
    expect(session_id).toBeTruthy();

    const findRes = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id, wait: 20_000 },
      }),
    );
    expect(findRes.isError).toBeFalsy();
    const findings = JSON.parse(resultText(findRes));

    expect(findings.status).toMatch(/^(passed|failed)$/);
    expect(() => FindingsSchema.parse(findings)).not.toThrow();

    // The mock reports 5 bugs (3 network + 1 console + 1 flow).
    expect(findings.bugs.length).toBeGreaterThanOrEqual(3);

    const kinds: string[] = findings.bugs.map((b: { kind: string }) => b.kind);
    expect(kinds).toContain('network');
    expect(kinds).toContain('console');
    expect(kinds).toContain('flow');
  }, 40_000);

  test('findings include the 404 network bugs from missing assets', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'detect 404 network errors in Nimbus Store' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const findRes = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id, wait: 20_000 },
      }),
    );
    const findings = JSON.parse(resultText(findRes));
    const networkBugs: { kind: string; detail: string }[] = findings.bugs.filter(
      (b: { kind: string }) => b.kind === 'network',
    );

    expect(networkBugs.length).toBeGreaterThanOrEqual(1);
    const details = networkBugs.map((b) => b.detail).join(' ');
    expect(details).toMatch(/404/);
  }, 40_000);

  test('findings include invisible-text visual issue', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'find visual issues in Nimbus Store' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    const findRes = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id, wait: 20_000 },
      }),
    );
    const findings = JSON.parse(resultText(findRes));

    expect(findings.visual.length).toBeGreaterThanOrEqual(1);
    const visualIssues: { issue: string; severity: string }[] = findings.visual;
    expect(
      visualIssues.some((v) => v.issue.includes('invisible') || v.issue.includes('text')),
    ).toBe(true);
  }, 40_000);

  test('findings.json written to disk with valid structure after run', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'full audit of Nimbus Store' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    await client.callTool({
      name: 'get_findings',
      arguments: { session_id, wait: 20_000 },
    });

    const workspace = workspacePaths(cwd, join(tmpDir, 'workspace'));
    const findingsPath = join(workspace.sessions, session_id, 'findings.json');

    expect(existsSync(findingsPath)).toBe(true);
    const raw = await readFile(findingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(() => FindingsSchema.parse(parsed)).not.toThrow();
    expect(parsed.status).toMatch(/^(passed|failed)$/);
    expect(parsed.bugs.length).toBeGreaterThan(0);
  }, 40_000);
});
