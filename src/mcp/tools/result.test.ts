import { expect, test } from 'bun:test';
import { EVIDENCE_FIELD_NAMES } from '../../findings/schema.js';
import {
  EVIDENCE_KEYS,
  MAX_LIST_ITEMS,
  mimeTypeFor,
  steeringNote,
  TRUNCATED_KEY,
  toToolResult,
} from './result.js';

test('MAX_LIST_ITEMS is 20', () => {
  expect(MAX_LIST_ITEMS).toBe(20);
});

test('EVIDENCE_KEYS contains exactly screenshot and evidence', () => {
  expect(EVIDENCE_KEYS).toEqual(new Set(EVIDENCE_FIELD_NAMES));
});

test('mimeTypeFor returns the expected MIME for each known extension', () => {
  expect(mimeTypeFor('/tmp/x.png')).toBe('image/png');
  expect(mimeTypeFor('/tmp/x.jpg')).toBe('image/jpeg');
  expect(mimeTypeFor('/tmp/x.jpeg')).toBe('image/jpeg');
  expect(mimeTypeFor('/tmp/x.mp4')).toBe('video/mp4');
  expect(mimeTypeFor('/tmp/x.log')).toBe('text/plain');
});

test('mimeTypeFor returns undefined for an unknown extension', () => {
  expect(mimeTypeFor('/tmp/x.txt')).toBeUndefined();
});

test('TRUNCATED_KEY is "truncated"', () => {
  expect(TRUNCATED_KEY).toBe('truncated');
});

test('steeringNote contains the literal phrases for the capped fields', () => {
  const note = steeringNote(['steps', 'bugs']);
  expect(note).toContain('Truncated steps, bugs to the first 20 items');
  expect(note).toContain('see "truncated" for the real totals');
  expect(note).toContain('fields=["steps", "bugs"]');
});

test('a resource_link keeps `#` and `?` in the path instead of reading them as URL syntax', () => {
  // A project checked out under `issue#42/` or `what?/` — the link must still
  // name the file on disk.
  const result = toToolResult({ evidence: '/work/issue#42/what?/replay.mp4' });
  const link = result.content.find((item) => item.type === 'resource_link');
  expect(link).toMatchObject({ uri: 'file:///work/issue%2342/what%3F/replay.mp4' });
});
