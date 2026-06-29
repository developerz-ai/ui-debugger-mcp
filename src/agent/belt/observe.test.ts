import { expect, test } from 'bun:test';
import type {
  Adapter,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  Query,
} from '../../adapters/contract.js';
import { AdapterError } from '../../errors.js';
import { createObserveTool, ObserveInputSchema, runObserve } from './observe.js';

/** Recorded opts the fake adapter was last called with (to assert param forwarding). */
interface Recorder {
  readState?: Query;
  console?: LogQuery;
  network?: LogQuery;
  screenshots: number;
}

interface FakeReturns {
  nodes?: Node[];
  console?: ConsoleEntry[];
  network?: NetworkEntry[];
  screenshot?: Uint8Array;
}

/** A fake {@link Adapter} that records the opts it receives and returns canned data. */
function fakeAdapter(returns: FakeReturns): { adapter: Adapter; rec: Recorder } {
  const rec: Recorder = { screenshots: 0 };
  const adapter: Adapter = {
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async (opts: Query = {}) => {
      rec.readState = opts;
      return returns.nodes ?? [];
    },
    screenshot: async () => {
      rec.screenshots += 1;
      return returns.screenshot ?? new Uint8Array();
    },
    waitFor: async () => {},
    console: async (opts: LogQuery = {}) => {
      rec.console = opts;
      return returns.console ?? [];
    },
    network: async (opts: LogQuery = {}) => {
      rec.network = opts;
      return returns.network ?? [];
    },
    close: async () => {},
  };
  return { adapter, rec };
}

const sampleNode: Node = {
  role: 'button',
  name: 'Save',
  bounds: { x: 1, y: 2, width: 3, height: 4 },
  enabled: true,
};

test('tree → routes to readState, returns nodes + count + a ready target', async () => {
  const { adapter } = fakeAdapter({ nodes: [sampleNode] });
  const res = await runObserve(adapter, { kind: 'tree' });
  expect(res).toEqual({
    kind: 'tree',
    count: 1,
    nodes: [{ ...sampleNode, target: 'role=button[name="Save" i]' }],
  });
});

test('tree fields → projects only the requested columns, still attaches a target', async () => {
  const { adapter } = fakeAdapter({ nodes: [sampleNode] });
  const res = await runObserve(adapter, { kind: 'tree', fields: ['role', 'name'] });
  expect(res).toEqual({
    kind: 'tree',
    count: 1,
    nodes: [{ role: 'button', name: 'Save', target: 'role=button[name="Save" i]' }],
  });
});

test('tree → disambiguates repeated role+name with >> nth in document order', async () => {
  const dup: Node = { ...sampleNode, name: 'Add to cart' };
  const { adapter } = fakeAdapter({ nodes: [dup, dup, dup] });
  const res = await runObserve(adapter, { kind: 'tree', fields: ['name'] });
  const targets = (res as { nodes: Array<{ target?: string }> }).nodes.map((n) => n.target);
  expect(targets).toEqual([
    'role=button[name="Add to cart" i]',
    'role=button[name="Add to cart" i] >> nth=1',
    'role=button[name="Add to cart" i] >> nth=2',
  ]);
});

test('tree → non-ARIA named node falls back to a text target', async () => {
  const div: Node = { role: 'generic', name: 'Hello', bounds: sampleNode.bounds, enabled: true };
  const { adapter } = fakeAdapter({ nodes: [div] });
  const res = await runObserve(adapter, { kind: 'tree', fields: ['role'] });
  expect((res as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBe('text=Hello');
});

test('tree scoped by within or filters → omits target (unscoped replay could miss)', async () => {
  const scoped = await runObserve(fakeAdapter({ nodes: [sampleNode] }).adapter, {
    kind: 'tree',
    within: 'main',
  });
  expect((scoped as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBeUndefined();

  const filtered = await runObserve(fakeAdapter({ nodes: [sampleNode] }).adapter, {
    kind: 'tree',
    filters: { visible_eq: true },
  });
  expect((filtered as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBeUndefined();
});

test('tree forwards query/filters/limit/within to the adapter', async () => {
  const { adapter, rec } = fakeAdapter({ nodes: [] });
  await runObserve(adapter, {
    kind: 'tree',
    query: 'button',
    filters: { visible_eq: true },
    limit: 5,
    within: 'main',
  });
  expect(rec.readState).toEqual({
    query: 'button',
    filters: { visible_eq: true },
    limit: 5,
    within: 'main',
  });
});

test('screenshot → routes to screenshot, returns base64 png + byte count', async () => {
  const png = new Uint8Array([1, 2, 3, 4]);
  const { adapter, rec } = fakeAdapter({ screenshot: png });
  const res = await runObserve(adapter, { kind: 'screenshot' });
  expect(res).toEqual({
    kind: 'screenshot',
    encoding: 'png',
    bytes: 4,
    data: Buffer.from(png).toString('base64'),
  });
  expect(rec.screenshots).toBe(1);
});

test('console → returns entries + count, forwards filters/limit', async () => {
  const entry: ConsoleEntry = { level: 'error', text: 'boom', timestamp: 1 };
  const { adapter, rec } = fakeAdapter({ console: [entry] });
  const res = await runObserve(adapter, {
    kind: 'console',
    filters: { level_eq: 'error' },
    limit: 10,
  });
  expect(res).toEqual({ kind: 'console', count: 1, entries: [entry] });
  expect(rec.console).toEqual({ filters: { level_eq: 'error' }, limit: 10 });
});

test('network → returns entries + count', async () => {
  const entry: NetworkEntry = {
    method: 'GET',
    url: 'http://x',
    status: 500,
    ok: false,
    timestamp: 2,
  };
  const { adapter } = fakeAdapter({ network: [entry] });
  const res = await runObserve(adapter, { kind: 'network' });
  expect(res).toEqual({ kind: 'network', count: 1, entries: [entry] });
});

test('adapter errors propagate (fail loud, no swallow)', async () => {
  const { adapter } = fakeAdapter({});
  adapter.console = async () => {
    throw new AdapterError('unknown console filter `bogus`');
  };
  await expect(runObserve(adapter, { kind: 'console', filters: { bogus: 1 } })).rejects.toThrow(
    AdapterError,
  );
});

test('schema rejects an unknown kind', () => {
  expect(ObserveInputSchema.safeParse({ kind: 'dom' }).success).toBe(false);
});

test('schema rejects an unknown field column', () => {
  expect(ObserveInputSchema.safeParse({ kind: 'tree', fields: ['href'] }).success).toBe(false);
});

test('schema accepts a minimal tree read', () => {
  expect(ObserveInputSchema.safeParse({ kind: 'tree' }).success).toBe(true);
});

test('createObserveTool exposes a described tool with an input schema', () => {
  const { adapter } = fakeAdapter({});
  const observe = createObserveTool(adapter);
  expect(typeof observe.description).toBe('string');
  expect(observe.inputSchema).toBeDefined();
});
