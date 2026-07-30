import { expect, test } from 'bun:test';
import { emulatorLaunchArgs } from './launch.js';

test('the AVD and the explicit port always lead — every later adb call binds that serial', () => {
  const args = emulatorLaunchArgs({ avd: 'test_avd', port: 5554, headless: false });
  expect(args.slice(0, 3)).toEqual(['@test_avd', '-port', '5554']);
});

test('a windowed run gets nothing but the AVD and the port', () => {
  expect(emulatorLaunchArgs({ avd: 'test_avd', port: 5554, headless: false })).toEqual([
    '@test_avd',
    '-port',
    '5554',
  ]);
});

test('a headless run adds -no-window with software GL and no audio', () => {
  expect(emulatorLaunchArgs({ avd: 'test_avd', port: 5560, headless: true })).toEqual([
    '@test_avd',
    '-port',
    '5560',
    '-no-window',
    '-gpu',
    'swiftshader_indirect',
    '-no-audio',
    '-no-boot-anim',
  ]);
});

test('-no-window never ships without software GL — host GL would kill the boot', () => {
  const args = emulatorLaunchArgs({ avd: 'a', port: 5554, headless: true });
  const gpu = args.indexOf('-gpu');
  expect(args).toContain('-no-window');
  expect(gpu).toBeGreaterThan(-1);
  expect(args[gpu + 1]).toBe('swiftshader_indirect');
});

test('extraArgs are appended verbatim, after the headless flags', () => {
  const args = emulatorLaunchArgs({
    avd: 'a',
    port: 5554,
    headless: true,
    extraArgs: ['-http-proxy', 'http://127.0.0.1:8080'],
  });
  expect(args.slice(-2)).toEqual(['-http-proxy', 'http://127.0.0.1:8080']);
});

test('extraArgs work on a windowed run too', () => {
  expect(
    emulatorLaunchArgs({ avd: 'a', port: 5554, headless: false, extraArgs: ['-wipe-data'] }),
  ).toEqual(['@a', '-port', '5554', '-wipe-data']);
});
