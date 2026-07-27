import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import { AdapterError, AuthError, ConfigError, TargetNotFoundError } from '../errors.js';
import { sessionPaths, workspacePaths } from '../session/workspace.js';
import {
  buildSession,
  makeSessionBuilder,
  resolveRunTarget,
  type SessionBuilderDeps,
  withToolLog,
} from './session-builder.js';

// --- resolveRunTarget (per-run URL: "the boss tells the driver where to go") ---

const webTarget: Target = { adapter: 'browser', url: 'http://localhost:3000', headless: true };

test('resolveRunTarget overrides a web target url with the per-run url', () => {
  expect(resolveRunTarget(webTarget, 'web', 'https://staging.example.com')).toEqual({
    adapter: 'browser',
    url: 'https://staging.example.com',
    headless: true,
  });
});

test('resolveRunTarget keeps the configured url when no per-run url is given', () => {
  expect(resolveRunTarget(webTarget, 'web', undefined)).toBe(webTarget);
});

test('resolveRunTarget requires a url for a web target that has none', () => {
  const noUrl: Target = { adapter: 'browser', headless: true };
  expect(() => resolveRunTarget(noUrl, 'web', undefined)).toThrow(ConfigError);
});

test('resolveRunTarget rejects a url override for a non-web target', () => {
  const desktop: Target = { adapter: 'desktop', launch: 'myapp' };
  expect(() => resolveRunTarget(desktop, 'screen', 'http://x')).toThrow(ConfigError);
});

const CONFIG: ResolvedConfig = {
  models: { driver: 'd', vision: 'v', summary: 's' },
  workspace: './tmp/ui-debugger-mcp',
  targets: {
    web: { adapter: 'browser', url: 'http://localhost:3000', headless: true },
    screen: { adapter: 'desktop', launch: 'myapp', window: { title: 'My App' } },
    phone: { adapter: 'android', avd: 'pixel' },
  },
  provider: { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1' },
};

// Every test that calls `deps()` writes real files (story.md, screenshots/, logs/)
// under this workspace — `mkdtemp`'d fresh per test and removed after, so runs
// never accumulate a stray `/tmp/ui-dbg-builder-test` shared across the whole suite.
let builderTmpDir: string;

beforeEach(async () => {
  builderTmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-builder-test-'));
});

afterEach(async () => {
  await rm(builderTmpDir, { recursive: true, force: true });
});

function deps(): SessionBuilderDeps {
  return {
    config: CONFIG,
    models: {
      driver: new MockLanguageModelV3(),
      vision: new MockLanguageModelV3(),
      summary: new MockLanguageModelV3(),
    },
    workspace: workspacePaths('/project/app', builderTmpDir),
  };
}

test('buildSession rejects an unknown target before touching disk or the browser', async () => {
  await expect(buildSession(deps(), { id: 's1', target: 'ghost', goal: 'x' })).rejects.toThrow(
    TargetNotFoundError,
  );
});

test('an inherited Object.prototype key is not a target (constructor, toString, __proto__)', async () => {
  // A plain index read answers truthy for these, so the guard used to pass: the
  // run wrote `sessions/<id>/story.md`, then died as "unknown adapter type:
  // undefined" — while `describe` (Object.entries) correctly called it not found.
  const d = deps();
  for (const name of ['constructor', 'toString', 'valueOf', '__proto__']) {
    await expect(buildSession(d, { id: `proto-${name}`, target: name, goal: 'x' })).rejects.toThrow(
      TargetNotFoundError,
    );
    // ...and nothing was littered on disk for a target that does not exist.
    expect(existsSync(sessionPaths(d.workspace, `proto-${name}`).root)).toBe(false);
  }
});

test('buildSession wires a desktop target (addendum + adapter) without launching', async () => {
  const built = await buildSession(deps(), {
    id: 'd1',
    target: 'screen',
    goal: 'open the settings dialog',
  });
  expect(built.session).toBeDefined();
  expect(typeof built.open).toBe('function');
  expect(typeof built.run).toBe('function');
});

test('buildSession writes story.md with goal, criteria, and target', async () => {
  const d = deps();
  await buildSession(d, {
    id: 'story1',
    target: 'screen',
    goal: 'open the settings dialog',
    criteria: 'no console errors\nsettings dialog is visible',
  });
  const paths = sessionPaths(d.workspace, 'story1');
  const content = await readFile(paths.storyMd, 'utf8');
  expect(content).toContain('screen');
  expect(content).toContain('open the settings dialog');
  expect(content).toContain('no console errors');
  expect(content).toContain('settings dialog is visible');
});

/**
 * Budget for the two `story.md` address tests.
 *
 * They assert on file CONTENT, not on speed, but building a web target
 * constructs the real adapter — and CI runs the whole suite in parallel on a
 * 2-vCPU runner alongside a real-browser e2e file. Locally these take ~0.4s;
 * starved, one crossed Bun's 5s default and failed a green branch. The cap only
 * exists to bound a hang, so give it room rather than let load decide.
 */
const STORY_TIMEOUT_MS = 30_000;

// A run's own record has to say WHICH app it drove: findings from a run that
// wandered off-target are otherwise indistinguishable, after the fact, from
// findings about the app that was actually asked for.
test(
  'buildSession records the app address in story.md for a web run',
  async () => {
    const d = deps();
    await buildSession(d, { id: 'story-addr', target: 'web', goal: 'check the home page' });
    const content = await readFile(sessionPaths(d.workspace, 'story-addr').storyMd, 'utf8');
    expect(content).toContain('**Address:** http://localhost:3000');
  },
  STORY_TIMEOUT_MS,
);

test(
  'buildSession honors a per-run url override in story.md',
  async () => {
    const d = deps();
    await buildSession(d, {
      id: 'story-addr2',
      target: 'web',
      goal: 'check staging',
      url: 'https://staging.example.com/app',
    });
    const content = await readFile(sessionPaths(d.workspace, 'story-addr2').storyMd, 'utf8');
    expect(content).toContain('**Address:** https://staging.example.com/app');
  },
  STORY_TIMEOUT_MS,
);

test('buildSession prunes old session dirs, keeping the newest 5 including this run', async () => {
  // Nothing ever removed a session dir: every run leaves story.md, findings.json,
  // the whole logs/ trail, every screenshot and a replay.mp4 behind, so an
  // afternoon of dogfooding was hundreds of MB of tmp/ nobody cleaned up.
  const d = deps();
  const old = [
    '2026-07-20_09-00-00-0001',
    '2026-07-21_09-00-00-0001',
    '2026-07-22_09-00-00-0001',
    '2026-07-23_09-00-00-0001',
    '2026-07-24_09-00-00-0001',
    '2026-07-25_09-00-00-0001',
  ];
  for (const id of old) {
    await mkdir(join(sessionPaths(d.workspace, id).root, 'logs'), { recursive: true });
  }

  const fresh = '2026-07-26_09-00-00-0001';
  await buildSession(d, { id: fresh, target: 'screen', goal: 'open the settings dialog' });

  // The new run plus the 4 newest old ones survive; the 2 oldest are gone.
  expect(existsSync(sessionPaths(d.workspace, fresh).root)).toBe(true);
  for (const id of old.slice(2)) expect(existsSync(sessionPaths(d.workspace, id).root)).toBe(true);
  for (const id of old.slice(0, 2))
    expect(existsSync(sessionPaths(d.workspace, id).root)).toBe(false);
});

test('buildSession writes story.md without a criteria section when none given', async () => {
  const d = deps();
  await buildSession(d, { id: 'story2', target: 'screen', goal: 'open the settings dialog' });
  const paths = sessionPaths(d.workspace, 'story2');
  const content = await readFile(paths.storyMd, 'utf8');
  expect(content).toContain('(none)');
});

test('buildSession wires an android target (addendum + adapter) without launching', async () => {
  const built = await buildSession(deps(), {
    id: 'a1',
    target: 'phone',
    goal: 'open com.example.app and verify the home screen',
  });
  expect(built.session).toBeDefined();
  expect(typeof built.open).toBe('function');
  expect(typeof built.run).toBe('function');
});

// --- profile wiring ---------------------------------------------------------
// A managed web target whose `executablePath` points at nothing fails inside
// Playwright before any Chrome starts — so the run gets far enough to prove the
// profile dir was resolved and created, without launching a browser.

async function buildWebRun(profile: string | undefined, base: string): Promise<void> {
  const web: Target = {
    adapter: 'browser',
    url: 'http://localhost:3000',
    headless: true,
    executablePath: '/nonexistent/chrome-for-tests',
    ...(profile ? { profile } : {}),
  };
  const d: SessionBuilderDeps = {
    ...deps(),
    config: { ...CONFIG, targets: { ...CONFIG.targets, web } },
    workspace: workspacePaths('/project/app', base),
  };
  await expect(buildSession(d, { id: 'w1', target: 'web', goal: 'x' })).rejects.toThrow(
    AdapterError,
  );
}

test('buildSession creates the target-configured profile dir under the workspace', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ui-dbg-profile-'));
  try {
    await buildWebRun('profiles/logged-in', base);
    const root = workspacePaths('/project/app', base).root;
    const dir = await stat(join(root, 'profiles', 'logged-in'));
    expect(dir.isDirectory()).toBe(true);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('buildSession leaves the default profile dir alone when `profile` is unset', async () => {
  const base = await mkdtemp(join(tmpdir(), 'ui-dbg-profile-'));
  try {
    await buildWebRun(undefined, base);
    // No stray dir: the fallback is `chrome-user-data/`, made by `ensureWorkspace`.
    const root = workspacePaths('/project/app', base).root;
    expect(await stat(join(root, 'profiles', 'logged-in')).catch(() => null)).toBeNull();
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

// --- web target end-to-end (real Chromium) ----------------------------------
// Unlike desktop/android, `BrowserAdapter.create()` itself launches the browser
// (`open()` only navigates) — so wiring a web target for real means a real,
// headless Chromium process, not a mock. Same detection/skip guard as
// `e2e.test.ts` / `browser-adapter.integration.test.ts`: runs locally, skips
// where no binary is installed.

function findChrome(): string | null {
  if (process.env.SKIP_BROWSER_TESTS) return null;
  const env = process.env.CHROMIUM_PATH;
  if (env && existsSync(env)) return env;
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

(CHROME ? test : test.skip)(
  'buildSession wires a web target end-to-end (real headless Chromium, no navigation)',
  async () => {
    const web: Target = {
      adapter: 'browser',
      url: 'http://localhost:1', // never dialed — `buildSession` doesn't call `open()`
      headless: true,
      ...(typeof CHROME === 'string' ? { executablePath: CHROME } : {}),
    };
    const d: SessionBuilderDeps = {
      ...deps(),
      config: { ...CONFIG, targets: { ...CONFIG.targets, web } },
    };
    const built = await buildSession(d, { id: 'web1', target: 'web', goal: 'open the app' });
    try {
      expect(built.session).toBeDefined();
      expect(typeof built.open).toBe('function');
      expect(typeof built.run).toBe('function');
    } finally {
      await built.session.close(); // releases the real Chromium process
    }
  },
);

// --- target notes (standing preconditions) ----------------------------------

/**
 * Capture what the driver model is actually sent, then stop the loop at once.
 * The prompt is the only place `notes` can be observed — it is composed, not
 * stored — so this drives one real (mock-backed) step to read it back.
 */
function capturingDriver(seen: string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      seen.push(JSON.stringify(prompt));
      return {
        content: [{ type: 'text' as const, text: 'done' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
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
    },
  });
}

test("buildSession composes the target's notes into the driver's system prompt", async () => {
  const seen: string[] = [];
  const notes = 'needs seeded data — empty tables are expected on /new';
  const d: SessionBuilderDeps = {
    ...deps(),
    models: { ...deps().models, driver: capturingDriver(seen) },
    config: {
      ...CONFIG,
      targets: { ...CONFIG.targets, screen: { adapter: 'desktop', launch: 'myapp', notes } },
    },
  };

  const built = await buildSession(d, { id: 'notes1', target: 'screen', goal: 'open settings' });
  await built.run({
    inbox: { drain: () => [] },
    progress: { writeFindings: async () => 'findings.json' },
    signal: new AbortController().signal,
  });

  // Config-level, so the caller never had to paste it into the goal — and it
  // arrives as its own section, not smuggled into the story.
  expect(seen[0]).toContain('Known about this app');
  expect(seen[0]).toContain(notes);
});

test('buildSession sends no notes section for a target that declares none', async () => {
  const seen: string[] = [];
  const d: SessionBuilderDeps = {
    ...deps(),
    models: { ...deps().models, driver: capturingDriver(seen) },
  };

  const built = await buildSession(d, { id: 'notes2', target: 'screen', goal: 'open settings' });
  await built.run({
    inbox: { drain: () => [] },
    progress: { writeFindings: async () => 'findings.json' },
    signal: new AbortController().signal,
  });

  expect(seen[0]).not.toContain('Known about this app');
});

// --- named auth personas (`start_debug({as})`) ------------------------------

/** A web target carrying two personas; `executablePath` is never reached in these. */
const AUTH_TARGET: Target = {
  adapter: 'browser',
  url: 'http://localhost:3000',
  headless: true,
  auth: {
    admin: {
      path: '/login',
      fields: { email: 'admin@dev.local', password: 'hunter2' },
      submit: 'Sign in',
    },
  },
};

function authDeps(): SessionBuilderDeps {
  return {
    ...deps(),
    config: { ...CONFIG, targets: { ...CONFIG.targets, web: AUTH_TARGET } },
  };
}

test('buildSession rejects an unknown persona before touching disk or the browser', async () => {
  // The alternative is a full run signed out, where every screen behind the login
  // reads as a broken UI — indistinguishable, to the caller, from a real defect.
  const d = authDeps();
  await expect(
    buildSession(d, { id: 'auth-bad', target: 'web', goal: 'x', as: 'admn' }),
  ).rejects.toThrow(ConfigError);
  expect(existsSync(sessionPaths(d.workspace, 'auth-bad').root)).toBe(false);
});

test('buildSession rejects a persona on a target that has no auth block', async () => {
  await expect(
    buildSession(deps(), { id: 'auth-none', target: 'web', goal: 'x', as: 'admin' }),
  ).rejects.toThrow(/has no 'auth' block/);
});

test('buildSession rejects a persona on a non-web target', async () => {
  await expect(
    buildSession(deps(), { id: 'auth-desktop', target: 'screen', goal: 'x', as: 'admin' }),
  ).rejects.toThrow(ConfigError);
});

// --- the login itself, against a real browser and a real login form ---------

/** A two-page fixture: a login form that `fetch`es, and the page it lands on. */
function serveLoginApp(credentials: { email: string; password: string }) {
  const page = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      if (pathname === '/api/login') {
        const body = (await request.json()) as { email?: string; password?: string };
        const ok = body.email === credentials.email && body.password === credentials.password;
        return Response.json({ ok }, { status: ok ? 200 : 401 });
      }
      if (pathname === '/dashboard') return page('<h1>Dashboard</h1><a href="/">Sign out</a>');
      // The form posts over `fetch` on purpose: that is the resource type whose
      // request BODY the adapter captures into `logs/network.log`, which is
      // exactly where an unredacted credential would come to rest.
      return page(`<form id="f">
        <input name="email" type="email" aria-label="Email">
        <input name="password" type="password" aria-label="Password">
        <button type="submit">Sign in</button>
      </form>
      <script>
        document.getElementById('f').addEventListener('submit', async (e) => {
          e.preventDefault();
          const data = new FormData(e.target);
          const res = await fetch('/api/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: data.get('email'), password: data.get('password') }),
          });
          if (res.ok) location.href = '/dashboard';
        });
      </script>`);
    },
  });
  return { server, url: `http://localhost:${server.port}` };
}

(CHROME ? test : test.skip)(
  'a persona signs the run in before the first step, and leaves no credential in the logs',
  async () => {
    const credentials = { email: 'admin@dev.local', password: 'p@ssw0rd' };
    const { server, url } = serveLoginApp(credentials);
    const web: Target = {
      adapter: 'browser',
      url,
      headless: true,
      ...(typeof CHROME === 'string' ? { executablePath: CHROME } : {}),
      auth: { admin: { path: '/login', fields: credentials, submit: 'Sign in' } },
    };
    const d: SessionBuilderDeps = {
      ...deps(),
      config: { ...CONFIG, targets: { ...CONFIG.targets, web } },
    };
    const built = await buildSession(d, {
      id: 'auth-e2e',
      target: 'web',
      goal: 'open the dashboard',
      as: 'admin',
    });
    try {
      await built.open();

      // Reaching here at all is the first assertion: `open` only resolves once the
      // login left `/login`, so the driver's first step starts INSIDE the app.
      const paths = sessionPaths(d.workspace, 'auth-e2e');
      const logs = await Promise.all(
        ['agent.log', 'network.log', 'console.log'].map((name) =>
          readFile(join(paths.logs, name), 'utf8').catch(() => ''),
        ),
      );
      const written = logs.join('\n');
      // The whole run's durable trail, and not one credential in it.
      expect(written).toContain('auth: signed in as "admin"');
      expect(written).not.toContain(credentials.password);
      expect(written).not.toContain(encodeURIComponent(credentials.password));
      expect(written).not.toContain(credentials.email);
      // …but the POST is still visible, which is what the log is FOR.
      expect(written).toContain('<redacted, 8 chars>');
    } finally {
      await built.session.close();
      server.stop(true);
    }
  },
  STORY_TIMEOUT_MS,
);

(CHROME ? test : test.skip)(
  'a persona whose credentials are wrong fails the run instead of opening it signed out',
  async () => {
    const { server, url } = serveLoginApp({ email: 'admin@dev.local', password: 'p@ssw0rd' });
    const web: Target = {
      adapter: 'browser',
      url,
      headless: true,
      ...(typeof CHROME === 'string' ? { executablePath: CHROME } : {}),
      auth: {
        admin: {
          path: '/login',
          fields: { email: 'admin@dev.local', password: 'wrong' },
          submit: 'Sign in',
        },
      },
    };
    const d: SessionBuilderDeps = {
      ...deps(),
      config: { ...CONFIG, targets: { ...CONFIG.targets, web } },
    };
    const built = await buildSession(d, {
      id: 'auth-e2e-bad',
      target: 'web',
      goal: 'open the dashboard',
      as: 'admin',
    });
    try {
      await expect(built.open()).rejects.toThrow(AuthError);
    } finally {
      await built.session.close();
      server.stop(true);
    }
  },
  STORY_TIMEOUT_MS,
);

test('makeSessionBuilder binds the deps into a per-run builder', async () => {
  const build = makeSessionBuilder(deps());
  await expect(build({ id: 's1', target: 'ghost', goal: 'x' })).rejects.toThrow(
    TargetNotFoundError,
  );
});

// --- withToolLog -------------------------------------------------------------
// `withToolLog` wraps every belt tool with logging via a spread (`{ ...t, execute }`).
// That spread is what carries `toModelOutput` through unchanged — the self-look
// tool (`belt/look.ts`) relies on `toModelOutput` surviving the wrap to turn its
// base64 frame into a multimodal `file-data` part; `pruneStaleFrames` (`loop.ts`)
// then keys off that same shape to drop stale screenshots from later turns. Losing
// the wrap (e.g. rebuilding the tool object field-by-field instead of spreading)
// would silently degrade self-look to plain JSON output with no test failing
// elsewhere, since nothing else exercises `withToolLog` directly.

test('withToolLog preserves toModelOutput unchanged (load-bearing for self-look frame pruning)', async () => {
  const selfLookLike = tool({
    description: 'look',
    inputSchema: z.object({}),
    execute: async () => ({ frame: 'YWJj' }),
    toModelOutput: ({ output }) => ({
      type: 'content',
      value: [{ type: 'file-data' as const, data: output.frame, mediaType: 'image/png' }],
    }),
  });

  const wrapped = withToolLog('look', selfLookLike, () => {});

  // Same function reference — the spread carries it through untouched.
  expect(wrapped.toModelOutput).toBe(selfLookLike.toModelOutput);

  const modelOutput = await wrapped.toModelOutput?.({
    toolCallId: 't1',
    input: {},
    output: { frame: 'YWJj' },
  });
  expect(modelOutput).toEqual({
    type: 'content',
    value: [{ type: 'file-data', data: 'YWJj', mediaType: 'image/png' }],
  });
});

test('withToolLog logs the input on call and returns the original output unchanged', async () => {
  const lines: string[] = [];
  const t = tool({
    description: 'observe',
    inputSchema: z.object({ kind: z.string() }),
    execute: async (input) => ({ echoed: input.kind }),
  });

  const wrapped = withToolLog('observe', t, (line) => lines.push(line));
  const out = await wrapped.execute?.({ kind: 'tree' }, { toolCallId: 'c1', messages: [] });

  expect(out).toEqual({ echoed: 'tree' });
  expect(lines).toEqual(['observe {"kind":"tree"}']);
});

test('withToolLog logs an ERROR line and rethrows when execute throws', async () => {
  const lines: string[] = [];
  const boom = new Error('selector not found');
  const t = tool({
    description: 'act',
    inputSchema: z.object({ action: z.string() }),
    execute: async (): Promise<{ ok: boolean }> => {
      throw boom;
    },
  });

  const wrapped = withToolLog('act', t, (line) => lines.push(line));
  await expect(
    wrapped.execute?.({ action: 'click' }, { toolCallId: 'c1', messages: [] }),
  ).rejects.toThrow(boom);

  expect(lines).toEqual(['act {"action":"click"}', 'act ERROR selector not found']);
});

test('withToolLog returns the tool unchanged when it has no execute function', () => {
  const t = tool({ description: 'no-op', inputSchema: z.object({}) });
  const wrapped = withToolLog('noop', t, () => {
    throw new Error('log must never be called for a tool with no execute');
  });
  expect(wrapped).toBe(t);
});
