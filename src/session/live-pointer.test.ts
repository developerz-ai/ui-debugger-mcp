import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { livePointerPath, readLivePointer, writeLivePointer } from './live-pointer.js';
import { workspacePaths } from './workspace.js';

let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'live-pointer-'));
});
afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

test('write then read round-trips the root', async () => {
  const root = join(cwd, 'ws-a', 'proj');
  await writeLivePointer(cwd, root);
  expect(await readLivePointer(cwd)).toBe(root);
});

test('a missing pointer reads as null', async () => {
  expect(await readLivePointer(cwd)).toBeNull();
});

test('a malformed pointer reads as null', async () => {
  const path = livePointerPath(cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '{ not json', 'utf8');
  expect(await readLivePointer(cwd)).toBeNull();
  await writeFile(path, JSON.stringify({ root: 5 }), 'utf8');
  expect(await readLivePointer(cwd)).toBeNull();
  await writeFile(path, JSON.stringify({ root: '' }), 'utf8');
  expect(await readLivePointer(cwd)).toBeNull();
});

test('the pointer path depends on the cwd alone — the default workspace root', () => {
  expect(livePointerPath(cwd)).toBe(join(workspacePaths(cwd).root, 'live-workspace.json'));
});
