/**
 * The describe projection — what a project can be pointed at, and the run it
 * currently holds.
 *
 * `describe` is the catalog's public face: the adapter kind, whether this
 * server LAUNCHES the target or ATTACHES to a running one, whether that kind
 * is usable on THIS host, the auth personas by NAME (never their
 * credentials), the target's standing notes, and the run the project holds —
 * the way back to a lost session id.
 *
 * The catalog projection itself is covered in `catalog.test.ts`; the
 * conversational surface is in `debug-service.test.ts`.
 */

import { expect, test } from 'bun:test';
import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import { TargetNotFoundError } from '../errors.js';
import { workspacePaths } from '../session/workspace.js';
import { DebugService } from './debug-service.js';
import {
  CONFIG,
  CWD,
  fakeBuilder,
  makeService,
  manager,
  NOW,
  useTempWorkspace,
} from './debug-service.test-helpers.js';

useTempWorkspace();

// --- the catalog -------------------------------------------------------------

test('describe lists every configured target with mode + operational flags', () => {
  const svc = makeService(fakeBuilder().build);
  const result = svc.describe({});

  expect(result.models).toEqual(CONFIG.models);
  // The RESOLVED per-project root, not the raw './tmp/ui-debugger-mcp' config
  // string — a caller joining evidence paths to that would look one dir short.
  expect(result.workspace).toBe(workspacePaths(CWD, CONFIG.workspace).root);
  expect(result.workspace).toBe('/project/app/tmp/ui-debugger-mcp/app');
  expect(result.targets.find((t) => t.name === 'web')).toEqual({
    name: 'web',
    adapter: 'browser',
    mode: 'managed',
    operational: true,
    url: 'http://localhost:3000',
    headless: true,
  });
  expect(result.targets.find((t) => t.name === 'screen')).toEqual({
    name: 'screen',
    adapter: 'desktop',
    mode: 'managed',
    operational: true,
  });
  expect(result.targets.find((t) => t.name === 'phone')).toEqual({
    name: 'phone',
    adapter: 'android',
    mode: 'attach',
    operational: true, // wired AND supported on the pinned linux host
  });
});

test('describe reports operational=false for a wired kind on an unsupported platform', () => {
  // Desktop is Linux tooling (X11/Wayland + AT-SPI): wired in this build, but
  // the darwin host cannot run it — the flag must say so instead of promising.
  const { build, log } = fakeBuilder();
  const svc = new DebugService({
    manager,
    config: CONFIG,
    cwd: CWD,
    build,
    now: () => NOW,
    platform: 'darwin',
  });

  const targets = svc.describe({}).targets;
  expect(targets.find((t) => t.name === 'screen')?.operational).toBe(false); // desktop
  expect(targets.find((t) => t.name === 'web')?.operational).toBe(true); // browser
  expect(targets.find((t) => t.name === 'phone')?.operational).toBe(true); // android
  // Describing never starts anything — no browser, no emulator, no session.
  expect(log.params).toHaveLength(0);
});

test('describe reports operational=false for an adapter kind this build does not wire', () => {
  // Off-schema on purpose: the config schema is a closed union, so `loadConfig`
  // rejects an unknown `adapter` — the unwired case is only reachable through a
  // cast config (or a direct call to the availability rule).
  const unwiredConfig: ResolvedConfig = {
    ...CONFIG,
    targets: { ...CONFIG.targets, gadget: { adapter: 'sensors' } as unknown as Target },
  };
  const { build, log } = fakeBuilder();
  const svc = new DebugService({
    manager,
    config: unwiredConfig,
    cwd: CWD,
    build,
    now: () => NOW,
    platform: 'linux',
  });

  const gadget = svc.describe({ target: 'gadget' }).targets[0];
  expect(gadget?.name).toBe('gadget');
  expect(gadget?.adapter as string).toBe('sensors');
  expect(gadget?.operational).toBe(false);
  // Still nothing launched: no adapter, no session.
  expect(log.params).toHaveLength(0);
});

test('describe derives operational from the HOST platform when none is injected', () => {
  // The service's own default (`deps.platform ?? process.platform`): with no
  // injected platform the flag must follow THIS host — browser is supported on
  // every platform this project ships for, desktop is Linux tooling only.
  const { build, log } = fakeBuilder();
  const svc = new DebugService({ manager, config: CONFIG, cwd: CWD, build, now: () => NOW });

  const targets = svc.describe({}).targets;
  expect(targets.find((t) => t.name === 'web')?.operational).toBe(true); // browser
  // Desktop follows the host: true on linux, false on darwin/win32 — a default
  // that ignored the host would answer the wrong thing off linux.
  const desktop = targets.find((t) => t.name === 'screen')?.operational;
  expect(desktop).toBe(process.platform === 'linux');
  // Describing launches nothing — the fake builder is never called.
  expect(log.params).toHaveLength(0);
});

test('describe reports a browser attach target (cdpUrl set) as mode "attach"', () => {
  const attachConfig: ResolvedConfig = {
    ...CONFIG,
    targets: {
      ...CONFIG.targets,
      web: { adapter: 'browser', cdpUrl: 'http://127.0.0.1:9222', headless: true },
    },
  };
  const svc = new DebugService({
    manager,
    config: attachConfig,
    cwd: CWD,
    build: fakeBuilder().build,
    now: () => NOW,
    platform: 'linux',
  });

  expect(svc.describe({ target: 'web' }).targets[0]).toEqual({
    name: 'web',
    adapter: 'browser',
    mode: 'attach',
    operational: true,
    url: undefined,
    headless: true,
  });
});

// --- secrets stay out -------------------------------------------------------

test("describe surfaces a target's persona NAMES, and nothing else about them", () => {
  // A caller must be able to pick a valid `as` without opening the config file —
  // and must never receive the credentials while doing it.
  const withAuth: ResolvedConfig = {
    ...CONFIG,
    targets: {
      dashboard: {
        adapter: 'browser',
        url: 'http://localhost:5173',
        headless: true,
        auth: {
          admin: {
            path: '/login',
            fields: { email: 'a@dev.local', password: 'hunter2' },
            submit: 'Sign in',
          },
          user: {
            path: '/login',
            fields: { email: 'u@dev.local', password: 'u' },
            submit: 'Sign in',
          },
        },
      },
      screen: { adapter: 'desktop', launch: 'myapp' },
    },
  };
  const svc = new DebugService({ manager, config: withAuth, cwd: CWD, build: fakeBuilder().build });

  const [dashboard, screen] = svc.describe({}).targets;
  expect(dashboard?.personas).toEqual(['admin', 'user']);
  expect(JSON.stringify(dashboard)).not.toContain('hunter2');
  // A target with no `auth` block carries no key at all — absent, not empty.
  expect(screen).not.toHaveProperty('personas');
  expect(
    makeService(fakeBuilder().build).describe({ target: 'web' }).targets[0],
  ).not.toHaveProperty('personas');
});

test("describe surfaces a target's standing notes verbatim", () => {
  const notes = 'needs seeded data — empty tables are expected on /new';
  const withNotes: ResolvedConfig = {
    ...CONFIG,
    targets: { web: { adapter: 'browser', url: 'http://x.test', headless: true, notes } },
  };
  const svc = new DebugService({
    manager,
    config: withNotes,
    cwd: CWD,
    build: fakeBuilder().build,
  });

  expect(svc.describe({ target: 'web' }).targets[0]?.notes).toBe(notes);
  // A target that declares none carries no key at all — absent, not empty.
  expect(
    makeService(fakeBuilder().build).describe({ target: 'web' }).targets[0],
  ).not.toHaveProperty('notes');
});

// --- the run this project holds ----------------------------------------------

test('describe reports the run this project holds — the way back to a lost session id', async () => {
  const svc = makeService(fakeBuilder().build);
  expect(svc.describe({})).not.toHaveProperty('session'); // nothing running: no key at all

  const { session_id } = await svc.start({ target: 'web', goal: 'open Audit' });

  expect(svc.describe({}).session).toEqual({
    id: session_id,
    status: 'running',
    goal: 'open Audit',
  });
  // Narrowing to one target must not hide the run — the id is the point of the call.
  expect(svc.describe({ target: 'web' }).session?.id).toBe(session_id);

  await svc.end({ session_id });
  expect(svc.describe({})).not.toHaveProperty('session');
});

test('describe narrows to one named target, and rejects an unknown one', () => {
  const svc = makeService(fakeBuilder().build);
  expect(svc.describe({ target: 'web' }).targets).toHaveLength(1);
  expect(() => svc.describe({ target: 'nope' })).toThrow(TargetNotFoundError);
});
