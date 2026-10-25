/**
 * Two projects, two editors, two servers — nothing crosses over.
 *
 * The real-world shape: two VS Code windows, each with its own Claude Code and its
 * own `ui-debugger-mcp` server, debugging two different apps at the same time.
 * Everything that could collide is keyed by cwd — the workspace root, the Chrome
 * profile, the `state.json` breadcrumb, the session registry, and the retention
 * prune — so this pins each of those guarantees end to end.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneSessions } from './cleanup.js';
import { SessionManager } from './manager.js';
import { ownerLockPath } from './owner-lock.js';
import { FileStatePort } from './state-file.js';
import { _resetCounter, workspacePaths } from './workspace.js';

let root: string;
/** Two sibling checkouts — deliberately sharing a basename, the worst case. */
let projectA: string;
let projectB: string;
/** Live child processes spawned by the ownership tests — killed after each case. */
let children: ReturnType<typeof Bun.spawn>[] = [];

beforeEach(async () => {
  _resetCounter();
  root = await mkdtemp(join(tmpdir(), 'uidbg-iso-'));
  projectA = join(root, 'work', 'app');
  projectB = join(root, 'oss', 'app');
  await mkdir(projectA, { recursive: true });
  await mkdir(projectB, { recursive: true });
  children = [];
});

afterEach(async () => {
  for (const child of children) {
    child.kill();
    await child.exited.catch(() => undefined);
  }
  await rm(root, { recursive: true, force: true });
});

/**
 * A second LIVE pid, distinct from this process's.
 *
 * The ownership claim is decided by pid + process identity, so the test needs a
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
  children.push(child);
  return child.pid;
}

test('each project gets its own workspace, profile, sessions dir and state.json', () => {
  const a = workspacePaths(projectA);
  const b = workspacePaths(projectB);

  // Same basename ('app'), but the default workspace is anchored under each cwd.
  expect(a.root).not.toBe(b.root);
  expect(a.chromeUserData).not.toBe(b.chromeUserData); // no shared Chrome profile lock
  expect(a.sessions).not.toBe(b.sessions);
  expect(a.stateJson).not.toBe(b.stateJson);
  expect(a.root).toBe(join(projectA, 'tmp', 'ui-debugger-mcp', 'app'));
  expect(b.root).toBe(join(projectB, 'tmp', 'ui-debugger-mcp', 'app'));
});

test('a shared absolute workspace still separates same-named projects', () => {
  const shared = join(root, 'shared-ws');
  const a = workspacePaths(projectA, shared);
  const b = workspacePaths(projectB, shared);

  expect(a.root).not.toBe(b.root);
  expect(a.chromeUserData).not.toBe(b.chromeUserData);
  expect(a.stateJson).not.toBe(b.stateJson);
});

test('one manager holds a live run for each project at once — no false busy', () => {
  const manager = new SessionManager();
  const close = () => Promise.resolve();

  manager.start(projectA, { id: 'run-a', close });
  // The one-run gate is per cwd, not global: project B must still be startable.
  manager.start(projectB, { id: 'run-b', close });

  expect(manager.get(projectA).id).toBe('run-a');
  expect(manager.get(projectB).id).toBe('run-b');
  // ...and a second run on A alone is still refused.
  expect(() => manager.start(projectA, { id: 'run-a2', close })).toThrow(/already active/);
});

test("project A's server never sees project B's running breadcrumb", async () => {
  const a = workspacePaths(projectA);
  const b = workspacePaths(projectB);
  // Two distinct, live-looking server pids — neither is the other's.
  const portA = new FileStatePort(a, { pid: process.pid });
  const portB = new FileStatePort(b, { pid: process.pid });

  await portB.record({ sessionId: 'run-b', target: 'web', goal: 'debug B' });

  // B is running, but A's port reads A's own state.json — which does not exist.
  expect(await portA.foreignRun()).toBeNull();
  expect(await portA.foreignFindings('run-b')).toBeNull();
  expect(existsSync(a.stateJson)).toBe(false);
  expect(existsSync(b.stateJson)).toBe(true);
});

test('pruning project A never touches project B evidence', async () => {
  const a = workspacePaths(projectA);
  const b = workspacePaths(projectB);
  const ids = ['2026-07-20_10-00-00-0001', '2026-07-21_10-00-00-0001', '2026-07-22_10-00-00-0001'];
  for (const workspace of [a, b]) {
    for (const id of ids) {
      await mkdir(join(workspace.sessions, id), { recursive: true });
      await writeFile(join(workspace.sessions, id, 'findings.json'), '{}');
    }
  }

  const removed = await pruneSessions(a, { keep: 1 });

  expect(removed).toEqual([ids[0], ids[1]] as string[]);
  // B kept everything — its retention is its own business.
  for (const id of ids) expect(existsSync(join(b.sessions, id))).toBe(true);
});

test("project A's ownership claim never blocks project B, and never lands in A's workspace", async () => {
  // The claim is the exclusive admission point, so it must be as isolated as the
  // breadcrumb: two projects debugged at the same time each hold their OWN
  // workspace — A's claim must not refuse B's start, and B's claim file must
  // never appear inside A's workspace.
  const a = workspacePaths(projectA);
  const b = workspacePaths(projectB);
  // Distinct LIVE pids: the claim decides by pid + process identity.
  const pidA = process.pid;
  const pidB = spawnLivePid();
  const portA = new FileStatePort(a, { pid: pidA });
  const portB = new FileStatePort(b, { pid: pidB });

  // A takes its claim.
  await portA.record({ sessionId: 'run-a', target: 'web', goal: 'debug A' });

  // B still starts: A's claim is scoped to A's workspace.
  await portB.record({ sessionId: 'run-b', target: 'web', goal: 'debug B' });

  // Each claim file lives in its own workspace root.
  expect(ownerLockPath(a)).not.toBe(ownerLockPath(b));
  expect(existsSync(ownerLockPath(a))).toBe(true);
  expect(existsSync(ownerLockPath(b))).toBe(true);

  // A's claim names A's owner; B's claim names B's — neither crossed over.
  const claimA = JSON.parse(await readFile(ownerLockPath(a), 'utf8'));
  const claimB = JSON.parse(await readFile(ownerLockPath(b), 'utf8'));
  expect(claimA.pid).toBe(pidA);
  expect(claimB.pid).toBe(pidB);

  // And A's own port still sees no foreign run — B is a different project.
  expect(await portA.foreignRun()).toBeNull();
  expect(await portA.foreignFindings('run-b')).toBeNull();
});
