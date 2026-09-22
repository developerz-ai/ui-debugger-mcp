import { expect, test } from 'bun:test';
import {
  EVIDENCE_KEYS,
  MAX_LIST_ITEMS,
  mimeTypeFor,
  steeringNote,
  TRUNCATED_KEY,
} from './result.js';

test('MAX_LIST_ITEMS is 20', () => {
  expect(MAX_LIST_ITEMS).toBe(20);
});

test('EVIDENCE_KEYS contains exactly screenshot and evidence', () => {
  expect(EVIDENCE_KEYS).toEqual(new Set(['screenshot', 'evidence']));
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
