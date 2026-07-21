import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { tool } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { chromium } from 'playwright-core';
import { z } from 'zod';
import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import { AdapterError, ConfigError, TargetNotFoundError } from '../errors.js';
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
    const dir = await stat(join(base, 'app', 'profiles', 'logged-in'));
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
    expect(await stat(join(base, 'app', 'profiles', 'logged-in')).catch(() => null)).toBeNull();
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
