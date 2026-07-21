import { expect, test } from 'bun:test';
import type {
  Adapter,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  Query,
} from '../../adapters/contract.js';
import { AdapterError, AgentError } from '../../errors.js';
import type { EvidenceRecorder } from './look.js';
import { coerceWithin, createObserveTool, ObserveInputSchema, runObserve } from './observe.js';

/** A fake {@link EvidenceRecorder} recording every saved frame. */
function fakeEvidenceRecorder(): {
  recorder: EvidenceRecorder;
  saved: Array<{ label: string; data: Uint8Array }>;
} {
  const saved: Array<{ label: string; data: Uint8Array }> = [];
  const recorder: EvidenceRecorder = {
    saveScreenshot: async (label, data) => {
      saved.push({ label, data });
      return `screenshots/001-${label}.png`;
    },
  };
  return { recorder, saved };
}

/** Shorthand: a throwaway recorder for reads that never save a frame. */
function recorder(): EvidenceRecorder {
  return fakeEvidenceRecorder().recorder;
}

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
  const res = await runObserve(adapter, recorder(), { kind: 'tree' });
  expect(res).toEqual({
    kind: 'tree',
    count: 1,
    nodes: [{ ...sampleNode, target: 'role=button[name="Save" i]' }],
  });
});

test('tree fields → projects only the requested columns, still attaches a target', async () => {
  const { adapter } = fakeAdapter({ nodes: [sampleNode] });
  const res = await runObserve(adapter, recorder(), { kind: 'tree', fields: ['role', 'name'] });
  expect(res).toEqual({
    kind: 'tree',
    count: 1,
    nodes: [{ role: 'button', name: 'Save', target: 'role=button[name="Save" i]' }],
  });
});

test('tree → disambiguates repeated role+name with >> nth in document order', async () => {
  const dup: Node = { ...sampleNode, name: 'Add to cart' };
  const { adapter } = fakeAdapter({ nodes: [dup, dup, dup] });
  const res = await runObserve(adapter, recorder(), { kind: 'tree', fields: ['name'] });
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
  const res = await runObserve(adapter, recorder(), { kind: 'tree', fields: ['role'] });
  expect((res as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBe('text=Hello');
});

test('tree scoped by query, within or filters → omits target (unscoped replay could miss)', async () => {
  const scoped = await runObserve(fakeAdapter({ nodes: [sampleNode] }).adapter, recorder(), {
    kind: 'tree',
    within: 'main',
  });
  expect((scoped as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBeUndefined();

  const filtered = await runObserve(fakeAdapter({ nodes: [sampleNode] }).adapter, recorder(), {
    kind: 'tree',
    filters: { visible_eq: true },
  });
  expect((filtered as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBeUndefined();

  // A query narrows the node set exactly like within/filters do: the emitted
  // nth= indices would be relative to the narrowed set, while act replays them
  // document-wide — so query-narrowed reads must omit targets too.
  const queried = await runObserve(fakeAdapter({ nodes: [sampleNode] }).adapter, recorder(), {
    kind: 'tree',
    query: '.sidebar button',
  });
  expect((queried as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBeUndefined();
});

test('tree forwards query/filters/limit/within to the adapter', async () => {
  const { adapter, rec } = fakeAdapter({ nodes: [] });
  await runObserve(adapter, recorder(), {
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

test('screenshot → saves the frame as evidence, returns its path + byte count (never base64)', async () => {
  const png = new Uint8Array([1, 2, 3, 4]);
  const { adapter, rec } = fakeAdapter({ screenshot: png });
  const { recorder: evidence, saved } = fakeEvidenceRecorder();
  const res = await runObserve(adapter, evidence, { kind: 'screenshot' });
  expect(res).toEqual({ kind: 'screenshot', path: 'screenshots/001-observe.png', bytes: 4 });
  expect(saved).toEqual([{ label: 'observe', data: png }]);
  expect(rec.screenshots).toBe(1);
  // The blind driver's context must never carry the frame bytes.
  expect(JSON.stringify(res)).not.toContain(Buffer.from(png).toString('base64'));
});

test('console → returns entries + count, forwards filters/limit', async () => {
  const entry: ConsoleEntry = { level: 'error', text: 'boom', timestamp: 1 };
  const { adapter, rec } = fakeAdapter({ console: [entry] });
  const res = await runObserve(adapter, recorder(), {
    kind: 'console',
    filters: { level_eq: 'error' },
    limit: 10,
  });
  expect(res).toEqual({ kind: 'console', count: 1, entries: [entry] });
  expect(rec.console).toEqual({ filters: { level_eq: 'error' }, limit: 10 });
});

test('console/network default to a bounded tail — chatty pages never flood context', async () => {
  const { adapter, rec } = fakeAdapter({});
  await runObserve(adapter, recorder(), { kind: 'console' });
  await runObserve(adapter, recorder(), { kind: 'network', filters: { status_gte: 400 } });
  expect(rec.console).toEqual({ filters: undefined, limit: 50 });
  expect(rec.network).toEqual({ filters: { status_gte: 400 }, limit: 50 });
});

test('an explicit log limit wins over the default — including 0', async () => {
  const { adapter, rec } = fakeAdapter({});
  await runObserve(adapter, recorder(), { kind: 'console', limit: 200 });
  expect(rec.console?.limit).toBe(200);
  await runObserve(adapter, recorder(), { kind: 'network', limit: 0 });
  expect(rec.network?.limit).toBe(0);
});

test('tree limit is NOT defaulted — the adapter owns the tree cap', async () => {
  const { adapter, rec } = fakeAdapter({});
  await runObserve(adapter, recorder(), { kind: 'tree' });
  expect(rec.readState?.limit).toBeUndefined();
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
  const res = await runObserve(adapter, recorder(), { kind: 'network' });
  expect(res).toEqual({ kind: 'network', count: 1, entries: [entry] });
});

test('adapter errors propagate (fail loud, no swallow)', async () => {
  const { adapter } = fakeAdapter({});
  adapter.console = async () => {
    throw new AdapterError('unknown console filter `bogus`');
  };
  await expect(
    runObserve(adapter, recorder(), { kind: 'console', filters: { bogus: 1 } }),
  ).rejects.toThrow(AdapterError);
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
  const observe = createObserveTool(adapter, recorder());
  expect(typeof observe.description).toBe('string');
  expect(observe.inputSchema).toBeDefined();
});

test('tree → a node with a testid gets a data-testid target (beats role/name)', async () => {
  const counted: Node = { ...sampleNode, role: 'span', name: '0', testid: 'cart-count' };
  const { adapter } = fakeAdapter({ nodes: [counted] });
  const res = await runObserve(adapter, recorder(), { kind: 'tree' });
  expect((res as { nodes: Array<{ target?: string }> }).nodes[0]?.target).toBe(
    'data-testid="cart-count"',
  );
});

test('tree scoped → keeps a data-testid target (document-unique, survives scoping)', async () => {
  const counted: Node = { ...sampleNode, role: 'span', name: '0', testid: 'cart-count' };
  const { adapter } = fakeAdapter({ nodes: [counted, sampleNode] });
  const res = await runObserve(adapter, recorder(), { kind: 'tree', query: 'header' });
  const targets = (res as { nodes: Array<{ target?: string }> }).nodes.map((n) => n.target);
  expect(targets).toEqual(['data-testid="cart-count"', undefined]);
});

test('coerceWithin parses a JSON-stringified node back into a node object', () => {
  const asString = JSON.stringify(sampleNode);
  expect(coerceWithin(asString)).toEqual(sampleNode);
});

test('coerceWithin passes selector strings and complete nodes through untouched', () => {
  expect(coerceWithin('main')).toBe('main');
  expect(coerceWithin(sampleNode)).toEqual(sampleNode);
  expect(coerceWithin(undefined)).toBeUndefined();
});

test('coerceWithin fails loud on JSON-looking garbage (never a silent empty read)', () => {
  expect(() => coerceWithin('{not json')).toThrow(AgentError);
  expect(() => coerceWithin('{"foo": 1}')).toThrow(AgentError);
});

test('schema accepts a fields-projected node as within (role + name is enough)', () => {
  const parsed = ObserveInputSchema.safeParse({
    kind: 'tree',
    within: { role: 'navigation', name: 'Main' },
  });
  expect(parsed.success).toBe(true);
});

test('a within node without bounds scopes by its selector — adapters scope by region only', async () => {
  const { adapter, rec } = fakeAdapter({ nodes: [sampleNode] });
  const projected = { role: 'navigation', name: 'Main' };
  expect(coerceWithin(projected)).toBe('role=navigation[name="Main" i]');
  expect(coerceWithin({ role: 'span', name: '0', testid: 'cart' })).toBe('data-testid="cart"');
  // …and the derived selector is what reaches the adapter.
  await runObserve(adapter, recorder(), { kind: 'tree', within: projected });
  expect(rec.readState?.within).toBe('role=navigation[name="Main" i]');
});

test('a within node with bounds but no enabled still scopes by its region', () => {
  const { bounds } = sampleNode;
  expect(coerceWithin({ role: 'button', name: 'Save', bounds })).toEqual({
    role: 'button',
    name: 'Save',
    bounds,
    enabled: true,
  });
});

test('a within node with neither bounds nor a name fails loud, never a whole-page read', () => {
  expect(() => coerceWithin({ role: 'generic', name: '  ' })).toThrow(AgentError);
  expect(() => coerceWithin(JSON.stringify({ role: 'generic', name: '' }))).toThrow(AgentError);
});

test('tree with a JSON-string within scopes the adapter read by the parsed node', async () => {
  const { adapter, rec } = fakeAdapter({ nodes: [sampleNode] });
  await runObserve(adapter, recorder(), { kind: 'tree', within: JSON.stringify(sampleNode) });
  expect(rec.readState?.within).toEqual(sampleNode);
});
