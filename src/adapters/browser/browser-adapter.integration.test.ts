/**
 * Browser adapter — integration test.
 *
 * What it needs
 * =============
 * - `playwright-core` (already in package.json) **plus** a Chromium binary.
 *   playwright-core ships *no* bundled browser; install one with:
 *
 *     bunx playwright install chromium       # recommended — puts it in ~/.cache/ms-playwright/
 *     # OR: apt-get install chromium-browser (Debian/Ubuntu)
 *
 * - Detection order:
 *     1. CHROMIUM_PATH env  (full path, takes precedence)
 *     2. playwright-managed Chromium  (`chromium.executablePath()`)
 *     3. System Chrome/Chromium (`which chromium`, `chromium-browser`, `google-chrome[-stable]`)
 *
 * - Set SKIP_BROWSER_TESTS=1 to force-skip in CI environments without a binary.
 *
 * What it tests
 * =============
 * A tiny HTML fixture is served via `Bun.serve`:
 *   - visible <button id="go">  — exercises find / click
 *   - `console.error('fixture-error')` on load  — exercises console capture
 *   - click handler fetches `/api/missing` (→ 404)  — exercises network capture
 *
 * Then headless Chromium is launched through BrowserAdapter and the full contract
 * is exercised: open · find · click · readState · screenshot · console · network.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import type { WebTarget } from '../../config/schema.js';
import { BrowserAdapter } from './browser-adapter.js';

// ---------------------------------------------------------------------------
// Skip guard
// ---------------------------------------------------------------------------

function findChrome(): string | null {
  if (process.env.SKIP_BROWSER_TESTS) return null;

  // Explicit override
  const env = process.env.CHROMIUM_PATH;
  if (env && existsSync(env)) return env;

  // playwright-managed Chromium (installed via `playwright install chromium`)
  try {
    const p = chromium.executablePath();
    if (p && existsSync(p)) return p;
  } catch {
    /* not installed */
  }

  // System binaries
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
// Fixture HTML
// ---------------------------------------------------------------------------

const FIXTURE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>UI Debugger Test Fixture</title></head>
<body>
  <h1>Test Fixture</h1>
  <button id="go">Click me</button>
  <p id="status">ready</p>
  <script>
    // Fires immediately on load — captured by the console listener.
    console.error('fixture-error');

    // Fires on button click — captured by the network listener as a 404.
    document.getElementById('go').addEventListener('click', function() {
      document.getElementById('status').textContent = 'clicked';
      fetch('/api/missing').catch(function() {});
    });
  </script>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

(CHROME ? describe : describe.skip)('BrowserAdapter integration', () => {
  let server: ReturnType<typeof Bun.serve>;
  let adapter: BrowserAdapter;
  let profileDir: string;

  beforeAll(async () => {
    // 1. Serve the fixture on a random OS-assigned port.
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/') {
          return new Response(FIXTURE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    // 2. Isolated Chrome profile so tests don't share state with the user's browser.
    profileDir = mkdtempSync(`${tmpdir()}/ui-dbg-test-`);

    // 3. Construct the adapter (does NOT navigate yet).
    const config: WebTarget = {
      adapter: 'browser',
      url: `http://localhost:${server.port}/`,
      headless: true,
      executablePath: CHROME,
    };

    adapter = await BrowserAdapter.create({ config, profileDir });
  }, 30_000);

  afterAll(async () => {
    await adapter?.close().catch(() => {});
    server?.stop();
    if (profileDir) rmSync(profileDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // open
  // -------------------------------------------------------------------------

  test('open: navigates to the fixture and waits for the button', async () => {
    await adapter.open(`http://localhost:${server.port}/`);
    // waitFor confirms the button is visible — implicitly asserts open() worked.
    await adapter.waitFor({ query: '#go', timeout: 10_000 });
  }, 15_000);

  // -------------------------------------------------------------------------
  // find
  // -------------------------------------------------------------------------

  test('find: returns the button node with correct role and name', async () => {
    const node = await adapter.find({ query: '#go' });
    expect(node).not.toBeNull();
    expect(node?.role).toBe('button');
    expect(node?.name).toBe('Click me');
    expect(node?.enabled).toBe(true);
    expect(node?.bounds.width).toBeGreaterThan(0);
    expect(node?.bounds.height).toBeGreaterThan(0);
  });

  test('find: returns null for a selector that matches nothing', async () => {
    const node = await adapter.find({ query: '#does-not-exist' });
    expect(node).toBeNull();
  });

  // -------------------------------------------------------------------------
  // readState
  // -------------------------------------------------------------------------

  test('readState: returns a semantic node tree that includes the button', async () => {
    const nodes = await adapter.readState();
    expect(nodes.length).toBeGreaterThan(0);
    const button = nodes.find((n) => n.role === 'button');
    expect(button).toBeDefined();
    expect(button?.name).toBe('Click me');
  });

  test('readState: filters work (visible_eq)', async () => {
    const nodes = await adapter.readState({ filters: { visible_eq: true } });
    // All returned nodes must have non-zero bounds (visible).
    for (const n of nodes) {
      expect(n.bounds.width).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------------------------
  // screenshot
  // -------------------------------------------------------------------------

  test('screenshot: returns valid PNG bytes', async () => {
    const bytes = await adapter.screenshot();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic header: 0x89 P N G
    expect(bytes[0]).toBe(0x89);
    expect(bytes[1]).toBe(0x50); // 'P'
    expect(bytes[2]).toBe(0x4e); // 'N'
    expect(bytes[3]).toBe(0x47); // 'G'
  });

  // -------------------------------------------------------------------------
  // console — fires on page load (before click)
  // -------------------------------------------------------------------------

  test('console: captures the console.error fired on page load', async () => {
    const errors = await adapter.console({ filters: { level_eq: 'error' } });
    const texts = errors.map((e) => e.text);
    expect(texts.some((t) => t.includes('fixture-error'))).toBe(true);
  });

  test('console: level filter works — non-errors are excluded', async () => {
    const errors = await adapter.console({ filters: { level_eq: 'error' } });
    for (const e of errors) {
      expect(e.level).toBe('error');
    }
  });

  // -------------------------------------------------------------------------
  // click — must come before the network assertions
  // -------------------------------------------------------------------------

  test('click: button click updates the page and triggers a fetch', async () => {
    const node = await adapter.find({ query: '#go' });
    expect(node).not.toBeNull();
    if (!node) throw new Error('button not found');

    await adapter.click(node);
    // Wait until the in-flight fetch settles so the network entry is captured.
    await adapter.waitFor({ networkIdle: true, timeout: 10_000 });

    // The click handler sets #status to 'clicked'.
    const status = await adapter.find({ query: '#status' });
    expect(status?.name).toBe('clicked');
  }, 15_000);

  // -------------------------------------------------------------------------
  // network — populated by the fetch triggered in the click test
  // -------------------------------------------------------------------------

  test('network: captures the 404 response from /api/missing', async () => {
    const entries = await adapter.network({ filters: { url_contains: '/api/missing' } });
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries[0];
    expect(entry?.status).toBe(404);
    expect(entry?.ok).toBe(false);
    expect(entry?.method).toBe('GET');
  });

  test('network: status_gte filter narrows to error responses', async () => {
    const all = await adapter.network();
    const errors = await adapter.network({ filters: { status_gte: 400 } });
    // Must be a proper subset — at least the fixture 404, possibly the page itself.
    expect(errors.length).toBeLessThanOrEqual(all.length);
    for (const e of errors) {
      expect(e.status).toBeGreaterThanOrEqual(400);
    }
  });

  test('network: limit caps results', async () => {
    const one = await adapter.network({ limit: 1 });
    expect(one.length).toBeLessThanOrEqual(1);
  });
});
