import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Findings } from '../findings/schema.js';
import { ownerLockPath } from '../session/owner-lock.js';
import * as pidfd from '../session/pidfd.js';
import { openPidfd } from '../session/pidfd.js';
import { captureIdentity } from '../session/process-identity.js';
import type { StateFile } from '../session/state-file.js';
import { FileStatePort, readState, writeState } from '../session/state-file.js';
import { workspacePaths } from '../session/workspace.js';
import { runStatus, runStop } from './control.js';

let cwd: string;
const logs: string[] = [];
const origLog = console.log;
let priorExitCode: number | undefined;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'cli-'));
  logs.length = 0;
  priorExitCode = process.exitCode as number | undefined;
  console.log = (...args: unknown[]) => {
    logs.push(args.join(' '));
  };
});
afterEach(async () => {
  console.log = origLog;
  // `runStop` reports failure by setting `process.exitCode` — a process-global the
  // test runner reads at the end, so a leak here fails the whole suite with 0 fails.
  // `?? 0` matters: Bun ignores an `undefined` assignment, so restoring the (usually
  // undefined) prior value directly would leave the 1 in place.
  process.exitCode = priorExitCode ?? 0;
  await rm(cwd, { recursive: true, force: true });
});

/** Seed a state.json in the (default) workspace for this cwd. */
async function seedState(overrides: Partial<StateFile> = {}): Promise<string> {
  const ws = workspacePaths(cwd); // no config → DEFAULT_WORKSPACE under cwd
  await mkdir(ws.root, { recursive: true });
  const state: StateFile = {
    pid: 999_999_999, // a pid that is essentially never alive
    sessionId: '1700000000000-0001',
    target: 'web',
    goal: 'check the page',
    status: 'running',
    startedAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    sessionDir: join(ws.sessions, '1700000000000-0001'),
    identity: { startTicks: 1 },
    ...overrides,
  };
  await writeState(ws.stateJson, state);
  return ws.stateJson;
}

test('pidfd signals only its verified process and rejects a mismatched identity', async () => {
  if (process.platform !== 'linux') return;
  const child = Bun.spawn(['sleep', '30']);
  try {
    const ticks = captureIdentity(child.pid).startTicks;
    if (ticks === null) throw new Error('missing Linux process identity');
    await expect(openPidfd(child.pid, ticks + 1)).rejects.toThrow('identity changed');
    const handle = await openPidfd(child.pid, ticks);
    await handle.signal();
    expect(await child.exited).not.toBe(0);
  } finally {
    child.kill();
  }
});

test('stop uses a pidfd to signal the recorded live process', async () => {
  if (process.platform !== 'linux') return;
  const child = Bun.spawn(['sleep', '30']);
  try {
    const stateJson = await seedState({ pid: child.pid, identity: captureIdentity(child.pid) });
    await runStop(cwd);
    expect(await child.exited).not.toBe(0);
    expect((await readState(stateJson))?.status).toBe('stopped');
  } finally {
    child.kill();
  }
});

test('pidfd helper isolates Python and fails boundedly on invalid readiness', async () => {
  if (process.platform !== 'linux') return;
  const python = join(cwd, 'python3');
  const args = join(cwd, 'args');
  await writeFile(
    python,
    `#!/bin/sh\nprintf '%s\\n' "$1" > '${args}'\necho unexpected\nread line\n`,
    { mode: 0o755 },
  );
  const path = process.env.PATH;
  process.env.PATH = cwd;
  try {
    await expect(openPidfd(process.pid, 1)).rejects.toThrow('Cannot safely open pidfd');
    expect(await Bun.file(args).text()).toBe('-I\n');
  } finally {
    process.env.PATH = path;
  }
});

test('pidfd helper times out when readiness never arrives', async () => {
  if (process.platform !== 'linux') return;
  await writeFile(join(cwd, 'python3'), '#!/bin/sh\nread line\n', { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = cwd;
  try {
    await expect(openPidfd(process.pid, 1)).rejects.toThrow('Cannot safely open pidfd');
  } finally {
    process.env.PATH = path;
  }
}, 5000);

test('pidfd signal rejects when the helper closes its input', async () => {
  if (process.platform !== 'linux') return;
  await writeFile(join(cwd, 'python3'), '#!/bin/sh\necho ready\nexec 0<&-\n/bin/sleep 1\n', {
    mode: 0o755,
  });
  const path = process.env.PATH;
  process.env.PATH = cwd;
  try {
    const handle = await openPidfd(process.pid, 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(handle.signal()).rejects.toThrow('Cannot signal pidfd');
    handle.close();
  } finally {
    process.env.PATH = path;
  }
});

test('stop opens the recorded identity and signals through its handle', async () => {
  const identity = captureIdentity(process.pid);
  const calls: string[] = [];
  const open = spyOn(pidfd, 'openPidfd').mockImplementation(async (pid, ticks) => {
    expect(pid).toBe(process.pid);
    expect(ticks).toBe(identity.startTicks);
    calls.push('open');
    return {
      async signal() {
        calls.push('signal');
      },
      close() {
        calls.push('close');
      },
    };
  });
  try {
    await seedState({ pid: process.pid, identity });
    await runStop(cwd);
    expect(calls).toEqual(['open', 'signal', 'close']);
    expect(open).toHaveBeenCalledTimes(1);
  } finally {
    open.mockRestore();
  }
});

test('status reports no run when there is no state file', async () => {
  await runStatus(cwd);
  expect(logs.join('\n')).toContain('no debug run recorded');
});

test('status and stop fail loud on a present but malformed state.json, never "no run"', async () => {
  // A breadcrumb from an incompatible server version (no `identity`) or a hand edit:
  // reading it as "no debug run" hides a live run and turns `stop` into a no-op.
  const ws = workspacePaths(cwd);
  await mkdir(ws.root, { recursive: true });
  await writeFile(ws.stateJson, JSON.stringify({ pid: 1, status: 'running' }), 'utf8');

  await expect(runStatus(cwd)).rejects.toThrow(/not a valid run breadcrumb/);
  await expect(runStop(cwd)).rejects.toThrow(/not a valid run breadcrumb/);
  expect(logs.join('\n')).not.toContain('no debug run');
});

test('status and stop surface an unreadable workspace instead of reporting no run', async () => {
  // `existsSync` is false on EACCES too, so a permission problem read as "no run".
  if (process.getuid?.() === 0) return; // root ignores directory permissions
  const ws = workspacePaths(cwd);
  await seedState();
  await chmod(ws.root, 0o000);
  try {
    await expect(runStatus(cwd)).rejects.toThrow(/EACCES/);
    await expect(runStop(cwd)).rejects.toThrow(/EACCES/);
  } finally {
    await chmod(ws.root, 0o755);
  }
});

test('status prints the run identity + a dead-server line', async () => {
  await seedState();
  await runStatus(cwd);
  const out = logs.join('\n');
  expect(out).toContain('1700000000000-0001');
  expect(out).toContain('target:   web');
  expect(out).toContain('unknown (server died)'); // state says running but pid is not alive
});

test('status reports real findings counts from a written findings.json', async () => {
  const stateJson = await seedState(); // status: 'running', server dead
  const state = await readState(stateJson);
  if (!state) throw new Error('seedState did not write a readable state.json');
  await mkdir(state.sessionDir, { recursive: true });
  const findings: Findings = {
    status: 'passed',
    steps: [{ step: 'open', ok: true }],
    bugs: [{ kind: 'flow', detail: 'dead button' }],
    visual: [],
    summary: 'one bug found',
  };
  await writeFile(join(state.sessionDir, 'findings.json'), JSON.stringify(findings), 'utf8');

  await runStatus(cwd);
  const out = logs.join('\n');
  expect(out).toContain('1 bugs, 0 visual, 1 steps');
});

test('stop reports nothing to do when there is no state', async () => {
  await runStop(cwd);
  expect(logs.join('\n')).toContain('no active debug run to stop');
});

test('stop on a dead server marks the run stopped', async () => {
  const stateJson = await seedState();
  await runStop(cwd);
  expect(logs.join('\n')).toContain('not running');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('stop on an already-ended run neither signals nor rewrites the terminal status', async () => {
  // The pid is our own live process: before the guard, `stop` would SIGTERM the
  // healthy idle server and relabel `ended` → `stopped`.
  const stateJson = await seedState({ status: 'ended', pid: process.pid });
  await runStop(cwd);
  const out = logs.join('\n');
  expect(out).toContain('no active debug run to stop');
  expect(out).toContain("'1700000000000-0001' ended");
  expect((await readState(stateJson))?.status).toBe('ended'); // terminal state preserved
});

test('stop on an already-stopped run is a no-op', async () => {
  const stateJson = await seedState({ status: 'stopped' });
  await runStop(cwd);
  expect(logs.join('\n')).toContain('no active debug run to stop');
  expect(logs.join('\n')).toContain("'1700000000000-0001' stopped");
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('stop with a stale PID marks run stopped without signaling', async () => {
  // Requires /proc — Linux-only. On other platforms verifyIdentity returns 'unverifiable'
  // and would fall back to isAlive(process.pid) = true, then try to SIGTERM us.
  if (process.platform !== 'linux') return;

  // Use our own PID (alive) but a wrong startTicks (1) so verifyIdentity returns 'stale'.
  const stateJson = await seedState({ pid: process.pid, identity: { startTicks: 1 } });
  await runStop(cwd);
  const out = logs.join('\n');
  expect(out).toContain('without signaling');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

// --- stop-vs-end ordering ---------------------------------------------------

/** A live, verifiable owner: this very process. */
function liveOwner(): Partial<StateFile> {
  return { pid: process.pid, identity: captureIdentity(process.pid) };
}

test('a successor breadcrumb survives the ending run\u2019s late scoped clear — stop still signals it', async () => {
  // The race this pins: a run's teardown settles AFTER the next run recorded
  // itself (delayed close + an immediate successor start). Its clear is scoped
  // to its own id, so the live successor's breadcrumb must be untouched —
  // otherwise `stop` would see a terminal status and skip the live server.
  const stateJson = await seedState({ sessionId: 'successor-1', ...liveOwner() });
  const ws = workspacePaths(cwd);
  await writeFile(
    ownerLockPath(ws),
    `${JSON.stringify(
      {
        pid: process.pid,
        identity: captureIdentity(process.pid),
        sessionId: 'successor-1',
        acquiredAt: '2026-06-29T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  await new FileStatePort(ws).clear('old-run');

  const survived = await readState(stateJson);
  expect(survived).toMatchObject({ status: 'running', sessionId: 'successor-1' });

  const kills: number[] = [];
  await runStop(cwd, (pid) => kills.push(pid));

  expect(kills).toEqual([process.pid]); // the live successor was signaled, not skipped
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('stop does not mark or signal a successor replacing the selected run', async () => {
  for (const change of [
    { sessionId: 'successor' },
    { identity: { startTicks: (captureIdentity(process.pid).startTicks ?? 0) + 1 } },
  ]) {
    const stateJson = await seedState(liveOwner());
    const original = await readState(stateJson);
    if (!original) throw new Error('missing test state');
    const successor = { ...original, ...change };
    const kills: number[] = [];
    await expect(
      runStop(
        cwd,
        (pid) => kills.push(pid),
        async () => {
          await writeState(stateJson, successor);
        },
      ),
    ).rejects.toThrow('recorded run changed');
    expect(kills).toEqual([]);
    expect(await readState(stateJson)).toEqual(successor);
  }
});

test('stop rejects a successor replacing a dead or stale owner', async () => {
  for (const owner of [{}, { pid: process.pid, identity: { startTicks: 1 } }]) {
    if (owner.pid && process.platform !== 'linux') continue;
    const stateJson = await seedState(owner);
    const original = await readState(stateJson);
    if (!original) throw new Error('missing test state');
    const successor = { ...original, sessionId: 'successor' };
    await expect(
      runStop(
        cwd,
        () => {},
        () => writeState(stateJson, successor),
      ),
    ).rejects.toThrow('recorded run changed');
    expect(await readState(stateJson)).toEqual(successor);
  }
});

test('stop records `stopped` before the signal reaches the server', async () => {
  const stateJson = await seedState(liveOwner());
  // The server's SIGTERM handler marks `ended` via a read-modify-write; it can
  // only preserve `stopped` if the mark is already on disk when the signal lands.
  let statusAtSignal: string | undefined;
  const kill = () => {
    statusAtSignal = JSON.parse(readFileSync(stateJson, 'utf8')).status;
  };

  await runStop(cwd, kill);

  expect(statusAtSignal).toBe('stopped');
  expect(logs.join('\n')).toContain('SIGTERM');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

test('a failed signal rolls the mark back — a live run is never reported stopped', async () => {
  const stateJson = await seedState(liveOwner());
  const kill = () => {
    throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
  };
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args.join(' '));
  };

  try {
    await runStop(cwd, kill);
  } finally {
    console.error = origError;
  }

  expect(errors.join('\n')).toContain('failed to signal server');
  expect(process.exitCode).toBe(1); // the CLI must exit non-zero on a failed stop
  expect((await readState(stateJson))?.status).toBe('running'); // teardown never started
});

test('stop still marks stopped when the server exited between check and signal', async () => {
  const stateJson = await seedState(liveOwner());
  const kill = () => {
    throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
  };

  await runStop(cwd, kill);

  expect(logs.join('\n')).toContain('already exited');
  expect((await readState(stateJson))?.status).toBe('stopped');
});

// --- config edited while a run is live ------------------------------------

/** Boot a live run under workspace `./ws-a` (the way the server does), then repoint the config at `./ws-b`. */
async function startThenEditConfig() {
  const dz = join(cwd, '.dz', 'ui-debugger');
  await mkdir(dz, { recursive: true });
  const configPath = join(dz, 'ui-debugger-mcp.json');
  const config = (workspace: string) =>
    JSON.stringify({ workspace, targets: { web: { adapter: 'browser', url: 'http://x' } } });
  await writeFile(configPath, config('./ws-a'), 'utf8');

  const live = workspacePaths(cwd, './ws-a');
  await new FileStatePort(live, { pid: process.pid, cwd }).record({
    sessionId: 'live-1',
    target: 'web',
    goal: 'drifted run',
  });
  await writeFile(configPath, config('./ws-b'), 'utf8');
  return { live, drifted: workspacePaths(cwd, './ws-b') };
}

test('status finds a live run after the config workspace was edited, and names the drift', async () => {
  const { live, drifted } = await startThenEditConfig();
  await runStatus(cwd);
  const out = logs.join('\n');
  expect(out).not.toContain('no debug run recorded');
  expect(out).toContain('live-1');
  expect(out).toContain(`pid ${process.pid}`);
  expect(out).toContain('running');
  expect(out).toMatch(/drift:/);
  expect(out).toContain(live.root);
  expect(out).toContain(drifted.root);
});

test('status still finds the live run when the edited config is invalid', async () => {
  const { live } = await startThenEditConfig();
  await writeFile(join(cwd, '.dz', 'ui-debugger', 'ui-debugger-mcp.json'), '{ not json', 'utf8');
  await runStatus(cwd);
  const out = logs.join('\n');
  expect(out).toContain('live-1');
  expect(out).toMatch(/drift:.*invalid/);
  expect(out).toContain(live.root);
});

test('stop signals the live pid and marks the LIVE workspace stopped after a config edit', async () => {
  const { live, drifted } = await startThenEditConfig();
  const kills: number[] = [];
  await runStop(cwd, (pid) => kills.push(pid));

  expect(kills).toEqual([process.pid]);
  expect((await readState(live.stateJson))?.status).toBe('stopped');
  expect(await readState(drifted.stateJson)).toBeNull(); // nothing invented in the new workspace
});

test('status follows a live run when the effective config moves from .dz to root', async () => {
  const { live, drifted } = await startThenEditConfig();
  const dzConfig = join(cwd, '.dz', 'ui-debugger', 'ui-debugger-mcp.json');
  await writeFile(
    join(cwd, '.ui-debugger-mcp.json'),
    JSON.stringify({
      workspace: './ws-b',
      targets: { web: { adapter: 'browser', url: 'http://x' } },
    }),
    'utf8',
  );
  await rm(dzConfig);

  await runStatus(cwd);

  const out = logs.join('\n');
  expect(out).toContain('live-1');
  expect(out).toContain('target:   web');
  expect(out).toContain('goal:     drifted run');
  expect(out).toContain(`pid ${process.pid} — running`);
  expect(out).toContain('status:   running');
  expect(out).toContain('findings: no findings yet');
  expect(out).toContain(live.root);
  expect(out).toContain(drifted.root);
});

test('stop follows a live run when the effective config moves from .dz to root', async () => {
  const { live, drifted } = await startThenEditConfig();
  const dzConfig = join(cwd, '.dz', 'ui-debugger', 'ui-debugger-mcp.json');
  await writeFile(
    join(cwd, '.ui-debugger-mcp.json'),
    JSON.stringify({
      workspace: './ws-b',
      targets: { web: { adapter: 'browser', url: 'http://x' } },
    }),
    'utf8',
  );
  await rm(dzConfig);
  const kills: number[] = [];

  await runStop(cwd, (pid) => kills.push(pid));

  expect(kills).toEqual([process.pid]);
  expect((await readState(live.stateJson))?.status).toBe('stopped');
  expect(await readState(drifted.stateJson)).toBeNull();
});

test('status and stop reject an unreadable recorded live workspace as config drift', async () => {
  const { live } = await startThenEditConfig();
  await rm(live.stateJson);

  await expect(runStatus(cwd)).rejects.toThrow(/Config drift.*no readable state breadcrumb/);
  await expect(runStop(cwd)).rejects.toThrow(/Config drift.*no readable state breadcrumb/);
});

test('record stamps workspaceRoot and a no-drift status prints no drift line', async () => {
  const { live } = await startThenEditConfig();
  expect((await readState(live.stateJson))?.workspaceRoot).toBe(live.root);

  // Config pointed back at the live workspace → no drift to report.
  await writeFile(
    join(cwd, '.dz', 'ui-debugger', 'ui-debugger-mcp.json'),
    JSON.stringify({
      workspace: './ws-a',
      targets: { web: { adapter: 'browser', url: 'http://x' } },
    }),
    'utf8',
  );
  await runStatus(cwd);
  expect(logs.join('\n')).not.toContain('drift:');
});

test('status shows PID-reused line when identity is stale', async () => {
  if (process.platform !== 'linux') return;

  await seedState({ pid: process.pid, identity: { startTicks: 1 } });
  await runStatus(cwd);
  expect(logs.join('\n')).toContain('PID reused');
});
