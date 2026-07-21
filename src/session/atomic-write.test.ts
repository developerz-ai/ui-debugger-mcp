import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, open, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic } from './atomic-write.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('writeFileAtomic replaces the target and leaves no temp file behind', async () => {
  const path = join(dir, 'f.json');
  await writeFileAtomic(path, '{"a":1}\n');
  await writeFileAtomic(path, '{"a":2}\n');

  expect(await readFile(path, 'utf8')).toBe('{"a":2}\n');
  expect(await readdir(dir)).toEqual(['f.json']);
});

test('the target is swapped, never truncated in place', async () => {
  // A reader that already opened the file keeps the old inode: proof the update
  // was a rename and not a truncate-then-write a concurrent reader could catch
  // half-done. With a plain writeFile this handle would see the new bytes.
  const path = join(dir, 'f.json');
  await writeFileAtomic(path, '{"n":1}\n');
  const reader = await open(path, 'r');
  try {
    await writeFileAtomic(path, `${JSON.stringify({ n: 2, pad: 'x'.repeat(50_000) })}\n`);
    expect(await reader.readFile('utf8')).toBe('{"n":1}\n');
  } finally {
    await reader.close();
  }
  expect(JSON.parse(await readFile(path, 'utf8')).n).toBe(2);
});

test('concurrent writers get distinct temp names and leave none behind', async () => {
  const path = join(dir, 'f.json');
  const payload = (n: number) => `${JSON.stringify({ n, pad: 'x'.repeat(100_000) })}\n`;
  await Promise.all(Array.from({ length: 12 }, (_, i) => writeFileAtomic(path, payload(i))));

  // A shared `.tmp` name would have writers overwriting each other's temp file;
  // every rename consumed its own, so the dir holds just the published target.
  expect(await readdir(dir)).toEqual(['f.json']);
  const n = JSON.parse(await readFile(path, 'utf8')).n;
  expect(n).toBeGreaterThanOrEqual(0);
  expect(n).toBeLessThan(12);
});

test('a failed rename cleans the temp file up and rethrows', async () => {
  const path = join(dir, 'target');
  await mkdir(path); // renaming a file onto a directory fails

  await expect(writeFileAtomic(path, 'nope')).rejects.toThrow();
  expect(await readdir(dir)).toEqual(['target']); // no `.tmp-*` litter left in the workspace
});
