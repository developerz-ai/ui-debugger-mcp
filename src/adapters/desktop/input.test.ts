import { expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import type { ScrollDirection } from '../contract.js';
import {
  centerOf,
  clickArgs,
  keyArgs,
  mapKeyChord,
  moveArgs,
  scrollArgs,
  scrollButton,
  searchArgs,
  typeArgs,
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

// --- arg builders -----------------------------------------------------------

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
