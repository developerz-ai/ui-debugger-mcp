/**
 * Guard for the Android integration suite's skip accounting
 * (`./android-adapter.integration.test.ts`).
 *
 * `bin/check` only needs a zero exit, so two regressions stay fully green:
 *
 *  1. Per-test `if (skipIf()) return;` guards — bun counts all 8 tests as
 *     PASSES on a gate-off box, which is the misleading accounting the suite
 *     moved away from (registration-time `describe.skip` instead).
 *  2. An `adb` probe that runs at registration time with the gate off — a
 *     disabled run would perform a real-device operation.
 *
 * This file pins both by spawning `bun test` on that suite with a stub `adb`
 * FIRST on PATH (the stub logs its invocation to a probe log, then exits 1 =
 * no device):
 *
 *  - gate off (`ANDROID_INTEGRATION_TESTS` unset) → exit 0, every test
 *    reported skipped, probe log ABSENT — no probe, no device operation.
 *  - gate on, stub `adb` exits 1 → exit 0, every test still skipped, probe
 *    log PRESENT — the probe ran and its failure still degrades to a skip,
 *    never to a failed gate.
 *
 * The guard never asserts enabled real-device results: the enabled path
 * belongs to a developer's machine with a real emulator attached.
 *
 * Accounting note: bun counts the suite's beforeAll/afterAll hooks as two
 * extra `(unnamed)` skipped entries, so a skipped run's summary reads
 * `10 skip` for the 8 tests. The assertions below pin the 8 named tests and
 * the 0 pass / 0 fail totals — not the hook entries.
 */

import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const TARGET = 'src/adapters/android/android-adapter.integration.test.ts';

/** The eight integration tests the suite must account for — never as passes. */
const SUITE_TESTS = [
  'screenshot returns non-empty Uint8Array',
  'readState returns a non-empty tree',
  'readState with limit=1 returns at most one node',
  'console drains logcat without throwing',
  'network always throws AdapterError (no ADB channel)',
  'waitFor networkIdle throws AdapterError',
  'find returns null for a query that matches nothing',
  'close in attach mode is a no-op (does not throw)',
];

/** Every stub `adb` execution appends a line here — its presence IS the probe. */
const PROBE_LOG_VAR = 'ANDROID_GATE_ADB_PROBE_LOG';

/** Stub `adb`: records its invocation, then reports no device (exit 1). */
const STUB_ADB = ['#!/bin/sh', `printf 'adb devices\\n' >> "$${PROBE_LOG_VAR}"`, 'exit 1', ''].join(
  '\n',
);

// ---------------------------------------------------------------------------
// Child + temp-dir bookkeeping (house pattern: isolation.test.ts)
// ---------------------------------------------------------------------------

/** Live child processes spawned by a case — awaited/cleaned after each one. */
let children: ReturnType<typeof Bun.spawn>[] = [];
let tempDirs: string[] = [];

afterEach(async () => {
  for (const child of children) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  children = [];
  const dirs = tempDirs;
  tempDirs = [];
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Child env: the outer env with every android knob stripped (hermetic even
 * when the guard itself runs under `ANDROID_INTEGRATION_TESTS=1`), the stub
 * `adb` shadowing any real one, and the probe log wired for the stub.
 */
function childEnv(opts: {
  gateOn: boolean;
  stubDir: string;
  probeLog: string;
}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === 'ANDROID_INTEGRATION_TESTS' || key === 'ANDROID_SERIAL' || key === PROBE_LOG_VAR)
      continue;
    env[key] = value;
  }
  if (opts.gateOn) env.ANDROID_INTEGRATION_TESTS = '1';
  env.PATH = [opts.stubDir, env.PATH].filter((part) => part !== '').join(':');
  env[PROBE_LOG_VAR] = opts.probeLog;
  return env;
}

/** A temp dir holding the stub `adb` plus the probe-log path (afterEach cleans). */
async function makeStub(): Promise<{ stubDir: string; probeLog: string }> {
  const stubDir = await mkdtemp(join(tmpdir(), 'android-gate-adb-'));
  tempDirs.push(stubDir);
  const adb = join(stubDir, 'adb');
  await writeFile(adb, STUB_ADB);
  await chmod(adb, 0o755);
  return { stubDir, probeLog: join(stubDir, 'probe.log') };
}

interface Outcome {
  exitCode: number;
  /** bun summary counts — `-1` means "summary line never parsed", which fails loud. */
  pass: number;
  fail: number;
  /** Names of every test bun reported as `(skip)` (hook `(unnamed)`s excluded). */
  skippedNames: string[];
  /** Full combined child output, for failure messages and sanity checks. */
  report: string;
  probeLog: string;
}

/** Parse a bun test run: summary counts + the name of every skipped test. */
function parseOutcome(stdout: string, stderr: string): Omit<Outcome, 'exitCode' | 'probeLog'> {
  const outcome: Omit<Outcome, 'exitCode' | 'probeLog'> = {
    pass: -1,
    fail: -1,
    skippedNames: [],
    report: `${stdout}\n${stderr}`,
  };
  for (const line of outcome.report.split('\n')) {
    const text = line.trim();
    const summary = /^(\d+) (pass|fail)$/.exec(text);
    if (summary) {
      const count = Number.parseInt(summary[1] ?? '', 10);
      if (summary[2] === 'pass') outcome.pass = count;
      else outcome.fail = count;
      continue;
    }
    const result = /^\((pass|fail|skip|todo)\) (.+)$/.exec(text);
    if (result?.[1] !== 'skip') continue;
    // Names can carry a bun duration suffix ("(unnamed) [0.01ms]") — strip it.
    const name = ((result[2] ?? '').split(' > ').pop() ?? '').replace(/ \[[\d.]+(?:ms|s)\]$/, '');
    if (name !== '' && name !== '(unnamed)') outcome.skippedNames.push(name);
  }
  return outcome;
}

/**
 * Run the integration suite the way the gate does — `bun test <file>` from
 * the repo root, gate env controlled, stub `adb` first on PATH — and read
 * back its full outcome.
 */
async function runSuite(opts: { gateOn: boolean }): Promise<Outcome> {
  const { stubDir, probeLog } = await makeStub();
  const proc = Bun.spawn({
    cmd: [process.execPath, 'test', TARGET],
    cwd: REPO_ROOT,
    env: childEnv({ gateOn: opts.gateOn, stubDir, probeLog }),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  children.push(proc);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ...parseOutcome(stdout, stderr), exitCode, probeLog };
}

/** The skip accounting both cases must show: 0 passes, 0 failures, 8 skips. */
function expectSkippedAccounting(run: Outcome): void {
  expect(run.report).toContain(TARGET); // the child loaded the suite at all
  expect(run.exitCode).toBe(0); // the leg `bin/check` relies on
  expect(run.pass).toBe(0); // the false-pass regression this file exists to pin
  expect(run.fail).toBe(0); // a missing device must skip, not fail, the gate
  // Same multiset of names — order-insensitive, so a renamed/deleted/duplicated
  // test or a test silently passing shows up here.
  expect([...run.skippedNames].sort()).toEqual([...SUITE_TESTS].sort());
}

test('gate off: all 8 tests skip, 0 pass, and NO adb probe runs', async () => {
  const run = await runSuite({ gateOn: false });

  expectSkippedAccounting(run);
  expect(existsSync(run.probeLog)).toBe(false); // stub never executed — no probe
}, 30_000);

test('gate on, stub adb exits 1: probe runs and its failure still skips', async () => {
  const run = await runSuite({ gateOn: true });

  expectSkippedAccounting(run);
  expect(existsSync(run.probeLog)).toBe(true); // the probe reached the stub
  expect((await readFile(run.probeLog, 'utf8')).trim()).not.toBe('');
}, 30_000);
