/**
 * Shared fakes for android-adapter.*.test.ts — faked ADB/UiAutomator seams so tests
 * never need a real device or emulator. Split out so each test file (lifecycle,
 * behavior, parsers) stays under the file-size cap without duplicating fixtures.
 *
 * Both fakes record the DEADLINE they were handed (the absolute instant the enclosing
 * budget runs out) so the budget regressions can assert that a native call was bounded
 * by it — and both can simulate a call that answers only AFTER that deadline, which
 * the adapter must reject instead of reporting success.
 */

import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { Adb } from './adb.js';
import { AndroidAdapter, type AndroidAdapterInit } from './android-adapter.js';
import type { AndroidNode, UiAutomatorSource } from './uiautomator.js';

/** Sleep helper — the fakes use it to simulate a slow device round-trip. */
export const fakeDelay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

/** One recorded call on the fake ADB seam — with the deadline it was handed, if any. */
export interface FakeAdbCall {
  method: string;
  args: string[];
  /** The absolute deadline (epoch ms) the caller bound this call by, if any. */
  deadline?: number;
}

/** Fake ADB seam — records calls (and the serial it was bound to) for assertions. */
export class FakeAdb implements Adb {
  readonly serial: string;
  calls: FakeAdbCall[] = [];
  responses: Map<string, string | Uint8Array> = new Map();
  /** Per-call artificial latency, keyed like `responses` (`'adb get-state'`, `'shell input tap …'`). */
  slow: Map<string, number> = new Map();

  constructor(serial = 'emulator-fake') {
    this.serial = serial;
  }

  setResponse(key: string, value: string | Uint8Array): void {
    this.responses.set(key, value);
  }

  /** Make the call answering `key` take `ms` — it still answers, just late. */
  setSlow(key: string, ms: number): void {
    this.slow.set(key, ms);
  }

  private get(key: string): string {
    const v = this.responses.get(key);
    return typeof v === 'string' ? v : '';
  }

  /** The recorded call matching `method` + `args` (the last one, if repeated). */
  findCall(method: string, ...args: string[]): FakeAdbCall | undefined {
    return [...this.calls]
      .reverse()
      .find((c) => c.method === method && c.args.join(' ') === args.join(' '));
  }

  async shell(command: string[], deadline?: number): Promise<string> {
    this.calls.push({ method: 'shell', args: command, deadline });
    const key = command.join(' ');
    await this.#linger(key);
    if (this.responses.has(key)) return this.get(key);
    // Default sensible responses so basic flows succeed without explicit setup.
    if (command[0] === 'getprop') return '1';
    if (command[0] === 'wm') return 'Physical size: 1080x2400';
    if (command[0] === 'logcat') return '';
    return '';
  }

  async execOut(command: string[], deadline?: number): Promise<Uint8Array> {
    this.calls.push({ method: 'execOut', args: command, deadline });
    const key = command.join(' ');
    await this.#linger(key);
    const v = this.responses.get(key);
    if (v instanceof Uint8Array) return v;
    return new Uint8Array([1, 2, 3]);
  }

  async adb(args: string[], deadline?: number): Promise<string> {
    this.calls.push({ method: 'adb', args, deadline });
    const key = `adb ${args.join(' ')}`;
    await this.#linger(key);
    if (this.responses.has(key)) return this.get(key);
    // Default: a device is connected, so managed boots proceed.
    if (args[0] === 'get-state') return 'device';
    return '';
  }

  /**
   * Simulate a slow device round-trip. The call still answers — it just answers late,
   * possibly after the deadline it was handed, so the adapter's own deadline guard is
   * what has to catch it.
   */
  async #linger(key: string): Promise<void> {
    const ms = this.slow.get(key);
    if (ms === undefined) return;
    await fakeDelay(ms);
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

/**
 * Pin emulator resolution so managed-boot tests are hermetic: the default seam
 * consults the host's SDK layout and PATH, so the spawned binary — and even
 * whether managed boot succeeds at all — would otherwise vary by machine.
 * The stub is a structural literal typed through
 * {@link AndroidAdapterInit}['resolveBin']; this module deliberately never
 * imports `sdk.js`.
 */
export function stubResolveBin(bin = 'emulator'): NonNullable<AndroidAdapterInit['resolveBin']> {
  return () => ({ bin, origin: 'path', where: 'PATH (test stub)' });
}

/** Fake UiAutomatorSource seam. */
export class FakeUi implements UiAutomatorSource {
  private nodes: AndroidNode[];
  calls = 0;
  /** The deadline (epoch ms) each dump was handed, in call order. */
  deadlines: Array<number | undefined> = [];
  /** Artificial latency of the next dump(s) in ms — the dump answers, just late. */
  slowMs = 0;

  constructor(nodes: AndroidNode[] = []) {
    this.nodes = nodes;
  }

  setNodes(nodes: AndroidNode[]): void {
    this.nodes = nodes;
  }

  /** Make every dump take `ms` — it still answers, possibly after its deadline. */
  setSlow(ms: number): void {
    this.slowMs = ms;
  }

  async dump(deadline?: number): Promise<AndroidNode[]> {
    this.calls++;
    this.deadlines.push(deadline);
    if (this.slowMs > 0) await fakeDelay(this.slowMs);
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
    config: opts.config ?? { adapter: 'android', headless: true, avd: 'test_avd' },
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
    config: { adapter: 'android', headless: true, avd: 'test_avd', adbSerial: serial },
    adb,
    ui,
  });
  return { adapter, adb, ui };
}
