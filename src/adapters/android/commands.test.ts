/**
 * Unit tests for the pure argv builders (`commands.ts`) — tap points, `am start`/`monkey`
 * launch args, `input text` escaping (device-shell injection), swipes and keycodes.
 * No adb/emulator needed: every export here is a pure function over plain data.
 */

import { describe, expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { Bounds, Node } from '../contract.js';
import {
  centerOf,
  escapeInputText,
  keyArgs,
  keycodeFor,
  parseScreenSize,
  scrollSwipe,
  splitTextForInput,
  splitTextLines,
  startArgs,
  swipeArgs,
  tapArgs,
  tapPointOf,
  textArgs,
} from './commands.js';

/** Build a minimal valid Node. */
function makeNode(overrides: Partial<Node> = {}): Node {
  return {
    role: 'button',
    name: 'Save',
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    enabled: true,
    ...overrides,
  };
}

describe('centerOf', () => {
  test('computes center of a bounds rect', () => {
    expect(centerOf({ x: 100, y: 200, width: 200, height: 100 })).toEqual({ x: 200, y: 250 });
  });
  test('rounds to integer', () => {
    expect(centerOf({ x: 0, y: 0, width: 101, height: 51 })).toEqual({ x: 51, y: 26 });
  });
});

describe('tapPointOf', () => {
  test('returns the node center when it has size', () => {
    expect(tapPointOf(makeNode({ bounds: { x: 100, y: 200, width: 200, height: 100 } }))).toEqual({
      x: 200,
      y: 250,
    });
  });

  test('zero-size node throws instead of tapping the screen origin', () => {
    const err = (() => {
      try {
        tapPointOf(makeNode({ name: 'Save', bounds: { x: 0, y: 0, width: 0, height: 0 } }));
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('zero size');
    expect((err as AdapterError).message).toContain('button "Save"');
  });

  test('zero width alone (collapsed view) throws', () => {
    expect(() => tapPointOf(makeNode({ bounds: { x: 10, y: 20, width: 0, height: 40 } }))).toThrow(
      AdapterError,
    );
  });

  test('zero height alone throws', () => {
    expect(() => tapPointOf(makeNode({ bounds: { x: 10, y: 20, width: 40, height: 0 } }))).toThrow(
      AdapterError,
    );
  });
});

describe('startArgs', () => {
  test('component form (pkg/.Activity) → am start', () => {
    expect(startArgs('com.example/.MainActivity')).toEqual([
      'am',
      'start',
      '-W',
      '-n',
      'com.example/.MainActivity',
    ]);
  });
  test('package form → monkey launch', () => {
    expect(startArgs('com.example')).toEqual([
      'monkey',
      '-p',
      'com.example',
      '-c',
      'android.intent.category.LAUNCHER',
      '1',
    ]);
  });
  test('empty string → throws AdapterError', () => {
    expect(() => startArgs('')).toThrow(AdapterError);
  });
  test('whitespace-only → throws AdapterError', () => {
    expect(() => startArgs('   ')).toThrow(AdapterError);
  });
  test('shell metacharacters in the target → throws AdapterError (injection)', () => {
    expect(() => startArgs('com.app/.Main; rm -rf /sdcard')).toThrow(AdapterError);
    expect(() => startArgs('com.app/.Main && reboot')).toThrow(AdapterError);
    expect(() => startArgs('com.app$(id)')).toThrow(AdapterError);
    expect(() => startArgs('com.app/.Main`id`')).toThrow(AdapterError);
    expect(() => startArgs('com.app | tee /sdcard/x')).toThrow(AdapterError);
    expect(() => startArgs('com.app\nreboot')).toThrow(AdapterError);
  });
  test('inner class components (pkg/.Outer$Inner) still launch', () => {
    expect(startArgs('com.example/.Main$Inner')).toEqual([
      'am',
      'start',
      '-W',
      '-n',
      'com.example/.Main$Inner',
    ]);
  });
  test('fully qualified component form launches', () => {
    expect(startArgs('com.example/com.example.ui.MainActivity')).toEqual([
      'am',
      'start',
      '-W',
      '-n',
      'com.example/com.example.ui.MainActivity',
    ]);
  });
});

describe('tapArgs', () => {
  test('returns input tap argv', () => {
    expect(tapArgs(270, 500)).toEqual(['input', 'tap', '270', '500']);
  });
});

describe('escapeInputText', () => {
  test('spaces → %s', () => {
    expect(escapeInputText('hello world')).toBe('hello%sworld');
  });
  test('escapes shell-special chars', () => {
    expect(escapeInputText('a&b')).toBe('a\\&b');
    expect(escapeInputText('a|b')).toBe('a\\|b');
    expect(escapeInputText('a$b')).toBe('a\\$b');
  });
  test('escapes # (mksh comment at word start)', () => {
    expect(escapeInputText('#hashtag')).toBe('\\#hashtag');
  });
  test('escapes braces (mksh brace expansion)', () => {
    expect(escapeInputText('{a,b}')).toBe('\\{a,b\\}');
  });
  test('escapes glob/history/legacy chars', () => {
    expect(escapeInputText('a?b')).toBe('a\\?b');
    expect(escapeInputText('[a]')).toBe('\\[a\\]');
    expect(escapeInputText('hi!')).toBe('hi\\!');
    expect(escapeInputText('a^b')).toBe('a\\^b');
    expect(escapeInputText('a=b')).toBe('a\\=b');
  });
  test('plain alphanumerics pass through', () => {
    expect(escapeInputText('hello123')).toBe('hello123');
  });
  test('control chars → throws AdapterError (device-shell injection)', () => {
    expect(() => escapeInputText('hi\nrm -rf /sdcard')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\rreboot')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\tthere')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\x00there')).toThrow(AdapterError);
    expect(() => escapeInputText('hi\x1bthere')).toThrow(AdapterError);
  });
});

describe('splitTextLines', () => {
  test('splits on \\n, \\r\\n and lone \\r', () => {
    expect(splitTextLines('a\nb\r\nc\rd')).toEqual(['a', 'b', 'c', 'd']);
  });
  test('text without line breaks stays one line', () => {
    expect(splitTextLines('hello world')).toEqual(['hello world']);
  });
  test('trailing newline yields a trailing empty line', () => {
    expect(splitTextLines('hi\n')).toEqual(['hi', '']);
  });
});

describe('splitTextForInput', () => {
  test('breaks between % and s so the device never sees a literal %s', () => {
    expect(splitTextForInput('50%sale')).toEqual(['50%', 'sale']);
  });
  test('multiple %s occurrences all split', () => {
    expect(splitTextForInput('%s%s')).toEqual(['%', 's%', 's']);
  });
  test('text without %s stays one chunk', () => {
    expect(splitTextForInput('hello world')).toEqual(['hello world']);
  });
  test('lone % is untouched', () => {
    expect(splitTextForInput('100%')).toEqual(['100%']);
  });
  test('empty text → no chunks', () => {
    expect(splitTextForInput('')).toEqual([]);
  });
});

describe('textArgs', () => {
  test('wraps in input text argv', () => {
    expect(textArgs('hello')).toEqual(['input', 'text', 'hello']);
  });
  test('escapes spaces', () => {
    expect(textArgs('hi there')).toEqual(['input', 'text', 'hi%sthere']);
  });
});

describe('swipeArgs', () => {
  test('returns five-arg input swipe argv', () => {
    expect(swipeArgs(0, 500, 0, 100)).toEqual(['input', 'swipe', '0', '500', '0', '100', '300']);
  });
  test('accepts custom duration', () => {
    expect(swipeArgs(0, 0, 100, 100, 500)).toEqual([
      'input',
      'swipe',
      '0',
      '0',
      '100',
      '100',
      '500',
    ]);
  });
});

describe('scrollSwipe', () => {
  const area: Bounds = { x: 0, y: 0, width: 1080, height: 2400 };

  test('down: finger moves upward (y2 < y1)', () => {
    const { y1, y2 } = scrollSwipe('down', area);
    expect(y1).toBeGreaterThan(y2);
  });
  test('up: finger moves downward (y2 > y1)', () => {
    const { y1, y2 } = scrollSwipe('up', area);
    expect(y2).toBeGreaterThan(y1);
  });
  test('left: finger moves rightward (x2 > x1) to reveal left content', () => {
    const { x1, x2 } = scrollSwipe('left', area);
    // Finger opposes direction: scroll left → drag RIGHT
    expect(x2).toBeGreaterThan(x1);
  });
  test('right: finger moves leftward (x2 < x1) to reveal right content', () => {
    const { x1, x2 } = scrollSwipe('right', area);
    // Finger opposes direction: scroll right → drag LEFT
    expect(x1).toBeGreaterThan(x2);
  });
  test('distance capped to 80% of span', () => {
    const { y1, y2 } = scrollSwipe('down', area, 99999);
    expect(Math.abs(y2 - y1)).toBeLessThanOrEqual(Math.round(area.height * 0.8));
  });
  test('custom amount', () => {
    const { y1, y2 } = scrollSwipe('down', area, 200);
    expect(Math.abs(y2 - y1)).toBeLessThanOrEqual(200);
  });
});

describe('keycodeFor', () => {
  test('maps enter', () => {
    expect(keycodeFor('enter')).toBe('KEYCODE_ENTER');
  });
  test('case-insensitive alias', () => {
    expect(keycodeFor('ENTER')).toBe('KEYCODE_ENTER');
  });
  test('single letter → KEYCODE_A', () => {
    expect(keycodeFor('a')).toBe('KEYCODE_A');
  });
  test('single digit → KEYCODE_5', () => {
    expect(keycodeFor('5')).toBe('KEYCODE_5');
  });
  test('raw KEYCODE_ passthrough (normalized)', () => {
    expect(keycodeFor('KEYCODE_ENTER')).toBe('KEYCODE_ENTER');
  });
  test('f1-f12 keys map to KEYCODE_F*', () => {
    expect(keycodeFor('f1')).toBe('KEYCODE_F1');
    expect(keycodeFor('f12')).toBe('KEYCODE_F12');
  });
  test('unknown token → throws AdapterError', () => {
    expect(() => keycodeFor('f13')).toThrow(AdapterError);
  });
});

describe('keyArgs', () => {
  test('single key → input keyevent', () => {
    expect(keyArgs('enter')).toEqual(['input', 'keyevent', 'KEYCODE_ENTER']);
  });
  test('chord → input keycombination', () => {
    expect(keyArgs('Control+a')).toEqual([
      'input',
      'keycombination',
      'KEYCODE_CTRL_LEFT',
      'KEYCODE_A',
    ]);
  });
  test('empty string → throws AdapterError', () => {
    expect(() => keyArgs('')).toThrow(AdapterError);
  });
});

describe('parseScreenSize', () => {
  test('parses Physical size', () => {
    expect(parseScreenSize('Physical size: 1080x2400')).toEqual({
      x: 0,
      y: 0,
      width: 1080,
      height: 2400,
    });
  });
  test('prefers Override size', () => {
    expect(parseScreenSize('Physical size: 1080x2400\nOverride size: 720x1280')).toEqual({
      x: 0,
      y: 0,
      width: 720,
      height: 1280,
    });
  });
  test('throws AdapterError on missing size', () => {
    expect(() => parseScreenSize('no size here')).toThrow(AdapterError);
  });
});
