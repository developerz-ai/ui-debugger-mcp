import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const workflow = readFileSync(join(import.meta.dirname, '../.github/workflows/ci.yml'), 'utf8');
// Execute the real block, including comments and blanks, stopping at YAML's
// next outer key/comment. Do not maintain a second copy of the retry loop.
const block = workflow.match(
  /^      - name: install chromium\n        run: \|\n((?: {10}[^\n]*\n|\n)+)/m,
);
expect(block).not.toBeNull();
const install = (block?.[1] ?? '').replace(/^ {10}/gm, '');
const timeoutCall =
  'timeout --kill-after=30 300 node node_modules/playwright-core/cli.js install chromium';
const finalError = '::error::chromium install failed after 3 attempts — see output above';

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
        /^  if (timeout[^\n]+); then\n([\s\S]*?)  else\n    rc=\$\?\n  fi$/m,
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
