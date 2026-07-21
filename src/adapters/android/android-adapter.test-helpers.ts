/**
 * Shared fakes for android-adapter.*.test.ts — faked ADB/UiAutomator seams so tests
 * never need a real device or emulator. Split out so each test file (lifecycle,
 * behavior, parsers) stays under the file-size cap without duplicating fixtures.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Adb } from './adb.js';
import { AndroidAdapter, type AndroidAdapterInit } from './android-adapter.js';
import type { AndroidNode, UiAutomatorSource } from './uiautomator.js';

/** Build a minimal valid AndroidNode. */
export function makeNode(overrides: Partial<AndroidNode> = {}): AndroidNode {
  return {
    role: 'button',
    name: 'Save',
    bounds: { x: 0, y: 0, width: 100, height: 50 },
    enabled: true,
    clickable: true,
    scrollable: false,
    focusable: true,
    resourceId: 'com.app:id/save',
    ...overrides,
  };
}

/** Fake ADB seam — records calls (and the serial it was bound to) for assertions. */
export class FakeAdb implements Adb {
  readonly serial: string;
  calls: Array<{ method: string; args: string[] }> = [];
  responses: Map<string, string | Uint8Array> = new Map();

  constructor(serial = 'emulator-fake') {
    this.serial = serial;
  }

  setResponse(key: string, value: string | Uint8Array): void {
    this.responses.set(key, value);
  }

  private get(key: string): string {
    const v = this.responses.get(key);
    return typeof v === 'string' ? v : '';
  }

  async shell(command: string[]): Promise<string> {
    this.calls.push({ method: 'shell', args: command });
    const key = command.join(' ');
    if (this.responses.has(key)) return this.get(key);
    // Default sensible responses so basic flows succeed without explicit setup.
    if (command[0] === 'getprop') return '1';
    if (command[0] === 'wm') return 'Physical size: 1080x2400';
    if (command[0] === 'logcat') return '';
    return '';
  }

  async execOut(command: string[]): Promise<Uint8Array> {
    this.calls.push({ method: 'execOut', args: command });
    const key = command.join(' ');
    const v = this.responses.get(key);
    if (v instanceof Uint8Array) return v;
    return new Uint8Array([1, 2, 3]);
  }

  async adb(args: string[]): Promise<string> {
    this.calls.push({ method: 'adb', args });
    const key = `adb ${args.join(' ')}`;
    if (this.responses.has(key)) return this.get(key);
    // Default: a device is connected, so managed boots proceed.
    if (args[0] === 'get-state') return 'device';
    return '';
  }
}

/**
 * Minimal fake emulator child for the spawn seam — an EventEmitter with a pid.
 * Pass `undefined` when the test calls `close`, so the real `process.kill` is skipped.
 */
export function makeFakeEmulator(pid: number | undefined = 4242): ChildProcess {
  const child = new EventEmitter() as unknown as ChildProcess;
  (child as { pid?: number }).pid = pid;
  return child;
}

/** Fake UiAutomatorSource seam. */
export class FakeUi implements UiAutomatorSource {
  private nodes: AndroidNode[];
  calls = 0;

  constructor(nodes: AndroidNode[] = []) {
    this.nodes = nodes;
  }

  setNodes(nodes: AndroidNode[]): void {
    this.nodes = nodes;
  }

  async dump(): Promise<AndroidNode[]> {
    this.calls++;
    return this.nodes;
  }
}

/** Build a test AndroidAdapter with fake seams. */
export function makeAdapter(opts: Partial<AndroidAdapterInit> & { nodes?: AndroidNode[] } = {}): {
  adapter: AndroidAdapter;
  adb: FakeAdb;
  ui: FakeUi;
} {
  const adb = new FakeAdb();
  const ui = new FakeUi(opts.nodes ?? []);
  const adapter = AndroidAdapter.create({
    config: opts.config ?? { adapter: 'android', avd: 'test_avd' },
    adb,
    ui,
  });
  return { adapter, adb, ui };
}

export function makeAttachAdapter(
  serial = 'emulator-5554',
  nodes: AndroidNode[] = [],
): { adapter: AndroidAdapter; adb: FakeAdb; ui: FakeUi } {
  const adb = new FakeAdb();
  const ui = new FakeUi(nodes);
  const adapter = AndroidAdapter.create({
    config: { adapter: 'android', avd: 'test_avd', adbSerial: serial },
    adb,
    ui,
  });
  return { adapter, adb, ui };
}
