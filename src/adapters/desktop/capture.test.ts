import { expect, test } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AdapterError } from '../../errors.js';
import { type CaptureTool, captureArgs, chooseCaptureTool, Screenshot } from './capture.js';
import { desktopEnv, type Exec } from './proc.js';

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

test('chooseCaptureTool picks scrot for an explicit X11 display on a Wayland desktop', () => {
  // Regression: a configured `display: ':99'` (e.g. Xvfb) must capture that X11
  // display, not the inherited live Wayland session.
  const saved = process.env.WAYLAND_DISPLAY;
  process.env.WAYLAND_DISPLAY = 'wayland-0';
  try {
    expect(chooseCaptureTool(desktopEnv(':99'))).toBe('scrot');
  } finally {
    if (saved === undefined) delete process.env.WAYLAND_DISPLAY;
    else process.env.WAYLAND_DISPLAY = saved;
  }
});

// --- captureArgs ------------------------------------------------------------

test('captureArgs writes the PNG to the given file per tool', () => {
  expect(captureArgs('grim', '/tmp/shot.png')).toEqual(['/tmp/shot.png']);
  expect(captureArgs('scrot', '/tmp/shot.png')).toEqual(['--overwrite', '/tmp/shot.png']);
});

test('captureArgs throws on an unknown tool', () => {
  expect(() => captureArgs('snap' as CaptureTool, '/tmp/x.png')).toThrow(AdapterError);
});

// --- Screenshot.capture (temp-file flow) ------------------------------------

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

test('Screenshot.capture writes the tool output to a temp file, reads it back, then cleans up', async () => {
  const bytes = Uint8Array.from([9, 9, 3]);
  const seen: { file?: string } = {};
  const exec: Exec = async (_cmd, args) => {
    const file = args.at(-1);
    if (!file) throw new Error('capture args missing the output file');
    seen.file = file;
    await writeFile(file, bytes);
    return '';
  };
  const capture = new Screenshot({ display: ':99', exec }); // DISPLAY → scrot
  expect(await capture.capture()).toEqual(bytes);
  // The temp dir (and the file inside it) is gone once capture() returns.
  expect(seen.file).toBeDefined();
  expect(await exists(seen.file as string)).toBe(false);
  expect(await exists(dirname(seen.file as string))).toBe(false);
});

test('Screenshot.capture cleans up the temp dir even when the tool fails', async () => {
  const seen: { file?: string } = {};
  const exec: Exec = async (_cmd, args) => {
    seen.file = args.at(-1);
    throw new Error('scrot: cannot open display');
  };
  const capture = new Screenshot({ display: ':99', exec });
  await expect(capture.capture()).rejects.toThrow(AdapterError);
  await expect(capture.capture()).rejects.toThrow(/desktop\.screenshot failed \(scrot\)/);
  expect(seen.file).toBeDefined();
  expect(await exists(dirname(seen.file as string))).toBe(false);
});

test("Screenshot.capture surfaces a missing capture binary's message, not a swallowed failure", async () => {
  const exec: Exec = async () => {
    const error = new Error('spawn scrot ENOENT') as NodeJS.ErrnoException;
    error.code = 'ENOENT';
    throw error;
  };
  const capture = new Screenshot({ display: ':99', exec }); // DISPLAY → scrot
  await expect(capture.capture()).rejects.toThrow(/desktop\.screenshot failed \(scrot\).*ENOENT/);
});
