import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FindingsError } from '../errors.js';
import type { Findings } from '../findings/schema.js';
import { FindingsStore } from './findings-store.js';
import { sessionPaths, workspacePaths } from './workspace.js';

const VALID_FINDINGS: Findings = {
  status: 'passed',
  steps: [{ step: 'load home page', ok: true }],
  bugs: [],
  visual: [],
  summary: 'All checks passed',
};

let tmpDir: string;
let store: FindingsStore;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-findings-test-'));
  const ws = workspacePaths('/project/my-app', tmpDir);
  const sp = sessionPaths(ws, 'test-session-001');
  store = new FindingsStore(sp);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// --- saveScreenshot ---------------------------------------------------------

test('saveScreenshot writes a NNN-<slug>.png frame and returns its path', async () => {
  const path = await store.saveScreenshot('click button "Save"', new Uint8Array([1, 2, 3]));
  expect(path).toMatch(/screenshots\/001-click-button-save\.png$/);
});

test('saveScreenshot caps a long label so the filename never overflows (ENAMETOOLONG)', async () => {
  const longLabel = 'Describe the overall page layout and visual quality '.repeat(10);
  const path = await store.saveScreenshot(longLabel, new Uint8Array([1]));
  const file = path.split('/').pop() ?? '';
  expect(file.length).toBeLessThanOrEqual(255);
  expect(file).toMatch(/^001-[a-z0-9-]+\.png$/);
  expect(file).not.toMatch(/-\.png$/); // no trailing dash before the extension
});

// --- listScreenshots --------------------------------------------------------

test('listScreenshots returns [] when no frames were saved', async () => {
  expect(await store.listScreenshots()).toEqual([]);
});

test('listScreenshots returns frames ordered by sequence with de-slugged labels', async () => {
  await store.saveScreenshot('open home', new Uint8Array([1]));
  await store.saveScreenshot('click "Save"', new Uint8Array([2]));
  const frames = await store.listScreenshots();
  expect(frames).toHaveLength(2);
  expect(frames[0]?.seq).toBe(1);
  expect(frames[0]?.label).toBe('open home');
  expect(frames[0]?.path).toMatch(/screenshots\/001-open-home\.png$/);
  expect(frames[1]?.seq).toBe(2);
  expect(frames[1]?.label).toBe('click save');
});

test('listScreenshots ignores files that do not match NNN-<slug>.png', async () => {
  await store.saveScreenshot('frame one', new Uint8Array([1]));
  const ws = workspacePaths('/project/my-app', tmpDir);
  const sp = sessionPaths(ws, 'test-session-001');
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(join(sp.screenshots, 'notes.txt'), 'ignore me', 'utf8'),
  );
  const frames = await store.listScreenshots();
  expect(frames).toHaveLength(1);
  expect(frames[0]?.label).toBe('frame one');
});

// --- writeFindings / readFindings -------------------------------------------

test('writeFindings returns the findings.json path', async () => {
  const path = await store.writeFindings(VALID_FINDINGS);
  expect(path).toEndWith('findings.json');
});

test('writeFindings + readFindings round-trips valid findings', async () => {
  await store.writeFindings(VALID_FINDINGS);
  const read = await store.readFindings();
  expect(read.status).toBe('passed');
  expect(read.summary).toBe('All checks passed');
  expect(read.steps).toHaveLength(1);
  expect(read.steps[0]?.step).toBe('load home page');
  expect(read.steps[0]?.ok).toBe(true);
});

test('writeFindings is idempotent — second write overwrites, read returns latest', async () => {
  await store.writeFindings(VALID_FINDINGS);
  await store.writeFindings({ ...VALID_FINDINGS, status: 'failed', summary: 'later' });
  const read = await store.readFindings();
  expect(read.status).toBe('failed');
  expect(read.summary).toBe('later');
});

test('readFindings throws FindingsError when file is missing', async () => {
  await expect(store.readFindings()).rejects.toBeInstanceOf(FindingsError);
});

test('readFindings throws FindingsError on corrupt JSON', async () => {
  // Write valid first so dirs exist, then overwrite with garbage.
  await store.writeFindings(VALID_FINDINGS);
  const ws = workspacePaths('/project/my-app', tmpDir);
  const sp = sessionPaths(ws, 'test-session-001');
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(sp.findingsJson, 'not-json!!', 'utf8'),
  );
  await expect(store.readFindings()).rejects.toBeInstanceOf(FindingsError);
});

// --- tryReadFindings ---------------------------------------------------------

test('tryReadFindings returns null when no file exists yet', async () => {
  const result = await store.tryReadFindings();
  expect(result).toBeNull();
});

test('tryReadFindings returns findings after write', async () => {
  await store.writeFindings(VALID_FINDINGS);
  const result = await store.tryReadFindings();
  expect(result).not.toBeNull();
  expect(result?.status).toBe('passed');
});

// --- failed / running status -------------------------------------------------

test('writeFindings accepts failed status with bugs', async () => {
  const findings: Findings = {
    status: 'failed',
    steps: [{ step: 'click submit', ok: false, note: '404 response' }],
    bugs: [{ kind: 'network', detail: 'POST /submit returned 404' }],
    visual: [{ issue: 'button invisible', where: 'footer', severity: 'high' }],
  };
  await store.writeFindings(findings);
  const read = await store.readFindings();
  expect(read.status).toBe('failed');
  expect(read.bugs).toHaveLength(1);
  expect(read.bugs[0]?.kind).toBe('network');
  expect(read.visual[0]?.severity).toBe('high');
});
