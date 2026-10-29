/**
 * Boot regressions — the gate in front of the server, and the server behind it.
 *
 * The workspace's one-run rule rests on a kernel-held `flock(2)`. A host that
 * cannot provide that backend can never enforce the rule, so the boot must
 * refuse to come up: no config read, no workspace, no MCP server. A boot that
 * merely failed LATER would leave a workspace behind and a half-wired server
 * accepting a run it cannot own.
 *
 * The cases drive the boot through its seams (`BootDeps`) — never a module
 * mock, which would leak into the suites running alongside.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { type BootDeps, bootServer } from './boot.js';
import { DEFAULT_MODELS } from './config/load.js';
import { McpServerError, WorkspaceError } from './errors.js';
import { startStdioServer } from './mcp/server.js';
import { workspacePaths } from './session/workspace.js';

/**
 * The project config the boot reads.
 *
 * Driver and vision are DIFFERENT models on purpose: the self-look probe only
 * runs when they match, and a probe would reach for the provider's catalog.
 */
const CONFIG = {
  models: { driver: DEFAULT_MODELS.driver, vision: DEFAULT_MODELS.vision },
  workspace: './tmp/ui-debugger-mcp',
  targets: { web: { adapter: 'browser', url: 'http://localhost:3000' } },
} as const;

/** A stdout that swallows everything the transport writes. */
const sink = (): Writable =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

/** The temp roots this file created — removed after every case. */
let roots: string[] = [];
/** The provider key the environment carried before the case touched it. */
let previousKey: string | undefined;

beforeEach(() => {
  roots = [];
  previousKey = process.env.OPENAI_API_KEY;
  // A stub key: the boot resolves the provider, it never calls it.
  process.env.OPENAI_API_KEY = 'sk-boot-test';
});

afterEach(async () => {
  if (previousKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = previousKey;
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/**
 * A project directory, optionally carrying a config file.
 *
 * The project sits one level under the temp root so its basename is stable —
 * the workspace path is derived from it.
 */
async function makeProject(config?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'ui-dbg-boot-'));
  roots.push(root);
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  if (config !== undefined) {
    await writeFile(join(cwd, '.ui-debugger-mcp.json'), JSON.stringify(config), 'utf8');
  }
  return cwd;
}

/** The rejection of a boot that failed — `undefined` when it resolved. */
async function failure(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** A server seam over the REAL stdio server, on streams of the test's own. */
function stdioServer(stdin: PassThrough): NonNullable<BootDeps['startServer']> {
  return (tools, init) => startStdioServer(tools, { onClose: init.onClose, stdin, stdout: sink() });
}

test('a host without a flock backend never boots: no server, no workspace', async () => {
  const cwd = await makeProject(CONFIG);
  const workspace = workspacePaths(cwd, CONFIG.workspace);
  const gateFailure = new WorkspaceError(
    'cannot load flock(2) for the workspace ownership lock on linux (tried libc.so.6): not found',
  );
  let started = 0;

  const error = await failure(
    bootServer(cwd, {
      assertOwnerLockBackend: async () => {
        throw gateFailure;
      },
      startServer: async () => {
        started += 1;
        throw new Error('the MCP server must not start without a flock backend');
      },
    }),
  );

  // The gate's error reaches the caller UNCHANGED — a boot that swallowed or
  // rewrapped it would look like any other failed start.
  expect(error).toBeInstanceOf(WorkspaceError);
  expect(error).toBe(gateFailure);
  expect(started).toBe(0);
  // Nothing was created: the workspace is what a run would later own, and a
  // server that cannot lock must not have made one.
  expect(existsSync(workspace.root)).toBe(false);
  expect(existsSync(join(cwd, 'tmp'))).toBe(false);
});

test('the gate runs before the config is read: a missing project config does not mask it', async () => {
  const cwd = await makeProject(); // no config file at all
  const gateFailure = new WorkspaceError('no flock backend on this host');

  const error = await failure(
    bootServer(cwd, {
      assertOwnerLockBackend: async () => {
        throw gateFailure;
      },
    }),
  );

  // A config error here would mean the boot read the config BEFORE the gate.
  expect(error).toBe(gateFailure);
});

test('a host with a flock backend boots: the stdio MCP server is connected', async () => {
  const cwd = await makeProject(CONFIG);
  const workspace = workspacePaths(cwd, CONFIG.workspace);
  const stdin = new PassThrough();

  // The gate is NOT stubbed here — the real one resolves this host's `flock`.
  const result = await bootServer(cwd, {
    startServer: stdioServer(stdin),
    exit: () => undefined, // a stray signal must not kill the test runner
  });

  try {
    expect(result.server.isConnected()).toBe(true);
    // The boot really ran: the workspace exists.
    expect(existsSync(workspace.root)).toBe(true);
    // Detection took NO run lock — the boot must not claim the workspace the
    // first run will claim.
    expect(existsSync(join(workspace.root, 'owner.lock'))).toBe(false);
  } finally {
    result.dispose();
    await result.server.close();
    stdin.end();
  }
});

test('dispose removes the signal handlers the boot installed', async () => {
  const cwd = await makeProject(CONFIG);
  const stdin = new PassThrough();
  const before = {
    sigterm: process.listenerCount('SIGTERM'),
    sigint: process.listenerCount('SIGINT'),
  };

  const result = await bootServer(cwd, {
    startServer: stdioServer(stdin),
    exit: () => undefined,
  });

  try {
    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);

    result.dispose();

    expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
    expect(process.listenerCount('SIGINT')).toBe(before.sigint);
  } finally {
    result.dispose();
    await result.server.close();
    stdin.end();
  }
});

test('a server that never starts leaves no signal handlers behind', async () => {
  const cwd = await makeProject(CONFIG);
  const before = {
    sigterm: process.listenerCount('SIGTERM'),
    sigint: process.listenerCount('SIGINT'),
  };
  const startFailure = new McpServerError('the stdio transport could not be opened');

  const error = await failure(
    bootServer(cwd, {
      // The gate is stubbed: this case is about the START path, and the gate's
      // own refusal is covered above.
      assertOwnerLockBackend: async () => undefined,
      startServer: async () => {
        // The handlers ARE installed by the time the server is started — so
        // the counts below are not vacuously equal: there is something to
        // remove, and the boot must remove it.
        expect(process.listenerCount('SIGTERM')).toBe(before.sigterm + 1);
        expect(process.listenerCount('SIGINT')).toBe(before.sigint + 1);
        throw startFailure;
      },
      exit: () => undefined,
    }),
  );

  // The start failure reaches the caller UNCHANGED — a boot that swallowed or
  // rewrapped it would look like any other failed start.
  expect(error).toBe(startFailure);
  // The handlers the boot installed are gone again: a process with no server
  // must not answer a signal by tearing down a run it never had, and a boot
  // that left them behind would fire them into whatever runs next in this
  // process.
  expect(process.listenerCount('SIGTERM')).toBe(before.sigterm);
  expect(process.listenerCount('SIGINT')).toBe(before.sigint);
});
