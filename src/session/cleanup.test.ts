import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from '../errors.js';
import { pruneSessions, SESSION_RETENTION } from './cleanup.js';
import { _resetCounter, generateSessionId, workspacePaths } from './workspace.js';

let tmpDir: string;
let workspace: ReturnType<typeof workspacePaths>;

beforeEach(async () => {
  _resetCounter();
  tmpDir = await mkdtemp(join(tmpdir(), 'uidbg-cleanup-'));
  workspace = workspacePaths('/project/app', tmpDir);
  await mkdir(workspace.sessions, { recursive: true });
});

afterEach(async () => {
  await chmod(workspace.sessions, 0o755).catch(() => undefined);
  await rm(tmpDir, { recursive: true, force: true });
});

/** Create `sessions/<id>/` with a file inside, so removal has to recurse. */
async function seed(...ids: string[]): Promise<void> {
  for (const id of ids) {
    await mkdir(join(workspace.sessions, id, 'logs'), { recursive: true });
    await writeFile(join(workspace.sessions, id, 'findings.json'), '{}');
  }
}

/** How many of `ids` are gone from disk. */
function removedCount(ids: readonly string[]): number {
  return ids.filter((id) => !existsSync(join(workspace.sessions, id))).length;
}

test('keeps the newest N session dirs and removes the rest', async () => {
  const ids = [
    '2026-07-20_10-00-00-0001',
    '2026-07-21_10-00-00-0001',
    '2026-07-22_10-00-00-0001',
    '2026-07-23_10-00-00-0001',
    '2026-07-24_10-00-00-0001',
    '2026-07-25_10-00-00-0001',
    '2026-07-26_10-00-00-0001',
  ];
  await seed(...ids);

  const removed = await pruneSessions(workspace, { keep: 5 });

  expect(removed).toEqual(['2026-07-20_10-00-00-0001', '2026-07-21_10-00-00-0001']);
  for (const id of ids.slice(2)) expect(existsSync(join(workspace.sessions, id))).toBe(true);
  for (const id of ids.slice(0, 2)) expect(existsSync(join(workspace.sessions, id))).toBe(false);
});

test('default retention is 5', async () => {
  expect(SESSION_RETENTION).toBe(5);
  const ids = Array.from(
    { length: 8 },
    (_, i) => `2026-07-${String(10 + i).padStart(2, '0')}_09-00-00-0001`,
  );
  await seed(...ids);

  await pruneSessions(workspace);

  expect(removedCount(ids)).toBe(3);
});

test('nothing to prune when at or under the limit', async () => {
  await seed('2026-07-20_10-00-00-0001', '2026-07-21_10-00-00-0001');
  expect(await pruneSessions(workspace, { keep: 5 })).toEqual([]);
  expect(removedCount(['2026-07-20_10-00-00-0001'])).toBe(0);
});

test('a protected id survives even when it sorts oldest (clock moved backwards)', async () => {
  const older = '2026-07-19_08-00-00-0001'; // the run we are starting, after an NTP correction
  const ids = [
    older,
    '2026-07-20_10-00-00-0001',
    '2026-07-21_10-00-00-0001',
    '2026-07-22_10-00-00-0001',
  ];
  await seed(...ids);

  const removed = await pruneSessions(workspace, { keep: 2, protect: older });

  expect(removed).toEqual(['2026-07-20_10-00-00-0001']);
  expect(existsSync(join(workspace.sessions, older))).toBe(true);
});

test('legacy epoch-ms dirs are the first to go (they sort below the dated ids)', async () => {
  await seed('1784985071909-0001', '2026-07-25_10-00-00-0001', '2026-07-26_10-00-00-0001');

  const removed = await pruneSessions(workspace, { keep: 2 });

  expect(removed).toEqual(['1784985071909-0001']);
});

test('loose files in sessions/ are left alone — only directories are runs', async () => {
  await seed('2026-07-25_10-00-00-0001', '2026-07-26_10-00-00-0001');
  await writeFile(join(workspace.sessions, 'README.txt'), 'notes');

  const removed = await pruneSessions(workspace, { keep: 1 });

  expect(removed).toEqual(['2026-07-25_10-00-00-0001']);
  expect(existsSync(join(workspace.sessions, 'README.txt'))).toBe(true);
});

test('a missing sessions dir prunes nothing (no run has happened here yet)', async () => {
  await rm(workspace.sessions, { recursive: true, force: true });
  expect(await pruneSessions(workspace)).toEqual([]);
});

test('an unreadable sessions dir fails loud with WorkspaceError', async () => {
  await seed('2026-07-25_10-00-00-0001');
  await chmod(workspace.sessions, 0o000);
  // Running as root defeats the permission bit — skip rather than assert a lie.
  let readable = true;
  try {
    await pruneSessions(workspace, { keep: 0 });
  } catch (err) {
    readable = false;
    expect(err).toBeInstanceOf(WorkspaceError);
    expect((err as WorkspaceError).message).toContain(workspace.sessions);
  }
  if (readable) expect(process.getuid?.()).toBe(0);
});

test('ids generated back-to-back prune in chronological order', async () => {
  const first = generateSessionId(Date.parse('2026-07-25T09:00:00'));
  const second = generateSessionId(Date.parse('2026-07-25T09:00:00')); // same second, next counter
  const third = generateSessionId(Date.parse('2026-07-25T09:00:01'));
  await seed(first, second, third);

  const removed = await pruneSessions(workspace, { keep: 1 });

  expect(removed).toEqual([first, second]);
  expect(existsSync(join(workspace.sessions, third))).toBe(true);
});
