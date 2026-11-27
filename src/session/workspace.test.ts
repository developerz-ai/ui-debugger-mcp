import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceError } from '../errors.js';
import {
  _resetCounter,
  allocateSessionId,
  ensureSession,
  ensureWorkspace,
  generateSessionId,
  resolveProfileDir,
  resolveProject,
  SESSION_DIR_PATTERN,
  SESSION_ID_ATTEMPTS,
  sessionPaths,
  workspacePaths,
} from './workspace.js';

beforeEach(() => _resetCounter());

// --- resolveProject ---------------------------------------------------------

test('resolveProject extracts basename from cwd', () => {
  expect(resolveProject('/home/user/my-app')).toBe('my-app');
  expect(resolveProject('/srv/projects/backend')).toBe('backend');
});

// --- workspacePaths ---------------------------------------------------------

test('workspacePaths builds correct paths', () => {
  const paths = workspacePaths('/home/user/my-app', './tmp/ws');
  expect(paths.root).toBe('/home/user/my-app/tmp/ws/my-app');
  expect(paths.chromeUserData).toBe('/home/user/my-app/tmp/ws/my-app/chrome-user-data');
  expect(paths.sessions).toBe('/home/user/my-app/tmp/ws/my-app/sessions');
  expect(paths.stateJson).toBe('/home/user/my-app/tmp/ws/my-app/state.json');
});

test('workspacePaths default base is cwd/tmp/ui-debugger-mcp/<project>', () => {
  const paths = workspacePaths('/projects/my-app');
  expect(paths.root).toBe('/projects/my-app/tmp/ui-debugger-mcp/my-app');
});

test('a relative workspace keeps the bare project dir (installs keep their profile)', () => {
  // Resolving against cwd already makes it unique — renaming it here would orphan
  // every existing chrome-user-data/ and sessions/ dir on upgrade.
  expect(workspacePaths('/home/user/api', './tmp/ui-debugger-mcp').root).toBe(
    '/home/user/api/tmp/ui-debugger-mcp/api',
  );
  // An absolute base that happens to live under the project root is unique too.
  expect(workspacePaths('/home/user/api', '/home/user/api/build/ws').root).toBe(
    '/home/user/api/build/ws/api',
  );
});

test('two projects sharing one absolute workspace never collide on basename', () => {
  const work = workspacePaths('/home/user/work/api', '/var/ui-debugger');
  const oss = workspacePaths('/home/user/oss/api', '/var/ui-debugger');

  // Same basename, same shared base — but a run in one must never look like a run
  // in the other: state.json, chrome-user-data/ and sessions/ have to stay apart.
  expect(work.root).not.toBe(oss.root);
  expect(work.root).toMatch(/^\/var\/ui-debugger\/api-[0-9a-f]{8}$/);
  expect(oss.root).toMatch(/^\/var\/ui-debugger\/api-[0-9a-f]{8}$/);
  expect(work.stateJson).not.toBe(oss.stateJson);
  expect(work.chromeUserData).not.toBe(oss.chromeUserData);
});

test('the disambiguating suffix is stable across calls (one cwd, one workspace)', () => {
  // The CLI resolves this in a separate process — a per-run suffix would leave
  // `status`/`stop` reading a state.json the server never writes.
  expect(workspacePaths('/home/user/work/api', '/var/ui-debugger').root).toBe(
    workspacePaths('/home/user/work/api', '/var/ui-debugger').root,
  );
});

// --- resolveProfileDir ------------------------------------------------------

test('resolveProfileDir falls back to the workspace chrome-user-data dir', () => {
  const ws = workspacePaths('/home/user/my-app', './tmp/ws');
  expect(resolveProfileDir(ws)).toBe('/home/user/my-app/tmp/ws/my-app/chrome-user-data');
});

test('resolveProfileDir anchors a relative profile at the workspace root', () => {
  const ws = workspacePaths('/home/user/my-app', './tmp/ws');
  expect(resolveProfileDir(ws, 'chrome-user-data')).toBe(join(ws.root, 'chrome-user-data'));
  expect(resolveProfileDir(ws, 'profiles/logged-in')).toBe(join(ws.root, 'profiles/logged-in'));
});

test('resolveProfileDir honors an absolute profile path as-is', () => {
  const ws = workspacePaths('/home/user/my-app', './tmp/ws');
  expect(resolveProfileDir(ws, '/var/chrome/shared')).toBe('/var/chrome/shared');
});

// --- sessionPaths -----------------------------------------------------------

test('sessionPaths builds correct paths', () => {
  const ws = workspacePaths('/home/user/my-app', './tmp/ws');
  const sp = sessionPaths(ws, '12345-0001');
  const root = '/home/user/my-app/tmp/ws/my-app/sessions/12345-0001';
  expect(sp.root).toBe(root);
  expect(sp.storyMd).toBe(`${root}/story.md`);
  expect(sp.screenshots).toBe(`${root}/screenshots`);
  expect(sp.replayMp4).toBe(`${root}/replay.mp4`);
  expect(sp.findingsJson).toBe(`${root}/findings.json`);
  expect(sp.logs).toBe(`${root}/logs`);
});

// --- generateSessionId ------------------------------------------------------

test('generateSessionId renders the injected time as a human-readable local date', () => {
  const when = new Date(2026, 6, 27, 14, 30, 5); // 2026-07-27 14:30:05 local
  expect(generateSessionId(when.getTime())).toBe('2026-07-27_14-30-05-0001');
});

test('generateSessionId zero-pads every field so ids stay fixed-width', () => {
  const when = new Date(2026, 0, 2, 3, 4, 5); // 2026-01-02 03:04:05 local
  expect(generateSessionId(when.getTime())).toBe('2026-01-02_03-04-05-0001');
});

test('generateSessionId counter increments per call', () => {
  const when = new Date(2026, 6, 27, 14, 30, 5).getTime();
  expect(generateSessionId(when)).toBe('2026-07-27_14-30-05-0001');
  expect(generateSessionId(when)).toBe('2026-07-27_14-30-05-0002');
});

test('generateSessionId counter resets after 9999', () => {
  // Advance to 9999
  for (let i = 0; i < 9999; i++) generateSessionId(0);
  const next = generateSessionId(0);
  expect(next).toEndWith('-0000');
});

test('generateSessionId ids are unique with same timestamp', () => {
  const ids = Array.from({ length: 5 }, (_, _i) => generateSessionId(42));
  const unique = new Set(ids);
  expect(unique.size).toBe(5);
});

test('generateSessionId ids sort chronologically as plain strings (what prune relies on)', () => {
  const ids = [
    generateSessionId(new Date(2026, 8, 9, 8, 5, 9).getTime()),
    generateSessionId(new Date(2026, 8, 9, 8, 5, 10).getTime()),
    generateSessionId(new Date(2026, 8, 10, 7, 0, 0).getTime()),
    generateSessionId(new Date(2026, 11, 31, 23, 59, 59).getTime()),
  ];
  expect([...ids].sort()).toEqual(ids);
});

// --- ensureWorkspace / ensureSession ----------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-ws-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('ensureWorkspace creates chrome-user-data and sessions dirs', async () => {
  const ws = workspacePaths('/project/my-app', tmpDir);
  await ensureWorkspace(ws);
  const chromeStat = await stat(ws.chromeUserData);
  const sessionsStat = await stat(ws.sessions);
  expect(chromeStat.isDirectory()).toBe(true);
  expect(sessionsStat.isDirectory()).toBe(true);
});

test('ensureWorkspace is idempotent', async () => {
  const ws = workspacePaths('/project/my-app', tmpDir);
  await ensureWorkspace(ws);
  // Second call must not throw
  await ensureWorkspace(ws);
  const chromeStat = await stat(ws.chromeUserData);
  expect(chromeStat.isDirectory()).toBe(true);
});

test('ensureSession creates screenshots and logs dirs', async () => {
  const ws = workspacePaths('/project/my-app', tmpDir);
  await ensureWorkspace(ws);
  const sp = sessionPaths(ws, 'sess-001');
  await ensureSession(sp);
  const screenshotsStat = await stat(sp.screenshots);
  const logsStat = await stat(sp.logs);
  expect(screenshotsStat.isDirectory()).toBe(true);
  expect(logsStat.isDirectory()).toBe(true);
});

test('ensureSession refuses a session dir that already exists (id collision)', async () => {
  // The id counter is per process: a server restarted inside the same wall-clock
  // second hands out `...-0001` again. Reusing that dir would mix two runs'
  // evidence — and a run that never reports would inherit the old `passed`.
  const ws = workspacePaths('/project/my-app', tmpDir);
  const sp = sessionPaths(ws, 'sess-002');
  await ensureSession(sp);
  await writeFile(sp.findingsJson, '{"status":"passed"}');

  const err = await ensureSession(sp).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkspaceError);
  expect((err as WorkspaceError).message).toContain(sp.root);
  expect(await readFile(sp.findingsJson, 'utf8')).toBe('{"status":"passed"}'); // untouched
});

test('generated ids are the run dirs the prune recognises', () => {
  expect(SESSION_DIR_PATTERN.test(generateSessionId(Date.now()))).toBe(true);
  expect(SESSION_DIR_PATTERN.test('1784985071909-0001')).toBe(true); // legacy epoch-ms
  expect(SESSION_DIR_PATTERN.test('Default')).toBe(false);
});

// --- allocateSessionId -------------------------------------------------------

const NOW = new Date(2026, 6, 27, 14, 30, 5).getTime();

test('allocateSessionId skips an id a previous process already used', async () => {
  // A restarted server's counter starts over: `-0001` is taken on disk.
  const ws = workspacePaths('/project/my-app', tmpDir);
  await ensureSession(sessionPaths(ws, '2026-07-27_14-30-05-0001'));

  const id = await allocateSessionId(ws, NOW);

  expect(id).toBe('2026-07-27_14-30-05-0002'); // next counter: fixed-width, sorts after
  await ensureSession(sessionPaths(ws, id)); // and the exclusive create accepts it
});

test('allocateSessionId returns the first id when nothing is taken', async () => {
  const ws = workspacePaths('/project/my-app', tmpDir);
  expect(await allocateSessionId(ws, NOW)).toBe('2026-07-27_14-30-05-0001');
});

test('allocateSessionId fails loud once every candidate is taken', async () => {
  const ws = workspacePaths('/project/my-app', tmpDir);
  for (let n = 1; n <= SESSION_ID_ATTEMPTS; n += 1) {
    await ensureSession(sessionPaths(ws, `2026-07-27_14-30-05-${String(n).padStart(4, '0')}`));
  }

  const err = await allocateSessionId(ws, NOW).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(WorkspaceError);
  expect((err as WorkspaceError).message).toContain(ws.sessions);
});
