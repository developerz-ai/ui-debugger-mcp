import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExecTimeoutError } from '../../errors.js';
import { desktopEnv, isEnoent, makeExec, terminateGroup } from './proc.js';

/** Patch `process.env` for one assertion block, always restoring afterwards. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- desktopEnv ---------------------------------------------------------------

test('desktopEnv overrides DISPLAY and drops inherited WAYLAND_DISPLAY for an explicit display', () => {
  withEnv({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, () => {
    const env = desktopEnv(':99');
    expect(env.DISPLAY).toBe(':99');
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
    // The parent process env stays untouched.
    expect(process.env.WAYLAND_DISPLAY).toBe('wayland-0');
    expect(process.env.DISPLAY).toBe(':0');
  });
});

test('desktopEnv inherits the env unchanged when no display is configured', () => {
  withEnv({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, () => {
    const env = desktopEnv();
    expect(env.DISPLAY).toBe(':0');
    expect(env.WAYLAND_DISPLAY).toBe('wayland-0');
  });
});

// --- makeExec (real subprocesses, tiny caps) ----------------------------------

test('makeExec resolves stdout, running the child in the bound env', async () => {
  const exec = makeExec(desktopEnv(':99'));
  expect(await exec('sh', ['-c', 'printf %s "$DISPLAY"'])).toBe(':99');
});

test('makeExec kills a wedged tool at its cap and throws ExecTimeoutError', async () => {
  const exec = makeExec(process.env, 100);
  const started = Date.now();
  const promise = exec('sleep', ['30']);
  await expect(promise).rejects.toThrow(ExecTimeoutError);
  await expect(promise).rejects.toThrow(/`sleep` timed out after 100ms \(SIGKILLed/);
  expect(Date.now() - started).toBeLessThan(5_000); // capped, not parked on the child
});

test('makeExec passes a non-zero exit through raw so callers can triage stderr', async () => {
  const exec = makeExec(process.env);
  const error = await exec('sh', ['-c', 'echo boom >&2; exit 1']).catch((e: unknown) => e);
  // `xdotool search` triage reads `stderr` off the real execFile error — never swallow it.
  expect(error).not.toBeInstanceOf(ExecTimeoutError);
  expect((error as { stderr?: string }).stderr).toBe('boom\n');
});

test('makeExec passes a missing binary through raw as ENOENT', async () => {
  const exec = makeExec(process.env);
  const error = await exec('uidbg-no-such-binary', []).catch((e: unknown) => e);
  expect(error).not.toBeInstanceOf(ExecTimeoutError);
  expect(isEnoent(error)).toBe(true);
});

// --- makeExec with an absolute deadline ---------------------------------------

test('makeExec kills a wedged tool at the DEADLINE, not at its own default cap', async () => {
  // The adapter's own cap is 10s; the enclosing budget is 300ms. A tool that wedges
  // must be cut at the deadline — otherwise the run's remaining wall-clock is gone.
  const exec = makeExec(process.env);
  const started = Date.now();
  const promise = exec('sleep', ['30'], { deadline: Date.now() + 300 });
  await expect(promise).rejects.toThrow(ExecTimeoutError);
  await expect(promise).rejects.toThrow(/`sleep` timed out after 300ms \(SIGKILLed/);
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(5_000); // cut at the deadline, not parked on the child
});

test('makeExec rejects a call whose deadline has already passed instead of running it', async () => {
  // A spent budget must not buy another subprocess: the call fails loud at once.
  const exec = makeExec(process.env);
  const promise = exec('sh', ['-c', 'printf late'], { deadline: Date.now() - 1 });
  await expect(promise).rejects.toThrow(ExecTimeoutError);
  await expect(promise).rejects.toThrow(/deadline .* has already passed/);
});

test('makeExec rejects a call that resolves after its deadline instead of returning stdout', async () => {
  // The child finishes inside its own cap, but only AFTER the deadline it was given:
  // a result read past the budget is stale, so it must not resolve as a success.
  const exec = makeExec(process.env, 5_000);
  const promise = exec('sh', ['-c', 'sleep 0.2; printf late'], { deadline: Date.now() + 50 });
  await expect(promise).rejects.toThrow(ExecTimeoutError);
  await expect(promise).rejects.toThrow(/`sh` timed out after 50ms|resolved after its deadline/);
});

test('makeExec resolves normally when the deadline is still in the future', async () => {
  const exec = makeExec(process.env);
  expect(await exec('sh', ['-c', 'printf ok'], { deadline: Date.now() + 5_000 })).toBe('ok');
});

// --- terminateGroup (real detached process groups) ----------------------------

/** True while `pid` is alive (`kill -0`); false once it's gone (ESRCH). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Spawn a detached `/bin/sh` group running `script`, and hand back its pid. */
function spawnGroup(script: string): number {
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) throw new Error('test setup: the shell did not spawn');
  return pid;
}

test('terminateGroup returns once a well-behaved group is actually dead', async () => {
  const pid = spawnGroup('sleep 30');
  await terminateGroup(pid, 2_000);
  expect(isAlive(pid)).toBe(false); // resolved *after* death, not merely after the signal
});

test('terminateGroup escalates to SIGKILL when the group ignores SIGTERM', async () => {
  // An app with a SIGTERM handler ("save changes?") survives the polite signal; without
  // the escalation it outlives close() forever, holding its X/profile locks.
  const dir = await mkdtemp(join(tmpdir(), 'uidbg-proc-'));
  const ready = join(dir, 'ready');
  const pid = spawnGroup(`trap '' TERM; : > ${JSON.stringify(ready)}; while :; do sleep 0.1; done`);
  const armed = Date.now() + 5_000;
  while (!existsSync(ready)) {
    expect(Date.now()).toBeLessThan(armed); // the trap was never installed
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const started = Date.now();
  await terminateGroup(pid, 200);
  expect(Date.now() - started).toBeGreaterThanOrEqual(200); // it did wait out the grace
  const deadline = Date.now() + 3_000;
  while (isAlive(pid)) {
    expect(Date.now()).toBeLessThan(deadline); // survived the SIGKILL escalation
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await rm(dir, { recursive: true, force: true });
});

test('terminateGroup on an already-dead group is a no-op', async () => {
  const pid = spawnGroup('exit 0');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await expect(terminateGroup(pid, 200)).resolves.toBeUndefined();
});
