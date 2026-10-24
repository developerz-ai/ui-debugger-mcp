/**
 * `bin/setup` — the script that provisions a fresh checkout — has a contract
 * worth pinning: the real Chromium launch verification must stay in place
 * (a failing launch still fails setup), and the shared-library check must run
 * BEFORE it (so a missing system library is named, not discovered as a mystery
 * inside the launch).
 *
 * These assertions read the script's TEXT and never execute it: running
 * `bin/setup` would download browsers and install system packages.
 *
 * Every lookup runs against the script with its COMMENTS stripped. A comment
 * that merely mentions `src/cli/chromium-libs.ts` must not be able to satisfy
 * an ordering or presence assertion — only a real command line can.
 */

import { expect, test } from 'bun:test';
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
