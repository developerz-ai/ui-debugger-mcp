import { expect, test } from 'bun:test';
import { ExecTimeoutError } from '../../errors.js';
import { desktopEnv, isEnoent, makeExec } from './proc.js';

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
