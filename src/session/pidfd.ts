import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, realpathSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { WorkspaceError } from '../errors.js';

/**
 * Absolute system locations for the pidfd helper, probed in order.
 *
 * `PATH` is attacker-controlled for a CLI run inside a project: a checked-in
 * `python3` in the current directory would otherwise run with the CLI user's
 * privileges on `stop`. Only these trusted locations are ever executed.
 */
const PYTHON_CANDIDATES = ['/usr/bin/python3', '/bin/python3'];

/** A helper process that speaks the pidfd readiness/signal protocol. */
export type PidfdHelper = ChildProcess & {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
};

/** The exact command and argv production uses to launch the helper. */
export type HelperInvocation = { command: string; args: string[] };

/** Seam for tests: production always launches a trusted, probed interpreter. */
export type HelperLauncher = (invocation: HelperInvocation) => PidfdHelper;

/**
 * Resolve a real interpreter that actually has the pidfd APIs, without ever
 * consulting `PATH`. An older Python at the first trusted path is skipped in
 * favour of a newer one at the next path.
 */
function trustedPython(): string {
  const probe =
    'import os, signal, sys\nsys.exit(0 if hasattr(os, "pidfd_open") and hasattr(signal, "pidfd_send_signal") else 1)';
  let lastFailure = '';
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      const real = realpathSync(candidate);
      const stat = statSync(real);
      if (!real.startsWith('/') || !stat.isFile() || (stat.mode & 0o111) === 0) continue;
      const result = spawnSync(candidate, ['-I', '-B', '-c', probe], {
        encoding: 'utf8',
        timeout: 2000,
      });
      if (result.error) throw result.error;
      if (result.status === 0) return candidate;
      lastFailure = result.stderr.trim() || `${candidate} lacks the pidfd APIs`;
    } catch (err) {
      lastFailure = err instanceof Error ? err.message : String(err);
      // Try the next trusted location.
    }
  }
  throw new WorkspaceError(
    `Cannot safely stop a process: no Python 3 with pidfd support at ${PYTHON_CANDIDATES.join(' or ')}. ${lastFailure}`.trim(),
  );
}

/** Hold a Linux pidfd across the state update; never signal a recycled numeric PID. */
export async function openPidfd(
  pid: number,
  startTicks: number | null,
  launch: HelperLauncher = (invocation) =>
    spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'] }),
): Promise<{ signal(): Promise<void>; close(): void }> {
  if (process.platform !== 'linux' || startTicks === null) {
    throw new WorkspaceError(
      'Cannot safely stop an unverifiable process: Linux pidfd and a recorded identity are required.',
    );
  }
  const script = `import os, signal, sys\npid, ticks = map(int, sys.argv[1:])\ntry:\n fd = os.pidfd_open(pid)\n with open('/proc/%d/stat' % pid) as f: stat = f.read()\n if int(stat[stat.rfind(')')+1:].split()[19]) != ticks: raise RuntimeError('process identity changed')\n print('ready', flush=True)\n if sys.stdin.readline() == 'signal\\n': signal.pidfd_send_signal(fd, signal.SIGTERM)\n os.close(fd)\nexcept Exception as e:\n print(str(e), file=sys.stderr, flush=True)\n sys.exit(1)\n`;
  // One argv builder for production and tests: the injected launcher sees the
  // real `-I` isolation flag, so a test fails if the flag is ever dropped.
  const invocation: HelperInvocation = {
    command: trustedPython(),
    args: ['-I', '-B', '-c', script, String(pid), String(startTicks)],
  };
  const child = launch(invocation);
  let error = '';
  let inputError: Error | undefined;
  child.stdin.on('error', (err: Error) => {
    inputError = err;
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    error += chunk;
  });
  const exit = new Promise<number | null>((resolve) => {
    child.on('error', (err) => {
      error += err.message;
      resolve(null);
    });
    child.on('close', resolve);
  });
  const lines = createInterface({ input: child.stdout });
  const ready = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 2000);
    const finish = (value: boolean) => {
      clearTimeout(timer);
      resolve(value);
    };
    lines.once('line', (line) => finish(line === 'ready'));
    void exit.then(() => finish(false));
  });
  if (!ready) {
    // A helper that never answers must not wedge `stop`: kill it, then bound
    // the close wait (Bun may delay the close event past the helper's exit).
    child.kill('SIGKILL');
    await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 200))]);
    lines.close();
    throw new WorkspaceError(`Cannot safely open pidfd for ${pid}: ${error.trim()}`);
  }
  return {
    async signal() {
      child.stdin.end('signal\n');
      const code = await exit;
      if (inputError || code !== 0)
        throw new WorkspaceError(
          `Cannot signal pidfd for ${pid}: ${inputError?.message ?? error.trim()}`,
        );
    },
    close() {
      child.stdin.end();
    },
  };
}
