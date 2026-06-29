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
 *   - keydown + scroll listeners mirror the last chord / scroll offset into the DOM
 *     (`#lastkey`, `#scrolly`, `#boxscroll`)  — exercises pressKey / scroll
 *
 * Then headless Chromium is launched through BrowserAdapter and the full contract
 * is exercised: open · find · click · type · pressKey · scroll · readState ·
 * screenshot · console · network.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright-core';
import type { WebTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
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
  <p id="lastkey">none</p>
  <p id="scrolly">0</p>
  <p id="boxscroll">0</p>
  <div id="box" style="height:100px;overflow:auto;border:1px solid #000">
    <div style="height:1200px">scrollable region</div>
  </div>
  <div style="height:3000px">page spacer</div>
  <script>
    // Fires immediately on load — captured by the console listener.
    console.error('fixture-error');

    // Fires on button click — captured by the network listener as a 404.
    document.getElementById('go').addEventListener('click', function() {
      document.getElementById('status').textContent = 'clicked';
      fetch('/api/missing').catch(function() {});
    });

    // Mirror the last key chord into the DOM — exercises pressKey (incl. modifiers).
    document.addEventListener('keydown', function(e) {
      var parts = [];
      if (e.ctrlKey) parts.push('Control');
      if (e.shiftKey) parts.push('Shift');
      if (e.altKey) parts.push('Alt');
      if (e.metaKey) parts.push('Meta');
      if (['Control', 'Shift', 'Alt', 'Meta'].indexOf(e.key) === -1) parts.push(e.key);
      document.getElementById('lastkey').textContent = parts.join('+');
    });

    // Mirror viewport + region scroll offsets into the DOM — exercises scroll.
    window.addEventListener('scroll', function() {
      document.getElementById('scrolly').textContent = String(Math.round(window.scrollY));
    }, { passive: true });
    document.getElementById('box').addEventListener('scroll', function(e) {
      document.getElementById('boxscroll').textContent = String(Math.round(e.target.scrollTop));
    }, { passive: true });
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

  // Per-test setup: every case starts from a freshly loaded fixture so no test
  // depends on another having run first (order-independent, safe to rerun in
  // isolation). The fixture's `console.error` re-fires on each load.
  beforeEach(async () => {
    await adapter.open(`http://localhost:${server.port}/`);
    await adapter.waitFor({ query: '#go', timeout: 10_000 });
  }, 15_000);

  // Click the button and let the triggered fetch settle, so the network buffer
  // holds the `/api/missing` 404 the network tests assert on — each test that
  // needs it calls this rather than relying on the click test running first.
  async function clickAndSettle(): Promise<void> {
    const node = await adapter.find({ query: '#go' });
    if (!node) throw new Error('button not found');
    await adapter.click(node);
    await adapter.waitFor({ networkIdle: true, timeout: 10_000 });
  }

  // Scroll/key effects land via async DOM events — poll a mirror node's text until
  // the predicate holds (or give up, letting the assertion report the real value).
  async function pollText(query: string, pred: (text: string) => boolean): Promise<void> {
    for (let i = 0; i < 40; i++) {
      const node = await adapter.find({ query });
      if (node && pred(node.name)) return;
      await Bun.sleep(25);
    }
  }

  // -------------------------------------------------------------------------
  // open
  // -------------------------------------------------------------------------

  test('open: navigates to the fixture and waits for the button', async () => {
    // Re-navigate explicitly (not relying on beforeEach) to assert open() itself.
    await adapter.open(`http://localhost:${server.port}/`);
    // waitFor confirms the button is visible — implicitly asserts open() worked.
    await adapter.waitFor({ query: '#go', timeout: 10_000 });
    expect(await adapter.find({ query: '#go' })).not.toBeNull();
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
  // pressKey
  // -------------------------------------------------------------------------

  test('pressKey: a plain key reaches the page', async () => {
    await adapter.pressKey('Enter');
    await pollText('#lastkey', (t) => t === 'Enter');
    expect((await adapter.find({ query: '#lastkey' }))?.name).toBe('Enter');
  });

  test('pressKey: a chord holds the modifier while tapping the key', async () => {
    await adapter.pressKey('Control+a');
    await pollText('#lastkey', (t) => t === 'Control+a');
    expect((await adapter.find({ query: '#lastkey' }))?.name).toBe('Control+a');
  });

  test('pressKey: an unknown key fails loud', async () => {
    await expect(adapter.pressKey('NotARealKey')).rejects.toThrow(AdapterError);
  });

  test('pressKey: a blank key fails loud', async () => {
    await expect(adapter.pressKey('   ')).rejects.toThrow(AdapterError);
  });

  // -------------------------------------------------------------------------
  // scroll
  // -------------------------------------------------------------------------

  test('scroll: down moves the viewport', async () => {
    await adapter.scroll({ direction: 'down' });
    await pollText('#scrolly', (t) => Number(t) > 0);
    expect(Number((await adapter.find({ query: '#scrolly' }))?.name)).toBeGreaterThan(0);
  });

  test('scroll: within scrolls the region, leaving the viewport put', async () => {
    await adapter.scroll({ direction: 'down', within: '#box', amount: 200 });
    await pollText('#boxscroll', (t) => Number(t) > 0);
    expect(Number((await adapter.find({ query: '#boxscroll' }))?.name)).toBeGreaterThan(0);
    expect(Number((await adapter.find({ query: '#scrolly' }))?.name)).toBe(0);
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
    await clickAndSettle();
    // The click handler sets #status to 'clicked'.
    const status = await adapter.find({ query: '#status' });
    expect(status?.name).toBe('clicked');
  }, 15_000);

  // -------------------------------------------------------------------------
  // network — populated by the fetch triggered in the click test
  // -------------------------------------------------------------------------

  test('network: captures the 404 response from /api/missing', async () => {
    await clickAndSettle();
    const entries = await adapter.network({ filters: { url_contains: '/api/missing' } });
    expect(entries.length).toBeGreaterThan(0);

    const entry = entries[0];
    expect(entry?.status).toBe(404);
    expect(entry?.ok).toBe(false);
    expect(entry?.method).toBe('GET');
  });

  test('network: status_gte filter narrows to error responses', async () => {
    await clickAndSettle();
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
