/**
 * End-to-end: full find→report loop.
 *
 * A `Bun.serve` fixture with planted bugs (console error + 500 fetch + overlapping
 * elements) is served; a real MCP server (in-memory transport) drives a scripted
 * mock agent through the complete stack — browser adapter (CDP), session manager,
 * findings store — without touching a real LLM.
 *
 * Requires a Chromium binary. Set SKIP_BROWSER_TESTS=1 or run without Chrome to
 * skip. Detection order: CHROMIUM_PATH env → playwright-managed → system binaries.
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
// Skip guard — same detection order as browser-adapter.integration.test.ts
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  if (process.env['SKIP_BROWSER_TESTS']) return null;
  const envPath = process.env['CHROMIUM_PATH'];
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
// Fixture HTML — planted bugs:
//   1. console.error on load  → functional bug (kind: 'console')
//   2. fetch /api/broken → 500  → functional bug (kind: 'network')
//   3. #banner overlaps #content via position:absolute → visual bug (overlap)
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>E2E Bug Fixture</title>
  <style>
    #banner {
      position: absolute; top: 50px; left: 0;
      width: 300px; height: 100px; background: #e55; z-index: 2;
    }
    #content {
      position: absolute; top: 80px; left: 50px;
      width: 200px; height: 80px; background: #55e; z-index: 1;
    }
  </style>
</head>
<body>
  <h1>E2E Bug Fixture</h1>
  <div id="banner">Banner (overlaps content below)</div>
  <div id="content">Content (overlapped by banner)</div>
  <script>
    /* planted bug 1: console error */
    console.error('e2e-fixture-console-error');
    /* planted bug 2: network 500 */
    fetch('/api/broken').catch(function() {});
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Mock model helper — exact response shape from loop.test.ts / ai/test
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
// MCP call helpers (same pattern as server.test.ts)
// ---------------------------------------------------------------------------

const callResult = (r: unknown): CallToolResult => r as CallToolResult;
const resultText = (r: CallToolResult): string => (r.content[0] as { text: string }).text;

// ---------------------------------------------------------------------------
// E2E suite — only runs when a Chromium binary is available
// ---------------------------------------------------------------------------

(CHROME ? describe : describe.skip)('e2e: start_debug → get_findings loop', () => {
  let fixtureServer: ReturnType<typeof Bun.serve>;
  let fixturePort: number;
  let tmpDir: string;
  let cwd: string;
  let client: Client;
  let serverTransport: InMemoryTransport;
  let clientTransport: InMemoryTransport;
  let manager: SessionManager<Session>;

  // One fixture server shared across all tests in the describe.
  beforeAll(() => {
    fixtureServer = Bun.serve({
      port: 0, // auto-assign a free port
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === '/api/broken') {
          return new Response('Internal Server Error', { status: 500 });
        }
        return new Response(FIXTURE_HTML, {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    });
    const assignedPort = fixtureServer.port;
    if (assignedPort === undefined) throw new Error('fixture server did not bind a port');
    fixturePort = assignedPort;
  });

  afterAll(() => {
    fixtureServer.stop(true);
  });

  // Fresh workspace + MCP server + manager per test.
  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ui-dbg-e2e-'));
    cwd = tmpDir;

    // Scripted mock driver: observe console once, then report the planted bugs.
    let callCount = 0;
    const mockDriver = new MockLanguageModelV3({
      doGenerate: async () => {
        callCount++;
        if (callCount === 1) {
          return toolCallResponse('c1', 'observe', { kind: 'console' });
        }
        // Terminal step: report the known planted bugs.
        return toolCallResponse('c2', 'report', {
          status: 'failed',
          bugs: [
            { kind: 'console', detail: 'e2e-fixture-console-error' },
            { kind: 'network', detail: '500 on /api/broken' },
          ],
          visual: [{ issue: 'overlap', where: '#banner overlaps #content', severity: 'high' }],
          summary: 'Console error on load; 500 from /api/broken; #banner overlaps #content.',
        });
      },
    });

    const mockVision = new MockLanguageModelV3();

    // Resolve Chrome path (always a string inside this describe block at runtime).
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
      provider: { apiKey: 'sk-e2e-test', baseUrl: 'https://openrouter.ai/api/v1' },
    };

    const workspace = workspacePaths(cwd, workspaceBase);
    await ensureWorkspace(workspace);

    const builder = makeSessionBuilder({
      config,
      models: { driver: mockDriver, vision: mockVision },
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

    client = new Client({ name: 'e2e-test', version: '0.0.1' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    if (manager.has(cwd)) await manager.end(cwd).catch(() => undefined);
    await client.close().catch(() => undefined);
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test('get_findings returns terminal status with ≥1 functional bug after start_debug', async () => {
    // Start a debug run targeting the fixture page.
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'find all bugs in the fixture page' },
      }),
    );
    expect(startRes.isError).toBeFalsy();
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };
    expect(session_id).toBeTruthy();

    // Long-poll: wait up to 15 s for the mock agent to call report().
    const findRes = callResult(
      await client.callTool({
        name: 'get_findings',
        arguments: { session_id, wait: 15_000 },
      }),
    );
    expect(findRes.isError).toBeFalsy();
    const findings = JSON.parse(resultText(findRes));

    // Must be a terminal verdict.
    expect(findings.status).toMatch(/^(passed|failed)$/);
    // Must be Zod-valid.
    expect(() => FindingsSchema.parse(findings)).not.toThrow();
    // The scripted mock reports 2 bugs.
    expect(findings.bugs.length).toBeGreaterThan(0);
  }, 30_000);

  test('findings.json written to disk with valid structure and bug entry', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'detect bugs in fixture' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    // Wait for terminal.
    await client.callTool({
      name: 'get_findings',
      arguments: { session_id, wait: 15_000 },
    });

    // Resolve the session directory from the workspace paths + session_id.
    const workspace = workspacePaths(cwd, join(tmpDir, 'workspace'));
    const findingsPath = join(workspace.sessions, session_id, 'findings.json');

    expect(existsSync(findingsPath)).toBe(true);
    const raw = await readFile(findingsPath, 'utf8');
    const parsed = JSON.parse(raw);
    expect(() => FindingsSchema.parse(parsed)).not.toThrow();
    expect(parsed.status).toMatch(/^(passed|failed)$/);
    expect(parsed.bugs.length).toBeGreaterThan(0);
    expect(parsed.bugs[0].kind).toMatch(/^(console|network|flow)$/);
  }, 30_000);

  test('console.log written to disk when CDP captures console.error from fixture page', async () => {
    const startRes = callResult(
      await client.callTool({
        name: 'start_debug',
        arguments: { target: 'web', goal: 'check for console errors' },
      }),
    );
    const { session_id } = JSON.parse(resultText(startRes)) as { session_id: string };

    // Wait for the agent loop to finish (guarantees all async log writes have flushed).
    await client.callTool({
      name: 'get_findings',
      arguments: { session_id, wait: 15_000 },
    });

    const workspace = workspacePaths(cwd, join(tmpDir, 'workspace'));
    const logsDir = join(workspace.sessions, session_id, 'logs');
    const consolePath = join(logsDir, 'console.log');

    // The CDP capture fires on page load → appendLog writes the file.
    expect(existsSync(consolePath)).toBe(true);
    const content = await readFile(consolePath, 'utf8');
    expect(content).toContain('e2e-fixture-console-error');
  }, 30_000);
});
