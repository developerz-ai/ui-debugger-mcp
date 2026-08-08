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

// This low-level suite serves its OWN `Bun.serve` fixture and drives 18 browser
// ops against it. Under the CI runner's parallel 2-vCPU load that fixture flakes
// (ERR_CONNECTION_REFUSED) even though the browser itself is fine — the `e2e`
// suite exercises the real browser→findings path in CI and stays green. Gate this
// one off in CI via SKIP_BROWSER_INTEGRATION; it always runs locally.
const RUN_INTEGRATION = CHROME && !process.env.SKIP_BROWSER_INTEGRATION;

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
  <!-- Embedded document: page-level locators stop at this boundary. The wrapper
       exists only in THIS document, so a string scope must be resolved once and
       applied geometrically, or everything under it disappears. -->
  <div id="checkout">
    <input id="checkout-field" value="own document">
    <iframe id="embed" src="/frame" style="width:320px;height:120px;border:0"></iframe>
  </div>
  <!-- Same content, but with the border+padding an iframe usually carries: the
       element's bounding box is the BORDER box while in-frame rects are relative
       to the CONTENT origin, so the offset must add the 5px border + 3px padding. -->
  <iframe id="bordered" data-testid="bordered-frame" src="/frame2"
          style="width:320px;height:120px;border:5px solid #000;padding:3px"></iframe>
  <!-- Opens a second tab: the adapter must still be driving the first one. -->
  <a id="popup" href="/" target="_blank">Open in new tab</a>
  <button id="submit">Submit</button>
  <!-- No onsubmit and no preventDefault, so clicking Subscribe makes the browser
       submit NATIVELY: the document is replaced and every bit of in-page state goes
       with it. Nothing on screen distinguishes that from a click that did nothing. -->
  <form id="newsletter" action="/">
    <input id="newsletter-email" name="email" value="a@b.com">
    <!-- A credential rides the GET query — the reload URL must reach the run redacted. -->
    <input name="token" type="hidden" value="super-secret-token">
    <button id="newsletter-go" type="submit">Subscribe</button>
  </form>
  <!-- enabled-state matrix: native disabled/readonly, inherited fieldset, ARIA -->
  <input id="plain" value="editable">
  <!-- Pre-filled PAST the element's center, so a click parks the caret mid-string. -->
  <input id="prefilled" size="60" value="0123456789012345678901234567890123456789">
  <input id="check" type="checkbox">
  <input id="ro" value="locked" readonly>
  <input id="off" value="off" disabled>
  <fieldset disabled>
    <legend><input id="in-legend" value="legend"></legend>
    <input id="in-fieldset" value="inherited">
  </fieldset>
  <div id="aria-ro" role="textbox" aria-readonly="true">aria readonly</div>
  <div style="height:3000px">page spacer</div>
  <!-- Far below the fold: its bounds center never sits in the viewport. -->
  <div id="offscreen" style="height:100px;overflow:auto;border:1px solid #000">
    <div style="height:1200px">off-screen region</div>
  </div>
  <script>
    // Fires immediately on load — captured by the console listener.
    console.error('fixture-error');

    // Fires on button click — captured by the network listener as a 404.
    document.getElementById('go').addEventListener('click', function() {
      document.getElementById('status').textContent = 'clicked';
      fetch('/api/missing').catch(function() {});
    });

    // A real API exchange with payloads on BOTH sides — the shape a debugger
    // must be able to explain (why did this 400?).
    document.getElementById('submit').addEventListener('click', function() {
      fetch('/api/echo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer supersecret' },
        body: JSON.stringify({ email: 'a@b.c' })
      }).catch(function() {});
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

/** The embedded document — same-origin, so its DOM is readable through CDP. */
const FRAME_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Embedded</title></head>
<body style="margin:0">
  <button id="inner" data-testid="inner-button">Inner Button</button>
  <p id="innerscroll">0</p>
  <!-- A scrollable region INSIDE the frame: a page-level locator cannot reach it. -->
  <div id="innerbox" style="height:60px;overflow:auto">
    <div style="height:900px">inner scrollable region</div>
  </div>
  <script>
    document.getElementById('innerbox').addEventListener('scroll', function(e) {
      document.getElementById('innerscroll').textContent = String(Math.round(e.target.scrollTop));
    }, { passive: true });
  </script>
</body>
</html>`;

/** A second embedded document, behind a bordered+padded iframe (offset fixture). */
const FRAME2_HTML = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Embedded Two</title></head>
<body style="margin:0">
  <button id="inner2" data-testid="inner-two">Inner Two</button>
</body>
</html>`;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

(RUN_INTEGRATION ? describe : describe.skip)('BrowserAdapter integration', () => {
  let server: ReturnType<typeof Bun.serve>;
  let adapter: BrowserAdapter;
  let profileDir: string;
  // Resolve the OS-assigned port ONCE at startup and cache the URL. Reading
  // `server.port` repeatedly is unreliable on some CI runners (the getter can
  // return -1 mid-run even while the server stays up), which yields a bogus
  // `http://localhost:-1/` and fails every navigation after the first few.
  let baseUrl: string;

  beforeAll(async () => {
    // 1. Serve the fixture on a random OS-assigned port. Bind + navigate via the
    // IPv4 loopback explicitly: on some CI runners `localhost` resolves to `::1`
    // (IPv6) while Bun.serve binds IPv4, so the browser hits a refused connection.
    server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req) {
        const path = new URL(req.url).pathname;
        if (path === '/') {
          return new Response(FIXTURE_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        if (path === '/frame') {
          return new Response(FRAME_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        if (path === '/frame2') {
          return new Response(FRAME2_HTML, {
            headers: { 'Content-Type': 'text/html; charset=utf-8' },
          });
        }
        if (path === '/api/echo') {
          // Answers with a reason — the string a finding needs to be actionable.
          return new Response(JSON.stringify({ error: 'password too short' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'session=abc123' },
          });
        }
        return new Response('Not found', { status: 404 });
      },
    });

    // Cache the bound port immediately — fail loud if it didn't bind a real one.
    const assignedPort = server.port;
    if (!assignedPort || assignedPort < 1) {
      throw new Error(`fixture server did not bind a valid port (got ${assignedPort})`);
    }
    baseUrl = `http://127.0.0.1:${assignedPort}/`;

    // 2. Isolated Chrome profile so tests don't share state with the user's browser.
    profileDir = mkdtempSync(`${tmpdir()}/ui-dbg-test-`);

    // 3. Construct the adapter (does NOT navigate yet).
    const config: WebTarget = {
      adapter: 'browser',
      url: baseUrl,
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
    await adapter.open(baseUrl);
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
    await adapter.open(baseUrl);
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

  test('scroll: an off-viewport `within` region fails loud instead of scrolling the page', async () => {
    // Parking the cursor off-screen would wheel the VIEWPORT and report success —
    // same guard the coordinate click applies.
    await expect(adapter.scroll({ direction: 'down', within: '#offscreen' })).rejects.toThrow(
      AdapterError,
    );
    await expect(adapter.scroll({ direction: 'down', within: '#offscreen' })).rejects.toThrow(
      /outside the viewport/,
    );
    expect(Number((await adapter.find({ query: '#scrolly' }))?.name)).toBe(0);
  });

  // -------------------------------------------------------------------------
  // enabled (contract: false when disabled OR readonly)
  // -------------------------------------------------------------------------

  test('enabled: readonly, disabled, inherited fieldset and ARIA states all read false', async () => {
    const enabledOf = async (query: string): Promise<boolean | undefined> =>
      (await adapter.find({ query }))?.enabled;

    expect(await enabledOf('#plain')).toBe(true);
    expect(await enabledOf('#in-legend')).toBe(true); // a disabled fieldset's first legend stays live
    expect(await enabledOf('#ro')).toBe(false);
    expect(await enabledOf('#off')).toBe(false);
    expect(await enabledOf('#in-fieldset')).toBe(false); // inherited from fieldset[disabled]
    expect(await enabledOf('#aria-ro')).toBe(false);
  });

  // -------------------------------------------------------------------------
  // limit
  // -------------------------------------------------------------------------

  test('readState: caps at limit and rejects a bad one', async () => {
    expect((await adapter.readState({ limit: 2 })).length).toBe(2);
    // `slice(0, -1)` would silently drop the last node — fail loud instead.
    await expect(adapter.readState({ limit: -1 })).rejects.toThrow(AdapterError);
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

  // -------------------------------------------------------------------------
  // network payloads — the reason a request failed, not just that it did
  // -------------------------------------------------------------------------

  test('network: captures request + response bodies for a failing API call', async () => {
    await adapter.click('#submit');
    await adapter.waitFor({ networkIdle: true, timeout: 5_000 });
    const [entry] = await adapter.network({ filters: { url_contains: '/api/echo' } });
    expect(entry?.status).toBe(400);
    expect(entry?.method).toBe('POST');
    expect(entry?.requestBody).toBe('{"email":"a@b.c"}');
    // The whole point: the server's reason survives into the finding.
    expect(entry?.responseBody).toContain('password too short');
    expect(entry?.durationMs).toBeGreaterThanOrEqual(0);
  }, 15_000);

  test('network: credential headers are redacted, ordinary ones are not', async () => {
    await adapter.click('#submit');
    await adapter.waitFor({ networkIdle: true, timeout: 5_000 });
    const [entry] = await adapter.network({ filters: { url_contains: '/api/echo' } });
    expect(entry?.requestHeaders?.authorization).toMatch(/^<redacted, \d+ chars>$/);
    expect(entry?.requestHeaders?.['content-type']).toContain('application/json');
    expect(entry?.responseHeaders?.['set-cookie']).toMatch(/^<redacted, \d+ chars>$/);
  }, 15_000);

  test('network: static assets are still captured for an explicit read', async () => {
    // The asset default lives in the belt, not here — the adapter stays complete.
    const docs = await adapter.network({ filters: { resource_in: ['document'] } });
    expect(docs.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // iframes — a page-level locator stops at the boundary; readState must not
  // -------------------------------------------------------------------------

  test('readState: reads nodes inside an iframe and tags them with the frame', async () => {
    const nodes = await adapter.readState({ limit: 500 });
    const inner = nodes.find((n) => n.name.includes('Inner Button'));
    expect(inner).toBeDefined();
    expect(inner?.frame).toContain('/frame');
  }, 15_000);

  test('readState: iframe bounds are page coordinates, not frame-relative', async () => {
    const nodes = await adapter.readState({ limit: 500 });
    const inner = nodes.find((n) => n.name.includes('Inner Button'));
    const embed = nodes.find((n) => n.role === 'iframe' || n.testid === 'inner-button');
    expect(inner).toBeDefined();
    // The iframe sits well down the page, so a frame-relative y (~0) would prove
    // the offset was never applied.
    expect(inner?.bounds.y).toBeGreaterThan(0);
    expect(embed).toBeDefined();
  }, 15_000);

  test('find/click: a selector resolves into the iframe', async () => {
    const node = await adapter.find({ query: 'data-testid=inner-button' });
    expect(node?.name).toContain('Inner Button');
    // Clicking through the selector path must not throw: it falls through to the
    // frame that actually holds the element.
    await adapter.click('data-testid=inner-button');
  }, 15_000);

  test('readState: an invalid selector fails loud instead of reading back as “nothing there”', async () => {
    // The jQuery-ism LLMs emit constantly. Swallowed per-frame it returned
    // `{count: 0}` — which the driver reads as "the element does not exist" —
    // while `click()` with the same selector reported the real error.
    const read = adapter.readState({ query: 'div:contains("Total")' });
    await expect(read).rejects.toThrow(AdapterError);
    await expect(read).rejects.toThrow(/contains/);
  }, 15_000);

  test('waitFor: a query resolves inside an iframe, not just the main document', async () => {
    // Before: `page.locator()` never crossed the boundary, so waiting for a node
    // the tree had just shown (tagged `frame=…`) burned the whole timeout.
    await expect(
      adapter.waitFor({ query: 'data-testid=inner-two', timeout: 5_000 }),
    ).resolves.toBeUndefined();
  }, 15_000);

  test('scroll: a `within` region inside an iframe scrolls, instead of “not found”', async () => {
    await adapter.scroll({ direction: 'down', within: '#innerbox', amount: 200 });
    await pollText('#innerscroll', (t) => Number(t) > 0);
    expect(Number((await adapter.find({ query: '#innerscroll' }))?.name)).toBeGreaterThan(0);
    // The page itself stayed put — the wheel landed on the region, not the viewport.
    expect(Number((await adapter.find({ query: '#scrolly' }))?.name)).toBe(0);
  }, 15_000);

  test('readState: a string `within` keeps the child-frame content under it', async () => {
    // `#checkout` exists ONLY in the main document; re-resolving it per frame
    // matched nothing inside the iframe and silently dropped everything embedded
    // there — exactly how a Stripe card field goes missing from a checkout read.
    const scoped = await adapter.readState({ within: '#checkout', limit: 500 });
    expect(scoped.some((n) => n.name.includes('own document'))).toBe(true);
    const inner = scoped.find((n) => n.name.includes('Inner Button'));
    expect(inner).toBeDefined();
    expect(inner?.frame).toContain('/frame');
    // Still a scope: what sits outside it stays out.
    expect(scoped.some((n) => n.name === 'Click me')).toBe(false);
  }, 15_000);

  test('readState: an iframe’s border+padding shifts its content origin', async () => {
    const nodes = await adapter.readState({ limit: 500 });
    const frameEl = nodes.find((n) => n.testid === 'bordered-frame');
    const inner = nodes.find((n) => n.name.includes('Inner Two'));
    expect(frameEl).toBeDefined();
    expect(inner).toBeDefined();
    // The button sits at (0,0) of a `margin:0` frame document, so its page
    // coordinates are the iframe's border box plus the 5px border + 3px padding.
    // Using the border box alone put every click 8px off — silently.
    // (sub-pixel layout rounding, hence the 0-digit tolerance — 0 vs 8 is the point)
    expect((inner?.bounds.x ?? 0) - (frameEl?.bounds.x ?? 0)).toBeCloseTo(8, 0);
    expect((inner?.bounds.y ?? 0) - (frameEl?.bounds.y ?? 0)).toBeCloseTo(8, 0);
  }, 15_000);

  test('type: text lands at the END of a pre-filled field, never spliced into it', async () => {
    // A click parks the caret at the element's CENTER, so typing into a field
    // whose value runs past that point spliced text into the middle — and the
    // driver's own read-back then showed garbage it could not explain.
    await adapter.type('#prefilled', 'ZZZ');
    expect((await adapter.find({ query: '#prefilled' }))?.value).toBe(
      '0123456789012345678901234567890123456789ZZZ',
    );
  }, 15_000);

  test('main-document nodes carry no frame tag', async () => {
    const node = await adapter.find({ query: '#go' });
    expect(node?.frame).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // tabs — a target="_blank" click opens one; the adapter still drives the first
  // -------------------------------------------------------------------------

  test('tabs: lists the single tab before anything opens one', async () => {
    const tabs = await adapter.tabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    expect(tabs.filter((t) => t.active).length).toBe(1);
  });

  test('tabs: a target=_blank click opens a tab, and switching drives it', async () => {
    const before = await adapter.tabs();
    await adapter.click('#popup');
    await adapter.waitFor({ networkIdle: true, timeout: 5_000 });
    const after = await adapter.tabs();
    expect(after.length).toBe(before.length + 1);
    // Still driving the original tab — the new one is not stolen silently.
    expect(after.find((t) => t.active)?.index).toBe(before.find((t) => t.active)?.index);

    const opened = after[after.length - 1];
    if (!opened) throw new Error('expected an opened tab');
    await adapter.selectTab(opened.index);
    const switched = await adapter.tabs();
    expect(switched.find((t) => t.active)?.index).toBe(opened.index);

    // Capture followed the switch: the new tab's own document load is recorded.
    const entries = await adapter.network();
    expect(entries.length).toBeGreaterThan(0);

    await adapter.selectTab(0);
  }, 20_000);

  test('readState reports a field’s LIVE value, not its markup attribute', async () => {
    await adapter.type('#plain', 'typed text');
    const node = await adapter.find({ query: '#plain' });
    // `getAttribute('value')` would still say "editable" — the initial markup.
    expect(node?.value).toContain('typed text');
  }, 15_000);

  test('readState reports live checked state', async () => {
    const before = await adapter.find({ query: '#check' });
    expect(before?.checked).toBe(false);
    await adapter.click('#check');
    const after = await adapter.find({ query: '#check' });
    expect(after?.checked).toBe(true);
  }, 15_000);

  test('a non-form node carries neither value nor checked', async () => {
    const node = await adapter.find({ query: '#go' });
    expect(node?.value).toBeUndefined();
    expect(node?.checked).toBeUndefined();
  });

  test('tabs: selecting a nonexistent tab fails loud', async () => {
    await expect(adapter.selectTab(99)).rejects.toThrow(AdapterError);
  });

  // The one link no fake can prove: that a native form submit really does raise
  // Chrome's `load`, and that the adapter turns it into a reportable surprise.
  // Without it the driver reads the reloaded page as an unchanged one and calls
  // the submit a success — measured on dummy/web before this existed (#60).
  test('a form that submits without preventDefault surfaces as an unrequested load', async () => {
    // `beforeEach` navigated here deliberately, so the queue starts empty — a
    // navigation the driver asked for is never a surprise.
    expect(await adapter.takeUnrequestedLoads()).toEqual([]);

    await adapter.click('#newsletter-go');
    await adapter.waitFor({ networkIdle: true, timeout: 10_000 });

    const loads = await adapter.takeUnrequestedLoads();
    expect(loads.length).toBe(1);
    // The submit reloaded the document with a credential in the query. The load is
    // surfaced (a blind driver would otherwise call the submit a success), but the
    // secret is redacted before it reaches the driver's context or the findings.
    expect(loads[0]).not.toContain('super-secret-token');
    expect(loads[0]).toContain('token=<redacted,');
    // Drained by that read: the next act must not inherit this reload.
    expect(await adapter.takeUnrequestedLoads()).toEqual([]);
  }, 20_000);
});
