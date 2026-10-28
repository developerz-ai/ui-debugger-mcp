/**
 * The workspace ownership claim — the authority behind the one-run gate.
 *
 * The breadcrumb read is ADVISORY: two servers starting in the same window both
 * read "no foreign run", and only the workspace's exclusive claim admits one
 * of them. That claim is a kernel-held lock, so it can only be exercised
 * against REAL processes — a fabricated pid would not be provably alive, and a
 * claim file without a lock behind it excludes nobody.
 *
 * The advisory half of the same gate is covered in
 * `debug-service.cross-process.test.ts`.
 */

import { afterEach, expect, test } from 'bun:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { SessionBusyError } from '../errors.js';
import { SessionManager } from '../session/manager.js';
import { ownerLockPath } from '../session/owner-lock.js';
import type { Session } from '../session/session.js';
import { FileStatePort, readState, writeState } from '../session/state-file.js';
import { workspacePaths } from '../session/workspace.js';
import { DebugService } from './debug-service.js';
import {
  CONFIG,
  CWD,
  fakeBuilder,
  NOW,
  tmpDir,
  useTempWorkspace,
} from './debug-service.test-helpers.js';

useTempWorkspace();

/** Live child processes spawned by these tests — killed after each case. */
let liveChildren: ReturnType<typeof Bun.spawn>[] = [];

/**
 * A second LIVE pid, distinct from this process's.
 *
 * The ownership claim is decided by pid + process identity, so a test needs a
 * real second process: a dead pid would be reclaimed as stale, and a fabricated
 * one would not be provably alive. The child only sleeps — its pid is all the
 * test needs.
 */
function spawnLivePid(): number {
  const child = Bun.spawn({
    cmd: ['bun', '-e', 'await Bun.sleep(30_000)'],
    stdout: 'ignore',
    stderr: 'ignore',
  });
  liveChildren.push(child);
  return child.pid;
}

/**
 * A real second process that ACQUIRES the workspace's ownership lock and holds
 * it — the shape of a foreign owner the claim must refuse. Exclusion is a
 * kernel lock, so a claim file without a lock behind it excludes nobody; a
 * holder must be an actual live process.
 */
async function spawnLockHolder(workspacePath: string, sessionId: string): Promise<number> {
  const child = Bun.spawn({
    cmd: [
      'bun',
      '-e',
      `
        const { acquireOwnerLock } = await import(process.env.OWNER_LOCK_MODULE);
        const { captureIdentity } = await import(process.env.PROCESS_IDENTITY_MODULE);
        const result = await acquireOwnerLock(process.env.OWNER_LOCK_PATH, {
          pid: process.pid,
          identity: captureIdentity(process.pid),
          sessionId: process.env.SESSION_ID,
          acquiredAt: new Date().toISOString(),
        });
        if (!result.acquired) {
          console.log('BUSY');
          process.exit(0);
        }
        console.log('READY');
        await Bun.sleep(30_000); // hold the lock until the test kills us
      `,
    ],
    env: {
      ...process.env,
      OWNER_LOCK_MODULE: join(import.meta.dir, '../session/owner-lock.ts'),
      PROCESS_IDENTITY_MODULE: join(import.meta.dir, '../session/process-identity.ts'),
      OWNER_LOCK_PATH: workspacePath,
      SESSION_ID: sessionId,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  liveChildren.push(child);
  // Read only until READY: the child keeps stdout open while it holds the
  // lock (it sleeps for its whole 30s lifetime), so the stream never ends
  // until the test is done with it.
  const decoder = new TextDecoder();
  let stdout = '';
  let acquired = false;
  for await (const chunk of child.stdout) {
    stdout += decoder.decode(chunk, { stream: true });
    if (stdout.includes('READY')) {
      acquired = true;
      break;
    }
  }
  if (acquired) return child.pid;
  // Refused or crashed — either way the child has exited by now.
  const stderr = await new Response(child.stderr).text();
  throw new Error(`lock holder child did not acquire: ${stdout.trim() || stderr}`);
}

afterEach(async () => {
  for (const child of liveChildren) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  liveChildren = [];
});

test('a second server on the same workspace is refused — the owner keeps its run', async () => {
  // Two REAL FileStatePorts over ONE shared workspace, with distinct live pids:
  // the shape of two MCP servers debugging the same project at once. The second
  // start must be refused, and — the defect this closes — the first owner's
  // breadcrumb must still name it, so `status`/`stop` keep reaching the live
  // run instead of a dead one.
  const workspace = workspacePaths(CWD, tmpDir);
  const ownerPid = process.pid;
  const otherPid = spawnLivePid();
  const ownerState = new FileStatePort(workspace, { pid: ownerPid });
  const otherState = new FileStatePort(workspace, { pid: otherPid });

  const ownerManager = new SessionManager<Session>();
  const otherManager = new SessionManager<Session>();
  const ownerBuild = fakeBuilder();
  const otherBuild = fakeBuilder();
  const owner = new DebugService({
    manager: ownerManager,
    config: CONFIG,
    cwd: CWD,
    build: ownerBuild.build,
    state: ownerState,
    now: () => NOW,
  });
  const other = new DebugService({
    manager: otherManager,
    config: CONFIG,
    cwd: CWD,
    build: otherBuild.build,
    state: otherState,
    now: () => NOW,
  });

  const started = await owner.start({ target: 'web', goal: 'first' });
  expect(ownerManager.has(CWD)).toBe(true);

  const failure = await other.start({ target: 'web', goal: 'second' }).catch((e: unknown) => e);

  expect(failure).toBeInstanceOf(SessionBusyError);
  const message = (failure as SessionBusyError).message;
  expect(message).toContain(`pid ${ownerPid}`);
  expect(message).toContain(started.session_id);
  expect(message).toContain('ui-debugger-mcp stop');

  // The loser's browser never came up.
  expect(otherBuild.log.builds).toBe(0);
  expect(otherManager.has(CWD)).toBe(false);

  // …and the owner's live run is still the one on disk.
  expect(await readState(workspace.stateJson)).toMatchObject({
    pid: ownerPid,
    sessionId: started.session_id,
    status: 'running',
  });

  await owner.end({ session_id: started.session_id });
});

test('the ownership claim refuses a start even when the breadcrumb pre-check sees nothing', async () => {
  // The window the breadcrumb read cannot close: the loser's pre-check reads
  // the workspace BEFORE the winner's breadcrumb lands, so it sees "no foreign
  // run" and lets the start through. Only the exclusive claim can decide — and
  // it must refuse, before the loser publishes anything.
  //
  // The winner's breadcrumb here names a DEAD pid (its write has not landed
  // yet), while the claim it already took names a LIVE foreign process.
  const workspace = workspacePaths(CWD, tmpDir);
  await mkdir(workspace.root, { recursive: true }); // the lock file is created inside it
  const loserPid = spawnLivePid();
  const otherState = new FileStatePort(workspace, { pid: loserPid });
  const otherManager = new SessionManager<Session>();
  const otherBuild = fakeBuilder();
  const other = new DebugService({
    manager: otherManager,
    config: CONFIG,
    cwd: CWD,
    build: otherBuild.build,
    state: otherState,
    now: () => NOW,
  });

  // The winner holds the KERNEL lock (a real second process); its breadcrumb
  // names a dead pid, so the loser's pre-check reports "no foreign run" —
  // exactly the race the claim closes.
  const claimPid = await spawnLockHolder(ownerLockPath(workspace), 'winner-run');
  await writeState(workspace.stateJson, {
    pid: 999_999_999, // dead — the pre-check sees nobody
    identity: { startTicks: 1 },
    sessionId: 'winner-run',
    target: 'web',
    goal: 'first',
    status: 'running',
    startedAt: '2026-06-29T00:00:00.000Z',
    updatedAt: '2026-06-29T00:00:00.000Z',
    sessionDir: join(workspace.sessions, 'winner-run'),
  });

  // The pre-check is blind here…
  expect(await otherState.foreignRun()).toBeNull();

  // …so the CLAIM is what refuses, before anything is launched.
  const failure = await other.start({ target: 'web', goal: 'second' }).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(SessionBusyError);
  expect((failure as SessionBusyError).message).toContain(`pid ${claimPid}`);
  expect(otherBuild.log.builds).toBe(0);
  expect(otherManager.has(CWD)).toBe(false);

  // The winner's breadcrumb is untouched — the refusal published nothing.
  expect(await readState(workspace.stateJson)).toMatchObject({
    sessionId: 'winner-run',
    status: 'running',
  });
});
