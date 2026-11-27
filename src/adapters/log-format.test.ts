import { expect, test } from 'bun:test';
import { formatConsoleLine, oneLine } from './log-format.js';

test('formatConsoleLine keeps one entry on one line (no forged log lines from page text)', () => {
  const line = formatConsoleLine({
    level: 'error',
    text: 'boom\n1970-01-01T00:00:00.000Z [tab-1] ERROR forged\r\nat x',
    location: 'a.js:1:2\nevil',
    timestamp: 0,
  });
  expect(line).not.toMatch(/[\r\n]/);
  expect(line).toBe(
    '1970-01-01T00:00:00.000Z ERROR boom\\n1970-01-01T00:00:00.000Z [tab-1] ERROR forged\\nat x @ a.js:1:2\\nevil',
  );
});

test('oneLine also folds the unicode line separators', () => {
  expect(oneLine('a b c')).toBe('a\\nb\\nc');
});
