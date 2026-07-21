/**
 * `main.ts` CLI dispatch — the entry point calls `process.exit`/`runHelp` on
 * every branch, so it can't be imported and driven in-process (that would kill
 * the test runner). Drive it as a real subprocess instead.
 */
import { expect, test } from 'bun:test';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');

test('an unknown subcommand prints usage and exits 1 instead of booting the server', async () => {
  const proc = Bun.spawn({
    cmd: ['bun', 'src/main.ts', 'stauts'],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // Start both reads before awaiting exit — usage goes to stdout, the error to stderr.
  const stdoutText = new Response(proc.stdout).text();
  const stderrText = new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  expect(exitCode).toBe(1);
  expect(await stderrText).toContain("unknown subcommand 'stauts'");
  // printUsage() must still run — a regression dropping it would otherwise pass.
  expect(await stdoutText).toContain('SUBCOMMANDS');
});

test('--help exits 0 without touching project config', async () => {
  const proc = Bun.spawn({
    cmd: ['bun', 'src/main.ts', '--help'],
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdoutText = new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  expect(exitCode).toBe(0);
  expect(await stdoutText).toContain('SUBCOMMANDS');
});
