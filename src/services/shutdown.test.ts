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
  const warnings: string[] = [];
  const shutdown = createShutdown({
    endActive: async () => {
      throw new Error('adapter close blew up');
    },
    exit: (code) => exits.push(code),
    timeoutMs: 20,
    warn: (line) => warnings.push(line),
  });

  shutdown(0);
  await tick(60); // the deadline would have fired here had the timer not been cleared

  expect(exits).toEqual([0]);
  // The failure is said out loud, once — and the cleared deadline adds no second line.
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain('adapter close blew up');
});

test('a second trigger mid-teardown never exits ahead of the first teardown', async () => {
  // A dying client closes stdin AND sends SIGTERM. `endActive` answers the second
  // call at once (the slot is already free), so a per-invocation guard exited the
  // process while the first teardown was still closing the browser.
  const exits: number[] = [];
  const closing = Promise.withResolvers<void>();
  let calls = 0;
  const shutdown = createShutdown({
    endActive: () => (calls++ === 0 ? closing.promise : Promise.resolve()),
    exit: (code) => exits.push(code),
    timeoutMs: 1_000,
  });

  shutdown(0); // stdin EOF
  shutdown(130); // then the signal
  await tick(10);
  expect(exits).toEqual([]); // the first teardown is still in flight
  expect(calls).toBe(1);

  closing.resolve();
  await tick(10);
  expect(exits).toEqual([0]); // once, with the first trigger's code
});
