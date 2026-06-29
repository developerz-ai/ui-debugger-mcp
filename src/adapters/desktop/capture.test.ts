import { expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import { type CaptureTool, captureArgs, chooseCaptureTool } from './capture.js';

// --- chooseCaptureTool ------------------------------------------------------

test('chooseCaptureTool picks grim on Wayland', () => {
  expect(chooseCaptureTool({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('grim');
});

test('chooseCaptureTool prefers Wayland over X11 when both are set', () => {
  expect(chooseCaptureTool({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' })).toBe('grim');
});

test('chooseCaptureTool picks scrot on X11', () => {
  expect(chooseCaptureTool({ DISPLAY: ':99' })).toBe('scrot');
});

test('chooseCaptureTool throws when neither display is set', () => {
  expect(() => chooseCaptureTool({})).toThrow(AdapterError);
});

// --- captureArgs ------------------------------------------------------------

test('captureArgs writes the PNG to the given file per tool', () => {
  expect(captureArgs('grim', '/tmp/shot.png')).toEqual(['/tmp/shot.png']);
  expect(captureArgs('scrot', '/tmp/shot.png')).toEqual(['--overwrite', '/tmp/shot.png']);
});

test('captureArgs throws on an unknown tool', () => {
  expect(() => captureArgs('snap' as CaptureTool, '/tmp/x.png')).toThrow(AdapterError);
});
