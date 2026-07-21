import { expect, test } from 'bun:test';
import { AdapterError, ExecTimeoutError } from '../../errors.js';
import type { Node, ScrollDirection } from '../contract.js';
import {
  centerOf,
  clickArgs,
  clickPointOf,
  keyArgs,
  mapKeyChord,
  moveArgs,
  scrollArgs,
  scrollButton,
  searchArgs,
  typeArgs,
  Xdotool,
} from './input.js';

// --- mapKeyChord ------------------------------------------------------------

test('mapKeyChord maps named keys to xdotool keysyms', () => {
  expect(mapKeyChord('Enter')).toBe('Return');
  expect(mapKeyChord('Escape')).toBe('Escape');
  expect(mapKeyChord('Backspace')).toBe('BackSpace');
  expect(mapKeyChord('ArrowUp')).toBe('Up');
  expect(mapKeyChord('PageDown')).toBe('Next');
});

test('mapKeyChord maps modifier chords (case-insensitive, split on +)', () => {
  expect(mapKeyChord('Control+a')).toBe('ctrl+a');
  expect(mapKeyChord('Cmd+Shift+z')).toBe('super+shift+z');
  expect(mapKeyChord('Alt+Tab')).toBe('alt+Tab');
});

test('mapKeyChord passes unknown keysyms through verbatim', () => {
  expect(mapKeyChord('F5')).toBe('F5');
  expect(mapKeyChord('a')).toBe('a');
});

test('mapKeyChord throws on an empty key', () => {
  expect(() => mapKeyChord('')).toThrow(AdapterError);
  expect(() => mapKeyChord('  ')).toThrow(AdapterError);
  expect(() => mapKeyChord('+')).toThrow(AdapterError);
});

// --- scrollButton -----------------------------------------------------------

test('scrollButton maps each direction onto its X11 wheel button', () => {
  expect(scrollButton('up')).toBe(4);
  expect(scrollButton('down')).toBe(5);
  expect(scrollButton('left')).toBe(6);
  expect(scrollButton('right')).toBe(7);
});

test('scrollButton throws on an unknown direction', () => {
  expect(() => scrollButton('diagonal' as ScrollDirection)).toThrow(AdapterError);
});

// --- centerOf ---------------------------------------------------------------

test('centerOf returns the rounded integer center of a rectangle', () => {
  expect(centerOf({ x: 10, y: 20, width: 100, height: 40 })).toEqual({ x: 60, y: 40 });
  expect(centerOf({ x: 0, y: 0, width: 3, height: 3 })).toEqual({ x: 2, y: 2 });
});

// --- clickPointOf -----------------------------------------------------------

const sized = (width: number, height: number, name = 'OK'): Node => ({
  role: 'button',
  name,
  bounds: { x: 10, y: 20, width, height },
  enabled: true,
});

test('clickPointOf returns the center of a node with real bounds', () => {
  expect(clickPointOf(sized(100, 40))).toEqual({ x: 60, y: 40 });
});

test('clickPointOf refuses a zero-size node (its center is the screen origin)', () => {
  expect(() => clickPointOf(sized(0, 0))).toThrow(AdapterError);
  expect(() => clickPointOf(sized(0, 0))).toThrow(/button "OK" has zero size \(0x0\)/);
  expect(() => clickPointOf(sized(50, 0))).toThrow(/zero size \(50x0\)/); // one axis is enough
  expect(() => clickPointOf(sized(0, 0, ''))).toThrow(/^desktop: button has zero size/); // unnamed
});

test('clickArgs moves then clicks the given button', () => {
  expect(clickArgs(60, 40)).toEqual(['mousemove', '--sync', '60', '40', 'click', '1']);
  expect(clickArgs(1, 2, 3)).toEqual(['mousemove', '--sync', '1', '2', 'click', '3']);
});

test('moveArgs parks the cursor', () => {
  expect(moveArgs(5, 6)).toEqual(['mousemove', '--sync', '5', '6']);
});

test('typeArgs guards dash-leading text with --', () => {
  expect(typeArgs('-rf hi')).toEqual(['type', '--clearmodifiers', '--', '-rf hi']);
});

test('keyArgs maps the chord', () => {
  expect(keyArgs('Control+a')).toEqual(['key', '--clearmodifiers', 'ctrl+a']);
});

test('scrollArgs repeats the wheel button N times', () => {
  expect(scrollArgs('down', 3)).toEqual(['click', '--repeat', '3', '5']);
});

test('scrollArgs rejects a non-positive repeat', () => {
  expect(() => scrollArgs('down', 0)).toThrow(AdapterError);
  expect(() => scrollArgs('down', 1.5)).toThrow(AdapterError);
});

// --- searchArgs -------------------------------------------------------------

test('searchArgs prefers title, falls back to class', () => {
  expect(searchArgs({ title: 'My App' })).toEqual(['search', '--onlyvisible', '--name', 'My App']);
  expect(searchArgs({ class: 'myapp' })).toEqual(['search', '--onlyvisible', '--class', 'myapp']);
});

test('searchArgs throws when neither title nor class is given', () => {
  expect(() => searchArgs({})).toThrow(AdapterError);
});

// --- activateWindow -----------------------------------------------------------

/** A rejecting exec shaped like a promisified `execFile` failure (carries `stderr`). */
function rejectingExec(stderr: string): { exec: () => Promise<string>; calls: () => number } {
  let calls = 0;
  const exec = async (): Promise<string> => {
    calls += 1;
    throw Object.assign(new Error('Command failed: xdotool search'), { stderr });
  };
  return { exec, calls: () => calls };
}

test('activateWindow keeps polling on a no-match (empty stderr) and times out loud', async () => {
  const fake = rejectingExec('');
  const input = new Xdotool({ exec: fake.exec });
  await expect(input.activateWindow({ title: 'App' }, 200)).rejects.toThrow(
    /window not found within 200ms/,
  );
  expect(fake.calls()).toBeGreaterThan(1); // it polled, not failed on the first miss
});

test('activateWindow surfaces an expired per-call cap instead of polling on', async () => {
  // A timeout rejects with no stderr — the shape the no-match branch keeps polling on.
  let calls = 0;
  const exec = async (): Promise<string> => {
    calls += 1;
    throw new ExecTimeoutError('desktop: `xdotool` timed out after 10000ms (SIGKILLed)');
  };
  const input = new Xdotool({ exec });
  await expect(input.activateWindow({ title: 'App' }, 10_000)).rejects.toThrow(ExecTimeoutError);
  expect(calls).toBe(1); // a wedged xdotool is not "no window yet"
});

test('a wedged xdotool action surfaces verbatim, not re-prefixed', async () => {
  const exec = async (): Promise<string> => {
    throw new ExecTimeoutError('desktop: `xdotool` timed out after 10000ms (SIGKILLed)');
  };
  await expect(new Xdotool({ exec }).clickPoint(10, 20)).rejects.toThrow(
    /^desktop: `xdotool` timed out after 10000ms/,
  );
});

test('activateWindow throws immediately when xdotool reports a real error on stderr', async () => {
  const fake = rejectingExec("Error: Can't open display: :99\n");
  const input = new Xdotool({ exec: fake.exec });
  const promise = input.activateWindow({ title: 'App' }, 10_000);
  await expect(promise).rejects.toThrow(AdapterError);
  await expect(promise).rejects.toThrow(/Can't open display: :99/);
  expect(fake.calls()).toBe(1); // no 10s poll masking the root cause
});
