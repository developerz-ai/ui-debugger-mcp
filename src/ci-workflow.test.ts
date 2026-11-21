import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');
// Execute the real block, including comments and blanks, stopping at YAML's
// next outer key/comment. Do not maintain a second copy of the retry loop.
const block = workflow.match(
  /^ {6}- name: install chromium\n {8}run: \|\n((?: {10}[^\n]*\n|\n)+)/m,
);
expect(block).not.toBeNull();
const install = (block?.[1] ?? '').replace(/^ {10}/gm, '');
const timeoutCall =
  'timeout --kill-after=30 300 node node_modules/playwright-core/cli.js install chromium';
const finalError = '::error::chromium install failed after 3 attempts — see output above';

const INTEGRATION_FILE = 'src/adapters/browser/browser-adapter.integration.test.ts';
const INTEGRATION_COMMAND = `bun test ${INTEGRATION_FILE}`;

/** The documented ceiling: docs/standards/README.md:49,54 (18m = 1080s). */
const DOCUMENTED_TIMEOUT_MINUTES = 18;
/** The stale value the merge-gate-owned workflow still carries. */
const STALE_TIMEOUT_MINUTES = 20;
/** 3 × 300s attempts + 20s + 40s backoff; ~30s for the rest of the job. */
const RETRY_BUDGET_SECONDS = 3 * 300 + 20 + 40;
const REST_OF_JOB_SECONDS = 30;

/**
 * The bun job's job-level `timeout-minutes`, parsed from the real workflow.
 *
 * Returns `null` when the job or its ceiling is absent: a missing ceiling is a
 * hang guard lost, never a value the guard silently accepts.
 */
function bunTimeoutMinutes(text: string): number | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => /^ {2}bun:\s*$/.test(line));
  if (start === -1) return null;
  const end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  const stop = end === -1 ? lines.length : end;
  for (const line of lines.slice(start + 1, stop)) {
    const match = line.match(/^ {4}timeout-minutes:\s*(\d+)\s*$/);
    if (match?.[1] !== undefined) return Number(match[1]);
  }
  return null;
}

/** True when the ceiling covers the full retry budget plus the rest of the job. */
function fitsRetryBudget(minutes: number | null): boolean {
  return minutes !== null && minutes * 60 >= RETRY_BUDGET_SECONDS + REST_OF_JOB_SECONDS;
}

/**
 * The protected workflow records its landed ceiling in the comment above the
 * scalar. While that comment still names 20, both the stale value and the
 * documented target pass; once it names 18, only 18 passes. Every other value,
 * including an absent ceiling, is drift or a lost hang guard.
 */
function acceptableBunTimeouts(text: string): number[] {
  return /^ {4}# 20 now exists/m.test(text)
    ? [STALE_TIMEOUT_MINUTES, DOCUMENTED_TIMEOUT_MINUTES]
    : [DOCUMENTED_TIMEOUT_MINUTES];
}

function assertBunTimeout(text: string): void {
  const minutes = bunTimeoutMinutes(text);
  expect(minutes, 'the bun job must declare a job-level timeout-minutes').not.toBeNull();
  if (minutes === null) return;
  expect(fitsRetryBudget(minutes), `${minutes}m must cover the 960s retry budget`).toBe(true);
  expect(acceptableBunTimeouts(text)).toContain(minutes);
}

/** Replace only the bun job's job-level ceiling, never a step-level one. */
function withCeiling(text: string, minutes: number | null): string {
  return text.replace(/^( {4}timeout-minutes:) \d+$/m, (line) =>
    minutes === null ? '' : line.replace(/\d+$/, String(minutes)),
  );
}

/** Flip the protected workflow's ceiling comment to the value its owner landed. */
function withCeilingComment(text: string, minutes: number): string {
  return text.replace(
    /^( {4}# )\d+( now exists)/m,
    (_line, prefix: string, suffix: string) => `${prefix}${minutes}${suffix}`,
  );
}

// Parse the job's step graph, not prose. Shell comments retain their leading
// `#` in a parsed `run:` line, so a commented-out integration command can never
// equal the exact executable command (the mutation test below pins this).
interface WorkflowStep {
  name: string;
  run: string[];
  env: string[];
  raw: string;
}

function parseJobSteps(yaml: string, jobName: string): WorkflowStep[] {
  const lines = yaml.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^  ${jobName}:\\s*$`).test(line));
  expect(start).toBeGreaterThanOrEqual(0);
  const jobsEnd = lines.findIndex((line, i) => i > start && /^ {2}\S/.test(line));
  const end = jobsEnd === -1 ? lines.length : jobsEnd;
  const steps: WorkflowStep[] = [];
  for (let i = start + 1; i < end; i += 1) {
    if (!/^ {6}- name:/.test(lines[i] ?? '')) continue;
    const name = (lines[i] ?? '').replace(/^ {6}- name: ?/, '');
    const raw: string[] = [lines[i] ?? ''];
    const run: string[] = [];
    const env: string[] = [];
    let key = '';
    for (let j = i + 1; j < end; j += 1) {
      const line = lines[j] ?? '';
      if (/^ {6}- name:/.test(line) || /^ {4}\S/.test(line)) break;
      raw.push(line);
      const keyMatch = line.match(/^ {8}([\w-]+):(?:\s*(.*))?$/);
      if (keyMatch) {
        key = keyMatch[1] ?? '';
        if (key === 'run' && keyMatch[2] && keyMatch[2] !== '|') run.push(keyMatch[2]);
        continue;
      }
      if (/^ {10}\S/.test(line)) {
        if (key === 'run') run.push(line.trim());
        if (key === 'env') env.push(line.trim());
      }
    }
    steps.push({ name, run, env, raw: raw.join('\n') });
  }
  return steps;
}

function integrationStep(step: WorkflowStep): boolean {
  return step.run.some((line) => line.includes(INTEGRATION_FILE));
}

// Any step naming the integration file on an EXECUTABLE run line must run the
// suite by itself: exactly `bun test <file>`, no SKIP_BROWSER_INTEGRATION env,
// no `if:` gate, no non-fatal `continue-on-error: true`. A shell comment keeps
// its `#`, so it cannot pass the exact-command assertion.
//
// The protected workflow is written by a separate owner. This guard stays green
// while that step is absent, and fails as soon as a step claims to run the suite
// with a skip, a condition, a non-fatal setting or a commented-out command.
function assertIsolatedIntegrationSteps(steps: WorkflowStep[]) {
  const isolated = steps.filter(integrationStep);
  for (const step of isolated) {
    expect(step.run.some((line) => line === INTEGRATION_COMMAND)).toBe(true);
    expect(step.env.some((line) => line.startsWith('SKIP_BROWSER_INTEGRATION:'))).toBe(false);
    expect(step.raw).not.toMatch(/^ {8}if:/m);
    expect(step.raw).not.toMatch(/^ {8}continue-on-error:\s*true(?:\s+#.*)?\s*$/m);
  }
}

const timeoutStub = `#!/bin/bash
read -r -a statuses <<< "$STATUSES"
attempt=0
if [[ -f "$COUNT" ]]; then read -r attempt < "$COUNT"; fi
printf '%s\\n' "$((attempt + 1))" > "$COUNT"
printf 'timeout %s\\n' "$*" >> "$EVENTS"
exit "\${statuses[attempt]:-99}"
`;
const sleepStub = `#!/bin/bash
printf 'sleep %s\\n' "$*" >> "$EVENTS"
`;

function execute(body: string, statuses: number[], shell: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'ci-chromium-'));
  try {
    writeFileSync(join(dir, 'timeout'), timeoutStub, { mode: 0o755 });
    writeFileSync(join(dir, 'sleep'), sleepStub, { mode: 0o755 });
    writeFileSync(join(dir, 'install.sh'), body);
    writeFileSync(join(dir, 'events'), '');
    // No inherited PATH: neither node nor a real download/sleep can run.
    const result = spawnSync('/bin/bash', [...shell, join(dir, 'install.sh')], {
      cwd: dir,
      env: {
        PATH: dir,
        STATUSES: statuses.join(' '),
        COUNT: join(dir, 'count'),
        EVENTS: join(dir, 'events'),
      },
      encoding: 'utf8',
      timeout: 2_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe('');
    return {
      status: result.status,
      output: result.stdout.trim().split('\n'),
      events: readFileSync(join(dir, 'events'), 'utf8').trim().split('\n'),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CI integration coverage', () => {
  const steps = parseJobSteps(workflow, 'bun');

  test('the bun job keeps a bounded ceiling that fits the install retry budget', () => {
    expect(() => assertBunTimeout(workflow)).not.toThrow();
    const minutes = bunTimeoutMinutes(workflow);
    expect(minutes).not.toBeNull();
    if (minutes === null) return;
    expect(fitsRetryBudget(minutes)).toBe(true);
    expect(acceptableBunTimeouts(workflow)).toContain(minutes);
    expect(workflow).toMatch(/^ {4}timeout-minutes: \d+$/m);
  });

  test('the ceiling guard accepts 18 and rejects a wrong, starved or removed ceiling', () => {
    // Alignment: the workflow owner moves both its comment and scalar to 18.
    const aligned = withCeiling(withCeilingComment(workflow, 18), 18);
    expect(aligned).toMatch(/^ {4}# 18 now exists/m);
    expect(bunTimeoutMinutes(aligned)).toBe(18);
    expect(acceptableBunTimeouts(aligned)).toEqual([DOCUMENTED_TIMEOUT_MINUTES]);
    expect(() => assertBunTimeout(aligned)).not.toThrow();

    for (const minutes of [15, 16, 17, 19, 20, 21, 30]) {
      const mutant = withCeiling(aligned, minutes);
      expect(mutant).not.toBe(aligned);
      expect(bunTimeoutMinutes(mutant), String(minutes)).toBe(minutes);
      expect(() => assertBunTimeout(mutant), String(minutes)).toThrow();
    }
    const removed = withCeiling(aligned, null);
    expect(removed).not.toBe(aligned);
    expect(bunTimeoutMinutes(removed)).toBeNull();
    expect(() => assertBunTimeout(removed)).toThrow();

    // Today's stale workflow: the comment pins 20, target 18 is also accepted,
    // and every other ceiling (or none at all) still fails.
    const stale = withCeilingComment(workflow, STALE_TIMEOUT_MINUTES);
    expect(stale).toMatch(/^ {4}# 20 now exists/m);
    for (const minutes of [STALE_TIMEOUT_MINUTES, DOCUMENTED_TIMEOUT_MINUTES]) {
      const candidate = withCeiling(stale, minutes);
      expect(bunTimeoutMinutes(candidate), String(minutes)).toBe(minutes);
      expect(() => assertBunTimeout(candidate), String(minutes)).not.toThrow();
    }
    for (const minutes of [15, 16, 17, 19, 21]) {
      expect(() => assertBunTimeout(withCeiling(stale, minutes)), String(minutes)).toThrow();
    }
    expect(() => assertBunTimeout(withCeiling(stale, null))).toThrow();

    // The budget check is independent of the allowlist: 16m is exactly 960s,
    // leaving nothing for lint/typecheck/test/e2e, while 17m does fit.
    expect(fitsRetryBudget(16)).toBe(false);
    expect(fitsRetryBudget(17)).toBe(true);
    expect(fitsRetryBudget(null)).toBe(false);
  });

  test('the parallel test step keeps its browser skip and the public-tree env', () => {
    const parallel = steps.find((step) => step.name === 'test' && step.run.includes('bun test'));
    expect(parallel).toBeDefined();
    expect(parallel?.env).toContain('SKIP_BROWSER_INTEGRATION: "1"');
    expect(parallel?.env.some((line) => line.startsWith('PUBLIC_TREE_PRIVATE_WORDS:'))).toBe(true);
    expect(
      parallel?.env.some((line) => line.startsWith('PUBLIC_TREE_PRIVATE_WORDS_REQUIRED:')),
    ).toBe(true);
  });

  // Green on the current checkout, where the protected workflow has no isolated
  // step yet. Once the platform's owner adds it, the same assertions enforce its
  // executable, unconditional shape; the mutation test below pins that class.
  test('any isolated integration step is executable and unconditional', () => {
    expect(() => assertIsolatedIntegrationSteps(steps)).not.toThrow();
  });

  test('the guard accepts an isolated run and rejects weak forms of it', () => {
    const base = '        run: bun test src/adapters/browser/browser-adapter.integration.test.ts';
    const valid = parseJobSteps(
      `jobs:\n  bun:\n    steps:\n      - name: integration\n${base}\n`,
      'bun',
    );
    expect(integrationStep(valid[0] as WorkflowStep)).toBe(true);
    expect(() => assertIsolatedIntegrationSteps(valid)).not.toThrow();

    const mutants = {
      skipEnv: `${base}\n        env:\n          SKIP_BROWSER_INTEGRATION: "1"`,
      conditional: `        if: false\n${base}`,
      nonFatal: `${base}\n        continue-on-error: true`,
      commentedNonFatal: `${base}\n        continue-on-error: true # integration`,
      commented:
        '        run: |\n          # bun test src/adapters/browser/browser-adapter.integration.test.ts',
    };
    for (const [label, body] of Object.entries(mutants)) {
      const mutated = parseJobSteps(
        `jobs:\n  bun:\n    steps:\n      - name: integration\n${body}\n`,
        'bun',
      );
      expect(mutated).toHaveLength(1);
      expect(integrationStep(mutated[0] as WorkflowStep), label).toBe(true);
      expect(() => assertIsolatedIntegrationSteps(mutated), label).toThrow();
    }
  });
});

function warning(attempt: number, status: number): string {
  return status === 124 || status === 137
    ? `::warning::attempt ${attempt}/3 exceeded its 300s budget and was killed (exit ${status})`
    : `::warning::chromium install attempt ${attempt}/3 failed (exit ${status})`;
}

function assertRecovery(result: ReturnType<typeof execute>, status: number) {
  expect(result.status).toBe(0);
  expect(result.output).toEqual([warning(1, status), 'chromium installed (attempt 2/3)']);
  expect(result.events).toEqual([timeoutCall, 'sleep 20', timeoutCall]);
}

for (const shell of [['-e'], ['--noprofile', '--norc', '-e', '-o', 'pipefail']]) {
  describe(`Chromium install with bash ${shell.join(' ')}`, () => {
    test('success exits immediately without backoff', () => {
      const result = execute(install, [0], shell);
      expect(result.status).toBe(0);
      expect(result.output).toEqual(['chromium installed (attempt 1/3)']);
      expect(result.events).toEqual([timeoutCall]);
    });

    for (const status of [1, 124, 137]) {
      test(`exit ${status} recovers on the second attempt`, () => {
        assertRecovery(execute(install, [status, 0], shell), status);
      });

      test(`exit ${status} exhausts exactly three bounded attempts`, () => {
        const result = execute(install, [status, status, status], shell);
        expect(result.status).toBe(1);
        expect(result.output).toEqual([
          warning(1, status),
          warning(2, status),
          warning(3, status),
          finalError,
        ]);
        expect(result.events).toEqual([
          timeoutCall,
          'sleep 20',
          timeoutCall,
          'sleep 40',
          timeoutCall,
        ]);
      });
    }

    test('the last attempt can still succeed after different failures', () => {
      const result = execute(install, [7, 137, 0], shell);
      expect(result.status).toBe(0);
      expect(result.output).toEqual([
        warning(1, 7),
        warning(2, 137),
        'chromium installed (attempt 3/3)',
      ]);
      expect(result.events).toEqual([
        timeoutCall,
        'sleep 20',
        timeoutCall,
        'sleep 40',
        timeoutCall,
      ]);
    });

    test('the original bare-timeout mutation fails the recovery assertion', () => {
      const mutated = install.replace(
        /^ {2}if (timeout[^\n]+); then\n([\s\S]*?) {2}else\n {4}rc=\$\?\n {2}fi$/m,
        '  $1\n  rc=$?\n  if [ "$rc" -eq 0 ]; then\n$2  fi',
      );
      expect(mutated).not.toBe(install);
      const result = execute(mutated, [1, 0], shell);
      expect(result.status).toBe(1);
      expect(result.events).toEqual([timeoutCall]);
      expect(result.output).toEqual(['']);
      expect(() => assertRecovery(result, 1)).toThrow();
    });
  });
}
