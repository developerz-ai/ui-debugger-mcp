/**
 * Bounded graceful shutdown: a clean teardown exits at once, a wedged one exits
 * anyway — because `ui-debugger-mcp stop` only ever signals a run once.
 */

import { expect, test } from 'bun:test';
import { createShutdown } from './shutdown.js';

/** Resolve after `ms` — let the shutdown deadline elapse. */
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a clean teardown exits with the given code as soon as it finishes', async () => {
  const exits: number[] = [];
  let ended = false;
  const shutdown = createShutdown({
    endActive: async () => {
      ended = true;
    },
    exit: (code) => exits.push(code),
    timeoutMs: 1_000,
  });

  shutdown(130);
  await tick(10);

  expect(ended).toBe(true);
  expect(exits).toEqual([130]);
});

test('a teardown that never returns still exits once the deadline passes', async () => {
  // The failure this guards: `stop` writes `status: 'stopped'` BEFORE signalling
  // and sends exactly one SIGTERM, so a server that never exits can no longer be
  // stopped from the CLI (a second `stop` sees a terminal status and refuses to
  // signal) — Chrome keeps the profile lock and the project is unstartable.
  const exits: number[] = [];
  const warnings: string[] = [];
  const shutdown = createShutdown({
    endActive: () => new Promise<void>(() => undefined), // a wedged CDP/adb call
    exit: (code) => exits.push(code),
    timeoutMs: 20,
    warn: (line) => warnings.push(line),
  });

  shutdown(0);
  expect(exits).toEqual([]); // it does wait for the graceful path first

  await tick(60);
  expect(exits).toEqual([0]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('did not finish');
});

test('a failing teardown still exits, and exits exactly once', async () => {
  const exits: number[] = [];
  const shutdown = createShutdown({
    endActive: async () => {
      throw new Error('adapter close blew up');
    },
    exit: (code) => exits.push(code),
    timeoutMs: 20,
  });

  shutdown(0);
  await tick(60); // the deadline would have fired here had the timer not been cleared

  expect(exits).toEqual([0]);
});
