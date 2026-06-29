import { expect, test } from 'bun:test';
import type { DesktopTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import type { Node, ScrollDirection } from '../contract.js';
import type { AtspiNode, AtspiReadOptions, AtspiSource } from './atspi.js';
import type { ScreenCapture } from './capture.js';
import { DesktopAdapter, scrollRepeat } from './desktop-adapter.js';
import type { PointerInput, WindowMatch } from './input.js';

// --- fakes ------------------------------------------------------------------

const atspiNode = (over: Partial<AtspiNode>): AtspiNode => ({
  role: 'button',
  name: 'OK',
  bounds: { x: 10, y: 20, width: 100, height: 40 }, // center (60, 40)
  enabled: true,
  visible: true,
  ...over,
});

class FakeAtspi implements AtspiSource {
  constructor(readonly nodes: AtspiNode[]) {}
  async readTree(_opts?: AtspiReadOptions): Promise<AtspiNode[]> {
    return this.nodes;
  }
}

class FakePointer implements PointerInput {
  readonly calls: string[] = [];
  async clickPoint(x: number, y: number): Promise<void> {
    this.calls.push(`click:${x},${y}`);
  }
  async move(x: number, y: number): Promise<void> {
    this.calls.push(`move:${x},${y}`);
  }
  async typeText(text: string): Promise<void> {
    this.calls.push(`type:${text}`);
  }
  async key(chord: string): Promise<void> {
    this.calls.push(`key:${chord}`);
  }
  async scroll(direction: ScrollDirection, repeat: number): Promise<void> {
    this.calls.push(`scroll:${direction}:${repeat}`);
  }
  async activateWindow(match: WindowMatch): Promise<void> {
    this.calls.push(`activate:${JSON.stringify(match)}`);
  }
}

class FakeCapture implements ScreenCapture {
  async capture(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3]);
  }
}

const config: DesktopTarget = { adapter: 'desktop', launch: 'true' };

function build(nodes: AtspiNode[] = [atspiNode({})]): {
  adapter: DesktopAdapter;
  input: FakePointer;
} {
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config,
    atspi: new FakeAtspi(nodes),
    input,
    capture: new FakeCapture(),
  });
  return { adapter, input };
}

// --- readState / find -------------------------------------------------------

test('readState normalizes the a11y tree and applies a query', async () => {
  const { adapter } = build([atspiNode({ name: 'OK' }), atspiNode({ name: 'Cancel' })]);
  const nodes = await adapter.readState({ query: 'OK' });
  expect(nodes.map((n) => n.name)).toEqual(['OK']);
  expect(nodes[0]).not.toHaveProperty('visible');
});

test('find returns the first matching node, or null', async () => {
  const { adapter } = build([atspiNode({ name: 'OK' })]);
  expect((await adapter.find({ query: 'OK' }))?.name).toBe('OK');
  expect(await adapter.find({ query: 'Nope' })).toBeNull();
});

// --- click / type -----------------------------------------------------------

test('click resolves a selector and clicks the node center', async () => {
  const { adapter, input } = build([atspiNode({ name: 'OK' })]);
  await adapter.click('OK');
  expect(input.calls).toEqual(['click:60,40']);
});

test('click uses a Node ref directly (no resolve)', async () => {
  const { adapter, input } = build([]);
  const node: Node = {
    role: 'button',
    name: 'X',
    bounds: { x: 0, y: 0, width: 20, height: 20 },
    enabled: true,
  };
  await adapter.click(node);
  expect(input.calls).toEqual(['click:10,10']);
});

test('click throws when a selector matches nothing', async () => {
  const { adapter } = build([]);
  await expect(adapter.click('Ghost')).rejects.toThrow(AdapterError);
});

test('type focuses (click) then types', async () => {
  const { adapter, input } = build([atspiNode({ name: 'OK' })]);
  await adapter.type('OK', 'hello');
  expect(input.calls).toEqual(['click:60,40', 'type:hello']);
});

// --- pressKey ---------------------------------------------------------------

test('pressKey forwards the chord; rejects an empty key', async () => {
  const { adapter, input } = build();
  await adapter.pressKey('Control+a');
  expect(input.calls).toEqual(['key:Control+a']);
  await expect(adapter.pressKey('  ')).rejects.toThrow(AdapterError);
});

// --- scroll -----------------------------------------------------------------

test('scroll maps amount to wheel repeats', async () => {
  const { adapter, input } = build();
  await adapter.scroll({ direction: 'down' });
  expect(input.calls).toEqual(['scroll:down:3']); // default 360px / 120 = 3
});

test('scroll within a region parks the cursor first', async () => {
  const { adapter, input } = build();
  const region: Node = {
    role: 'list',
    name: 'L',
    bounds: { x: 0, y: 0, width: 100, height: 100 }, // center (50, 50)
    enabled: true,
  };
  await adapter.scroll({ direction: 'up', amount: 240, within: region });
  expect(input.calls).toEqual(['move:50,50', 'scroll:up:2']);
});

test('scrollRepeat maps pixels to a positive integer click count', () => {
  expect(scrollRepeat()).toBe(3);
  expect(scrollRepeat(240)).toBe(2);
  expect(scrollRepeat(10)).toBe(1); // never zero
});

// --- screenshot -------------------------------------------------------------

test('screenshot returns the capture bytes', async () => {
  const { adapter } = build();
  expect(await adapter.screenshot()).toEqual(new Uint8Array([1, 2, 3]));
});

// --- waitFor ----------------------------------------------------------------

test('waitFor resolves once the query is present', async () => {
  const { adapter } = build([atspiNode({ name: 'OK' })]);
  await expect(adapter.waitFor({ query: 'OK', timeout: 1000 })).resolves.toBeUndefined();
});

test('waitFor times out loud when the query never appears', async () => {
  const { adapter } = build([]);
  await expect(adapter.waitFor({ query: 'Ghost', timeout: 0 })).rejects.toThrow(AdapterError);
});

test('waitFor rejects networkIdle and an empty wait (unsupported on desktop)', async () => {
  const { adapter } = build();
  await expect(adapter.waitFor({ networkIdle: true })).rejects.toThrow(AdapterError);
  await expect(adapter.waitFor({})).rejects.toThrow(AdapterError);
});

// --- console / network / close ----------------------------------------------

test('console and network are unsupported and throw loud', async () => {
  const { adapter } = build();
  await expect(adapter.console()).rejects.toThrow(AdapterError);
  await expect(adapter.network()).rejects.toThrow(AdapterError);
});

test('close is a no-op when nothing was launched', async () => {
  const { adapter } = build();
  await expect(adapter.close()).resolves.toBeUndefined();
});
