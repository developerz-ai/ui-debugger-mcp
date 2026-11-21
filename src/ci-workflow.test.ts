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
    expect(step.raw).not.toMatch(/^ {8}continue-on-error:\s*true\s*$/m);
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
