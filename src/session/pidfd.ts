import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WorkspaceError } from '../errors.js';

/** Hold a Linux pidfd across the state update; never signal a recycled numeric PID. */
export async function openPidfd(
  pid: number,
  startTicks: number | null,
): Promise<{ signal(): Promise<void>; close(): void }> {
  if (process.platform !== 'linux' || startTicks === null) {
    throw new WorkspaceError(
      'Cannot safely stop an unverifiable process: Linux pidfd and a recorded identity are required.',
    );
  }
  const script = `import os, signal, sys\npid, ticks = map(int, sys.argv[1:])\ntry:\n fd = os.pidfd_open(pid)\n with open('/proc/%d/stat' % pid) as f: stat = f.read()\n if int(stat[stat.rfind(')')+1:].split()[19]) != ticks: raise RuntimeError('process identity changed')\n print('ready', flush=True)\n if sys.stdin.readline() == 'signal\\n': signal.pidfd_send_signal(fd, signal.SIGTERM)\n os.close(fd)\nexcept Exception as e:\n print(str(e), file=sys.stderr, flush=True)\n sys.exit(1)\n`;
  const child = spawn('python3', ['-I', '-c', script, String(pid), String(startTicks)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
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
    child.kill('SIGKILL');
    await exit;
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
