import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetCounter,
  ensureSession,
  ensureWorkspace,
  generateSessionId,
  resolveProject,
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
  const paths = workspacePaths('/home/user/my-app', '/tmp/ws');
  expect(paths.root).toBe('/tmp/ws/my-app');
  expect(paths.chromeUserData).toBe('/tmp/ws/my-app/chrome-user-data');
  expect(paths.sessions).toBe('/tmp/ws/my-app/sessions');
  expect(paths.stateJson).toBe('/tmp/ws/my-app/state.json');
});

test('workspacePaths default base is cwd/tmp/ui-debugger-mcp/<project>', () => {
  const paths = workspacePaths('/projects/my-app');
  expect(paths.root).toBe('/projects/my-app/tmp/ui-debugger-mcp/my-app');
});

// --- sessionPaths -----------------------------------------------------------

test('sessionPaths builds correct paths', () => {
  const ws = workspacePaths('/home/user/my-app', '/tmp/ws');
  const sp = sessionPaths(ws, '12345-0001');
  expect(sp.root).toBe('/tmp/ws/my-app/sessions/12345-0001');
  expect(sp.storyMd).toBe('/tmp/ws/my-app/sessions/12345-0001/story.md');
  expect(sp.screenshots).toBe('/tmp/ws/my-app/sessions/12345-0001/screenshots');
  expect(sp.findingsJson).toBe('/tmp/ws/my-app/sessions/12345-0001/findings.json');
  expect(sp.logs).toBe('/tmp/ws/my-app/sessions/12345-0001/logs');
});

// --- generateSessionId ------------------------------------------------------

test('generateSessionId includes injected time', () => {
  const id = generateSessionId(1_700_000_000_000);
  expect(id).toStartWith('1700000000000-');
});

test('generateSessionId counter increments per call', () => {
  const a = generateSessionId(1000);
  const b = generateSessionId(1000);
  expect(a).toBe('1000-0001');
  expect(b).toBe('1000-0002');
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

test('ensureSession is idempotent', async () => {
  const ws = workspacePaths('/project/my-app', tmpDir);
  await ensureWorkspace(ws);
  const sp = sessionPaths(ws, 'sess-002');
  await ensureSession(sp);
  await ensureSession(sp);
  const screenshotsStat = await stat(sp.screenshots);
  expect(screenshotsStat.isDirectory()).toBe(true);
});
