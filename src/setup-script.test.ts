/**
 * `bin/setup` — the script that provisions a fresh checkout — has a contract
 * worth pinning: the real Chromium launch verification must stay in place
 * (a failing launch still fails setup), and the shared-library check must run
 * BEFORE it (so a missing system library is named, not discovered as a mystery
 * inside the launch).
 *
 * Provisioning is never executed: only extracted install commands run under
 * bash with a stubbed bun. Running all of `bin/setup` would provision browsers.
 *
 * Every lookup runs against the script with its COMMENTS stripped. A comment
 * that merely mentions `src/cli/chromium-libs.ts` must not be able to satisfy
 * an ordering or presence assertion — only a real command line can.
 */

import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

const setupScript = readFileSync(join(REPO_ROOT, 'bin/setup'), 'utf8');

/**
 * The script's executable lines: comments removed, blank lines dropped.
 * Line numbers in this array are 1-based indices into the ORIGINAL script
 * (comments keep their slot), so an index here still locates the real line.
 */
const codeLines = setupScript
  .split('\n')
  .map((line, index) => ({ text: line.trim(), line: index + 1 }))
  .filter((entry) => entry.text.length > 0 && !entry.text.startsWith('#'));

/** 1-based line number of the first CODE line containing `needle`, or -1. */
function codeLineOf(needle: string): number {
  const hit = codeLines.find((entry) => entry.text.includes(needle));
  return hit ? hit.line : -1;
}

function installCommands(script: string): { root: string; fixture: string } {
  const rootSection =
    script
      .split('echo "==> bun install (root)"')[1]
      ?.split('echo "==> dummy/web fixture (install + build)"')[0] ?? '';
  const fixtureSection =
    script
      .split('echo "==> dummy/web fixture (install + build)"')[1]
      ?.split('# Resolve the cache dir')[0] ?? '';
  const extract = (section: string): string => {
    const commands = section
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^bun install(?:\s|$)/.test(line));
    expect(commands).toHaveLength(1);
    return commands[0] ?? '';
  };
  return { root: extract(rootSection), fixture: extract(fixtureSection) };
}

function executeInstall(command: string, ci: string | undefined, status = 0) {
  // No inherited environment or PATH: the shell function is the only bun.
  // The completion marker proves errexit stops execution on install failure.
  const result = spawnSync(
    '/bin/bash',
    [
      '-euo',
      'pipefail',
      '-c',
      `
    bun() { printf '<%s>\\n' "$@"; return ${status}; }
    ${command}
    printf 'completed\\n'
  `,
    ],
    {
      env: ci === undefined ? {} : { CI: ci },
      encoding: 'utf8',
      timeout: 2_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  return { status: result.status, output: result.stdout.trim().split('\n') };
}

function assertInstallPolicy(command: string, ci: string | undefined) {
  const result = executeInstall(command, ci);
  expect(result.status).toBe(0);
  expect(result.output).toEqual(
    ci ? ['<install>', '<--frozen-lockfile>', 'completed'] : ['<install>', 'completed'],
  );
}

for (const ci of [undefined, '', 'true', 'false']) {
  for (const kind of ['root', 'fixture'] as const) {
    test(`${kind} install arguments with CI=${JSON.stringify(ci)}`, () => {
      assertInstallPolicy(installCommands(setupScript)[kind], ci);
    });

    test(`${kind} install failure propagates with CI=${JSON.stringify(ci)}`, () => {
      const result = executeInstall(installCommands(setupScript)[kind], ci, 23);
      expect(result.status).toBe(23);
      expect(result.output).not.toContain('completed');
    });
  }
}

test('root flag-removal mutation fails independently of the intact fixture', () => {
  const commands = installCommands(setupScript);
  const mutated = commands.root.replace('${CI:+--frozen-lockfile}', '');
  expect(mutated).not.toBe(commands.root);
  assertInstallPolicy(commands.fixture, 'true');
  expect(() => assertInstallPolicy(mutated, 'true')).toThrow();
});

for (const replacement of ['', '# bun install ${CI:+--frozen-lockfile}']) {
  test(`root extraction rejects ${JSON.stringify(replacement)} (mutation)`, () => {
    const mutated = setupScript.replace(/^bun install[^\n]*$/m, replacement);
    expect(mutated).not.toBe(setupScript);
    expect(() => installCommands(mutated)).toThrow();
  });
}

test('the launch verification still launches chromium headless', () => {
  expect(setupScript).toContain('chromium.launch({ headless: true })');
});

test('the launch verification is still the final gate', () => {
  // The launch check is the LAST thing the script does — a failing launch
  // must still abort setup, with nothing after it masking the exit code.
  const launchLine = codeLineOf('verify chromium launches');
  const readyLine = codeLineOf('==> ready.');

  expect(launchLine).toBeGreaterThan(0);
  expect(readyLine).toBeGreaterThan(launchLine);
});

test("the launch invocation propagates failure — it can't be made to swallow one", () => {
  // `|| true` (or a `&&` chain) appended to the launch command would let setup
  // succeed after a failed launch while every ordering assertion still passes.
  // The invocation spans several lines (`bun -e '…'` with an embedded script),
  // so EVERY code line between the launch echo and the ready message is
  // checked — not just the first.
  const launchLine = codeLineOf('verify chromium launches');
  const readyLine = codeLineOf('==> ready.');
  expect(launchLine).toBeGreaterThan(0);
  expect(readyLine).toBeGreaterThan(launchLine);

  const invocationLines = codeLines.filter(
    (entry) => entry.line > launchLine && entry.line < readyLine,
  );
  expect(invocationLines.length).toBeGreaterThan(0);
  for (const entry of invocationLines) {
    expect(entry.text).not.toContain('||');
    expect(entry.text).not.toContain('&&');
  }
});

test('the launch payload itself exits non-zero when the launch throws', () => {
  // The in-script `.catch` handler is what turns a failed launch into a
  // non-zero exit — without it an unhandled rejection could be absorbed by an
  // outer runner. Together with `set -e` (asserted above) and the no-`||`
  // rule, a failed launch cannot reach the ready message.
  expect(codeLineOf("bun -e '(async () => {")).toBeGreaterThan(0);
  expect(codeLineOf('.catch((err) =>')).toBeGreaterThan(0);
  expect(codeLineOf('process.exit(1)')).toBeGreaterThan(0);
});

test('the library check is actually invoked, not merely mentioned', () => {
  // The invocation is a CODE line — a comment naming the module does not count.
  expect(codeLineOf('bun src/cli/chromium-libs.ts "$CACHE_DIR"')).toBeGreaterThan(0);
});

test('the library check runs before the launch verification', () => {
  const libsLine = codeLineOf('bun src/cli/chromium-libs.ts');
  const launchLine = codeLineOf('verify chromium launches');

  expect(libsLine).toBeGreaterThan(0);
  expect(launchLine).toBeGreaterThan(0);
  expect(libsLine).toBeLessThan(launchLine);
});

test('the library check is invoked with the resolved cache dir', () => {
  expect(setupScript).toContain('bun src/cli/chromium-libs.ts "$CACHE_DIR"');
});

test('a failing library check aborts the script before the launch check', () => {
  // `set -e` is what turns the check's non-zero exit into an aborted setup.
  // Without it the launch check would run against a browser that cannot start.
  expect(codeLineOf('set -euo pipefail')).toBeGreaterThan(0);

  // The invocation is a bare command — not `|| true` / `|| exit 0`, which
  // would swallow the failure and let the launch check run anyway.
  const invocation = codeLines.find((entry) => entry.text.includes('bun src/cli/chromium-libs.ts'));
  expect(invocation).toBeDefined();
  expect(invocation?.text).not.toContain('||');
  expect(invocation?.text).not.toContain('&&');
});

test('the script no longer claims apt / install-deps never runs', () => {
  // The claim was true once; the library check now installs missing system
  // libraries when it can. A stale comment would mislead the next reader.
  expect(setupScript).not.toContain('NO apt / install-deps on any path');
  expect(setupScript).not.toContain('the system libs are already on the stock');
});
