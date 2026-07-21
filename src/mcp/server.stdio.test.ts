/**
 * Client death — stdio EOF must reach the caller's close hook. Fake streams
 * stand in for the process's own stdin/stdout; no real stdio is touched.
 *
 * Split out of `server.test.ts` (500-LOC file cap) — shares its DebugService
 * fixtures via `server.test-helpers.ts`.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { DebugService } from '../services/debug-service.js';
import { SessionManager } from '../session/manager.js';
import type { Session } from '../session/session.js';
import { _resetCounter } from '../session/workspace.js';
import { startStdioServer } from './server.js';
import { CONFIG, CWD, fakeBuilder, NOW } from './server.test-helpers.js';
import { outerTools } from './tools/index.js';

/** A stdout that swallows everything the transport writes. */
const sink = (): Writable =>
  new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });

/** A promise plus the resolver a callback fires — lets a test await a hook. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = (): void => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** Let pending stream events ('close' after 'end') land before asserting. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

describe('startStdioServer close hook', () => {
  test('a dead client (stdin EOF) fires the hook exactly once', async () => {
    const stdin = new PassThrough();
    const fired = gate();
    let calls = 0;
    const server = await startStdioServer([], {
      stdin,
      stdout: sink(),
      onClose: () => {
        calls += 1;
        fired.open();
      },
    });
    expect(server.isConnected()).toBe(true);

    stdin.end(); // the client's write end goes away

    await fired.wait;
    await settle(); // 'close' follows 'end' — the guard must hold
    expect(calls).toBe(1);
    expect(server.isConnected()).toBe(false);
  });

  test('an explicit close fires the same hook, and EOF after it does not repeat', async () => {
    const stdin = new PassThrough();
    let calls = 0;
    const server = await startStdioServer([], {
      stdin,
      stdout: sink(),
      onClose: () => {
        calls += 1;
      },
    });

    await server.close();
    expect(calls).toBe(1);

    stdin.end();
    await settle();
    expect(calls).toBe(1);
  });

  test('EOF closes the server even with no hook wired', async () => {
    const stdin = new PassThrough();
    const server = await startStdioServer([], { stdin, stdout: sink() });

    stdin.end();

    await settle();
    expect(server.isConnected()).toBe(false);
  });

  test('client death ends the active run (main.ts wiring)', async () => {
    _resetCounter();
    const dir = await mkdtemp(join(tmpdir(), 'ui-dbg-eof-test-'));
    const runManager = new SessionManager<Session>();
    const service = new DebugService({
      manager: runManager,
      config: CONFIG,
      cwd: CWD,
      build: fakeBuilder(dir),
      now: () => NOW,
    });
    const stdin = new PassThrough();
    const ended = gate();
    await startStdioServer(outerTools(service), {
      stdin,
      stdout: sink(),
      onClose: () => {
        void service
          .endActive()
          .catch(() => undefined)
          .finally(ended.open);
      },
    });

    await service.start({ target: 'web', goal: 'client dies mid-run' });
    expect(runManager.has(CWD)).toBe(true);

    stdin.end(); // client process dies

    await ended.wait;
    expect(runManager.has(CWD)).toBe(false);
    await rm(dir, { recursive: true, force: true });
  });
});
