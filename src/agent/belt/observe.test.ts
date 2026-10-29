import { expect, test } from 'bun:test';
import type {
  Adapter,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  Query,
  SelectorDialect,
} from '../../adapters/contract.js';
import { AdapterError, AgentError } from '../../errors.js';
import type { Findings } from '../../findings/schema.js';
import { createSecretRedactor } from '../../redact.js';
import type { EvidenceRecorder } from './look.js';
import { coerceWithin, createObserveTool, ObserveInputSchema, runObserve } from './observe.js';
import { type FindingsWriter, runReport } from './report.js';
import { type ActTrail, createActTrail } from './trail.js';

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

/**
 * A fake {@link Adapter} that records the opts it receives and returns canned data.
 *
 * The dialect is DECLARED (`selectorDialect`) — the belt reads the declaration,
 * it never infers one. `withTabs` is a SEPARATE capability flag: a target may
 * list tabs and still speak the native dialect, which is exactly the case the
 * old `tabs`-based inference got wrong.
 */
function fakeAdapter(
  returns: FakeReturns,
  dialect: SelectorDialect = 'web',
  withTabs = false,
): { adapter: Adapter; rec: Recorder } {
  const rec: Recorder = { screenshots: 0 };
  const adapter: Adapter = {
    selectorDialect: dialect,
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
  if (withTabs)
    adapter.tabs = async () => [{ index: 0, url: 'http://x/', title: 'Home', active: true }];
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

test('console → returns entries + count, forwards filters (the cap is applied here)', async () => {
  const entry: ConsoleEntry = { level: 'error', text: 'boom', timestamp: 1 };
  const { adapter, rec } = fakeAdapter({ console: [entry] });
  const res = await runObserve(adapter, recorder(), {
    kind: 'console',
    filters: { level_eq: 'error' },
    limit: 10,
  });
  expect(res).toEqual({ kind: 'console', count: 1, entries: [entry] });
  // Read uncapped so the rows the cap drops can be counted and reported.
  expect(rec.console).toEqual({ filters: { level_eq: 'error' } });
});

/** `n` console rows, newest first — the shape of a chatty page's log buffer. */
const logRows = (n: number): ConsoleEntry[] =>
  Array.from({ length: n }, (_, i) => ({ level: 'error', text: `boom ${i}`, timestamp: i }));

test('console defaults to a bounded tail — chatty pages never flood context', async () => {
  const { adapter } = fakeAdapter({ console: logRows(60) });
  const res = await runObserve(adapter, recorder(), { kind: 'console' });
  if (res.kind !== 'console') throw new Error('expected console result');
  expect(res.count).toBe(50);
});

test('console says how many rows the limit cut off — never truncate silently', async () => {
  const { adapter } = fakeAdapter({ console: logRows(60) });
  const res = await runObserve(adapter, recorder(), { kind: 'console' });
  if (res.kind !== 'console') throw new Error('expected console result');
  // Without this, "50 errors" is what the blind driver reports — the truncated
  // picture, indistinguishable from a page that really had exactly 50.
  expect(res.truncated).toBe(10);
  expect(res.hint).toContain('limit');
});

test('an explicit console limit wins over the default', async () => {
  const { adapter } = fakeAdapter({ console: logRows(3) });
  const all = await runObserve(adapter, recorder(), { kind: 'console', limit: 200 });
  if (all.kind !== 'console') throw new Error('expected console result');
  expect(all.count).toBe(3);
  expect(all.truncated).toBeUndefined();

  const one = await runObserve(adapter, recorder(), { kind: 'console', limit: 1 });
  if (one.kind !== 'console') throw new Error('expected console result');
  expect(one.count).toBe(1);
  expect(one.truncated).toBe(2);
});

// --- network: the asset default + its own cap -------------------------------

/** A captured exchange; `ok` follows the status unless overridden. */
const net = (over: Partial<NetworkEntry>): NetworkEntry => ({
  method: 'GET',
  url: 'http://x/a',
  status: 200,
  ok: true,
  timestamp: 0,
  ...over,
});

/** One API call buried in `n` script loads — the shape of any dev-server page. */
const noisy = (scripts: number): NetworkEntry[] => [
  net({ url: 'http://x/api/todos', resourceType: 'fetch' }),
  ...Array.from({ length: scripts }, (_, i) =>
    net({ url: `http://x/src/c${i}.tsx`, resourceType: 'script' }),
  ),
];

test('network reads the adapter uncapped — the cap is applied after assets drop', async () => {
  // Capping in the adapter would spend the whole budget on scripts and leave the
  // one API call outside it: the exact failure this ordering exists to prevent.
  const { adapter, rec } = fakeAdapter({ network: noisy(60) });
  const res = await runObserve(adapter, recorder(), { kind: 'network' });
  expect(rec.network).toEqual({ filters: undefined });
  if (res.kind !== 'network') throw new Error('expected network result');
  expect(res.entries.map((e) => e.url)).toEqual(['http://x/api/todos']);
  expect(res.hidden).toBe(60);
  expect(res.hint).toContain('resource_in');
});

test('network keeps failed requests of any type — a 404 asset is still a bug', async () => {
  const { adapter } = fakeAdapter({
    network: [
      net({ url: 'http://x/logo.png', resourceType: 'image', status: 404, ok: false }),
      net({ url: 'http://x/app.css', resourceType: 'stylesheet' }),
    ],
  });
  const res = await runObserve(adapter, recorder(), { kind: 'network' });
  if (res.kind !== 'network') throw new Error('expected network result');
  expect(res.entries.map((e) => e.url)).toEqual(['http://x/logo.png']);
  expect(res.hidden).toBe(1);
});

test('an explicit resource_in disables the asset default', async () => {
  const { adapter } = fakeAdapter({ network: noisy(3) });
  const res = await runObserve(adapter, recorder(), {
    kind: 'network',
    filters: { resource_in: ['script'] },
  });
  if (res.kind !== 'network') throw new Error('expected network result');
  // The adapter's own filter is faked out here; what matters is that observe
  // added no second opinion — every row it was handed came back.
  expect(res.entries.length).toBe(4);
  expect(res.hidden).toBeUndefined();
});

test('an explicit network limit wins over the default — including 0', async () => {
  const { adapter } = fakeAdapter({ network: noisy(0) });
  const zero = await runObserve(adapter, recorder(), { kind: 'network', limit: 0 });
  if (zero.kind !== 'network') throw new Error('expected network result');
  expect(zero.count).toBe(0);
});

test('network says how many rows the limit cut off — a 120-failure flow is not "50 failures"', async () => {
  // 120 failing API calls: none are hidden (failures are always kept), so before
  // this the result was a bare `{count: 50}` — a blind driver reads that as "there
  // were 50 failures" and reports the truncated picture.
  const failures = Array.from({ length: 120 }, (_, i) =>
    net({ url: `http://x/api/${i}`, resourceType: 'fetch', status: 500, ok: false }),
  );
  const { adapter } = fakeAdapter({ network: failures });
  const res = await runObserve(adapter, recorder(), {
    kind: 'network',
    filters: { status_gte: 400 },
  });
  if (res.kind !== 'network') throw new Error('expected network result');
  expect(res.count).toBe(50);
  expect(res.hidden).toBeUndefined();
  expect(res.truncated).toBe(70);
  expect(res.hint).toContain('limit');
});

test('network reports the hidden assets AND the limit cut in one hint', async () => {
  const { adapter } = fakeAdapter({ network: noisy(30) });
  const res = await runObserve(adapter, recorder(), { kind: 'network', limit: 0 });
  if (res.kind !== 'network') throw new Error('expected network result');
  expect(res.hidden).toBe(30);
  expect(res.truncated).toBe(1);
  expect(res.hint).toContain('static asset');
  expect(res.hint).toContain('limit');
});

test('network reports no hidden count when nothing was held back', async () => {
  const { adapter } = fakeAdapter({ network: noisy(0) });
  const res = await runObserve(adapter, recorder(), { kind: 'network' });
  if (res.kind !== 'network') throw new Error('expected network result');
  expect(res.hidden).toBeUndefined();
  expect(res.hint).toBeUndefined();
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
  expect(coerceWithin(asString, 'web')).toEqual(sampleNode);
});

test('coerceWithin passes selector strings and complete nodes through untouched', () => {
  expect(coerceWithin('main', 'web')).toBe('main');
  expect(coerceWithin(sampleNode, 'web')).toEqual(sampleNode);
  expect(coerceWithin(undefined, 'web')).toBeUndefined();
});

test('coerceWithin fails loud on JSON-looking garbage (never a silent empty read)', () => {
  expect(() => coerceWithin('{not json', 'web')).toThrow(AgentError);
  expect(() => coerceWithin('{"foo": 1}', 'web')).toThrow(AgentError);
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
  expect(coerceWithin(projected, 'web')).toBe('role=navigation[name="Main" i]');
  expect(coerceWithin({ role: 'span', name: '0', testid: 'cart' }, 'web')).toBe(
    'data-testid="cart"',
  );
  // …and the derived selector is what reaches the adapter.
  await runObserve(adapter, recorder(), { kind: 'tree', within: projected });
  expect(rec.readState?.within).toBe('role=navigation[name="Main" i]');
});

test('a within node with bounds but no enabled still scopes by its region', () => {
  const { bounds } = sampleNode;
  expect(coerceWithin({ role: 'button', name: 'Save', bounds }, 'web')).toEqual({
    role: 'button',
    name: 'Save',
    bounds,
    enabled: true,
  });
});

test('a within node with neither bounds nor a name fails loud, never a whole-page read', () => {
  expect(() => coerceWithin({ role: 'generic', name: '  ' }, 'web')).toThrow(AgentError);
  expect(() => coerceWithin(JSON.stringify({ role: 'generic', name: '' }), 'web')).toThrow(
    AgentError,
  );
});

test('tree with a JSON-string within scopes the adapter read by the parsed node', async () => {
  const { adapter, rec } = fakeAdapter({ nodes: [sampleNode] });
  await runObserve(adapter, recorder(), { kind: 'tree', within: JSON.stringify(sampleNode) });
  expect(rec.readState?.within).toEqual(sampleNode);
});

// --- selector dialect: desktop/android take no Playwright syntax -------------

/** The `target`s a tree read attaches, in document order. */
async function targetsOf(adapter: Adapter, input: Parameters<typeof runObserve>[2]) {
  const res = await runObserve(adapter, recorder(), input);
  if (res.kind !== 'tree') throw new Error('expected tree result');
  return res.nodes.map((node) => node.target);
}

test('the dialect is DECLARED — a native target that also has tabs stays native', async () => {
  // The dialect used to be INFERRED from the optional `tabs` capability, so a
  // native target that grew a tab listing silently flipped to the web dialect
  // and got `role=button[name="Save" i]` — a selector its own parser cannot
  // resolve, so every click and type on it died. The declaration wins; `tabs`
  // says nothing about the grammar a target parses.
  const { adapter } = fakeAdapter({ nodes: [sampleNode] }, 'native', true);
  expect(await targetsOf(adapter, { kind: 'tree' })).toEqual(['button "Save"']);
});

test('a web target still emits the Playwright form, tabs or not', async () => {
  const { adapter } = fakeAdapter({ nodes: [sampleNode] }, 'web', true);
  expect(await targetsOf(adapter, { kind: 'tree' })).toEqual(['role=button[name="Save" i]']);
});

test('an adapter with no usable declared dialect fails loud, never a silent web fallback', async () => {
  // A missing or misspelled declaration is a broken adapter, not a web target:
  // falling back to `web` would hand the driver selectors nothing can resolve.
  const { adapter } = fakeAdapter({ nodes: [sampleNode] });
  const missing = { ...adapter, selectorDialect: undefined } as unknown as Adapter;
  await expect(runObserve(missing, recorder(), { kind: 'tree' })).rejects.toThrow(AgentError);
  const unknown = { ...adapter, selectorDialect: 'klingon' } as unknown as Adapter;
  await expect(runObserve(unknown, recorder(), { kind: 'tree' })).rejects.toThrow(AgentError);
});

test('native tree → role "name", the only structured form desktop/android parse', async () => {
  // `role=button[name="Save" i]` fails their `^([a-zA-Z][\w-]*)\s+["'](.+)["']$`
  // parser, degrades to a literal name substring, matches nothing — and every
  // click and type on the target fails with `act: no element matched`.
  const { adapter } = fakeAdapter({ nodes: [sampleNode] }, 'native');
  expect(await targetsOf(adapter, { kind: 'tree' })).toEqual(['button "Save"']);
});

test('native tree → an android resource-id target is the bare id, not data-testid=', async () => {
  const node: Node = { ...sampleNode, testid: 'com.example.app:id/submit' };
  const { adapter } = fakeAdapter({ nodes: [node] }, 'native');
  expect(await targetsOf(adapter, { kind: 'tree' })).toEqual(['com.example.app:id/submit']);
  // …and a scoped read keeps it, exactly as web keeps its data-testid.
  const { adapter: scoped } = fakeAdapter({ nodes: [node] }, 'native');
  expect(await targetsOf(scoped, { kind: 'tree', query: 'Submit' })).toEqual([
    'com.example.app:id/submit',
  ]);
});

test('native tree → no `>> nth=` (Playwright chaining): repeats past the first get no target', async () => {
  const dup: Node = { ...sampleNode, name: 'Add' };
  const { adapter } = fakeAdapter({ nodes: [dup, dup] }, 'native');
  expect(await targetsOf(adapter, { kind: 'tree' })).toEqual(['button "Add"', undefined]);
});

test('native tree → an unquotable name falls back to the bare name substring', async () => {
  const odd: Node = { ...sampleNode, role: 'push button', name: 'Say "hi"' };
  const { adapter } = fakeAdapter({ nodes: [odd] }, 'native');
  expect(await targetsOf(adapter, { kind: 'tree' })).toEqual(['Say "hi"']);
});

test('native within → scopes by role "name" too, never a web engine selector', async () => {
  const { adapter, rec } = fakeAdapter({ nodes: [sampleNode] }, 'native');
  await runObserve(adapter, recorder(), {
    kind: 'tree',
    within: { role: 'navigation', name: 'Main' },
  });
  expect(rec.readState?.within).toBe('navigation "Main"');
  expect(coerceWithin({ role: 'navigation', name: 'Main' }, 'native')).toBe('navigation "Main"');
});

// --- tabs channel -----------------------------------------------------------

test('observe kind:"tabs" lists the target’s tabs', async () => {
  const { adapter } = fakeAdapter({});
  const withTabs: Adapter = {
    ...adapter,
    tabs: async () => [
      { index: 0, url: 'http://x/', title: 'Home', active: true },
      { index: 1, url: 'http://x/popup', title: 'Popup', active: false },
    ],
  };
  const res = await runObserve(withTabs, recorder(), { kind: 'tabs' });
  if (res.kind !== 'tabs') throw new Error('expected tabs result');
  expect(res.count).toBe(2);
  expect(res.tabs[1]?.url).toBe('http://x/popup');
});

test('observe kind:"tabs" fails loud on a target with no tab concept', async () => {
  const { adapter } = fakeAdapter({}, 'native');
  // Desktop/android expose no `tabs` — say so rather than inventing one.
  await expect(runObserve(adapter, recorder(), { kind: 'tabs' })).rejects.toThrow(AgentError);
});

// --- the evidence trail: createObserveTool records error-level console rows ---

/** The wired observe tool over a fake adapter returning `console` rows. */
function wiredObserve(console: ConsoleEntry[], trail = createActTrail()) {
  const { adapter } = fakeAdapter({ console });
  const observe = createObserveTool(adapter, recorder(), trail);
  return {
    trail,
    read: (input: Parameters<typeof runObserve>[2]) =>
      observe.execute?.(input, { toolCallId: 't1', messages: [] }),
  };
}

const ERROR_ROWS: ConsoleEntry[] = [
  { level: 'error', text: 'TypeError: cart is undefined', location: 'app.js:12:3', timestamp: 1 },
  { level: 'warn', text: 'deprecated api', timestamp: 2 },
  { level: 'error', text: 'failed to fetch', timestamp: 3 },
  { level: 'log', text: 'checkout mounted', timestamp: 4 },
  { level: 'info', text: 'hydration done', timestamp: 5 },
];

test('a console read records error-level rows as bugs, keeping the location as evidence', async () => {
  const { trail, read } = wiredObserve(ERROR_ROWS);
  await read({ kind: 'console' });
  expect(trail.bugs).toEqual([
    { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
    { kind: 'console', detail: 'failed to fetch' },
  ]);
});

test('warn/log/info rows record nothing — working noise is not a finding', async () => {
  const { trail, read } = wiredObserve([
    { level: 'warn', text: 'deprecated api', timestamp: 1 },
    { level: 'log', text: 'checkout mounted', timestamp: 2 },
    { level: 'info', text: 'hydration done', timestamp: 3 },
  ]);
  await read({ kind: 'console' });
  expect(trail.bugs).toEqual([]);
});

test('a re-read of the same rows adds nothing — the trail dedupes', async () => {
  // The console channel is a non-destructive ring buffer: every later read
  // returns rows already recorded.
  const { trail, read } = wiredObserve(ERROR_ROWS);
  await read({ kind: 'console' });
  await read({ kind: 'console' });
  await read({ kind: 'console', limit: 50 });
  expect(trail.bugs).toHaveLength(2);
});

test('tree/screenshot/network/tabs kinds record nothing', async () => {
  const png = new Uint8Array([1, 2, 3, 4]);
  const trail = createActTrail();
  const { adapter } = fakeAdapter({ screenshot: png });
  const withTabs: Adapter = {
    ...adapter,
    network: async () => [
      { method: 'GET', url: 'http://x/api', status: 500, ok: false, timestamp: 1 },
    ],
    tabs: async () => [{ index: 0, url: 'http://x/', title: 'Home', active: true }],
  };
  const observe = createObserveTool(withTabs, recorder(), trail);
  const call = (input: Parameters<typeof runObserve>[2]) =>
    observe.execute?.(input, { toolCallId: 't1', messages: [] });
  await call({ kind: 'tree' });
  await call({ kind: 'screenshot' });
  await call({ kind: 'network' });
  await call({ kind: 'tabs' });
  expect(trail.bugs).toEqual([]);
  expect(trail.visual).toEqual([]);
  expect(trail.steps).toEqual([]);
});

test('a throwing read records nothing and releases the gate', async () => {
  const trail = createActTrail();
  const { adapter } = fakeAdapter({});
  adapter.console = async () => {
    throw new AdapterError('console gone');
  };
  const observe = createObserveTool(adapter, recorder(), trail);
  await expect(
    observe.execute?.({ kind: 'console' }, { toolCallId: 't1', messages: [] }),
  ).rejects.toThrow(AdapterError);
  const evidence = await trail.settled();
  expect(evidence.bugs).toEqual([]);
});

// --- redaction: a persona value echoed back in console rows never survives -----

/**
 * `hunter2` is a SYNTHETIC persona value (7 chars → `<redacted, 7 chars>`),
 * never a real credential — the same shape `createSecretRedactor` is bound to
 * per run in `session-builder.ts`.
 */
const REDACT = createSecretRedactor(['hunter2']);

test('a redacted console read scrubs persona values from text AND location', async () => {
  const leaked: ConsoleEntry = {
    level: 'error',
    text: 'login failed for hunter2',
    location: 'http://x/app.js?token=hunter2',
    timestamp: 1,
  };
  const { adapter } = fakeAdapter({ console: [leaked] });
  const res = await runObserve(adapter, recorder(), { kind: 'console' }, REDACT);
  if (res.kind !== 'console') throw new Error('expected console result');
  expect(res.entries[0]?.text).toBe('login failed for <redacted, 7 chars>');
  expect(res.entries[0]?.location).toBe('http://x/app.js?token=<redacted, 7 chars>');
  // The driver reads these entries — no raw persona value may ride along.
  expect(JSON.stringify(res)).not.toContain('hunter2');
});

test('a wired redactor keeps persona values out of the trail: bug detail AND evidence location', async () => {
  const leaked: ConsoleEntry[] = [
    {
      level: 'error',
      text: 'auth failed for hunter2',
      location: 'http://x/login.js?token=hunter2',
      timestamp: 1,
    },
    { level: 'error', text: 'failed to fetch', timestamp: 2 },
  ];
  const { adapter } = fakeAdapter({ console: leaked });
  const trail = createActTrail();
  const observe = createObserveTool(adapter, recorder(), trail, REDACT);
  await observe.execute?.({ kind: 'console' }, { toolCallId: 't1', messages: [] });
  expect(trail.bugs).toEqual([
    {
      kind: 'console',
      detail: 'auth failed for <redacted, 7 chars>',
      evidence: 'http://x/login.js?token=<redacted, 7 chars>',
    },
    { kind: 'console', detail: 'failed to fetch' },
  ]);
});

test('the persisted findings carry no raw persona value: runReport over the settled trail', async () => {
  const leaked: ConsoleEntry[] = [
    {
      level: 'error',
      text: 'TypeError: cannot read password hunter2',
      location: 'http://x/auth.js:9:1',
      timestamp: 1,
    },
  ];
  const { adapter } = fakeAdapter({ console: leaked });
  const trail = createActTrail();
  const observe = createObserveTool(adapter, recorder(), trail, REDACT);
  await observe.execute?.({ kind: 'console' }, { toolCallId: 't1', messages: [] });
  const written: Findings[] = [];
  const writer: FindingsWriter = {
    writeFindings: async (findings) => {
      written.push(findings);
      return 'findings.json';
    },
  };
  // The same-step report path: report merges trail.settled() into the verdict
  // and persists it — so the recorded (redacted) bugs are what reaches disk.
  const result = await runReport(
    writer,
    { status: 'failed', steps: [], bugs: [], visual: [], dismissStreamed: false },
    await trail.settled(),
  );
  expect(result.carried.bugs).toBe(1);
  expect(written).toHaveLength(1);
  expect(written[0]?.bugs).toEqual([
    {
      kind: 'console',
      detail: 'TypeError: cannot read password <redacted, 7 chars>',
      evidence: 'http://x/auth.js:9:1',
    },
  ]);
  expect(JSON.stringify(written)).not.toContain('hunter2');
});

// --- gate discipline: a same-step terminal read must wait out an in-flight read --

/**
 * A one-shot latch: the fake adapter's console read stays in flight until
 * `open()` — the shape of a real read racing the terminal one, with no
 * wall-clock timing.
 */
function latch(): { wait: Promise<void>; open: () => void } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * The evidence arrays as they stood the moment `settled()` resolved — what a
 * same-step `report` merges. The trail hands back live arrays, so only a copy
 * taken at resolve time can tell a settled() that waited out the gate from one
 * that resolved early over an in-flight read.
 */
function snapshotAtDrain(settling: ReturnType<ActTrail['settled']>) {
  return settling.then((evidence) => ({
    steps: [...evidence.steps],
    bugs: [...evidence.bugs],
    visual: [...evidence.visual],
  }));
}

/** A held-open console read: `open()` releases it, ERROR_ROWS come back. */
function heldObserve(trail: ActTrail) {
  const { wait, open } = latch();
  const { adapter } = fakeAdapter({});
  adapter.console = async () => {
    await wait;
    return ERROR_ROWS;
  };
  return { open, observe: createObserveTool(adapter, recorder(), trail) };
}

test('a trail.settled() opened while the console read is in flight waits out the gate', async () => {
  // The same-step observe → report race: the terminal read starts while the
  // console read is still running and must not resolve until the gate releases —
  // which is only after the read has recorded its error rows.
  const trail = createActTrail();
  const { open, observe } = heldObserve(trail);
  const executing = observe.execute?.({ kind: 'console' }, { toolCallId: 't1', messages: [] });
  const drained = snapshotAtDrain(trail.settled());
  // Give settled() the one turn its own yield takes — every chance a missing
  // gate would need to resolve it early, while the read is provably in flight.
  await new Promise((resolve) => setTimeout(resolve, 0));
  open();
  await executing;
  expect(await drained).toEqual({
    steps: [],
    bugs: [
      { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
      { kind: 'console', detail: 'failed to fetch' },
    ],
    visual: [],
  });
});

test('a concurrent trail.settled() started BEFORE the read finishes still sees the rows', async () => {
  // Mirror of the look race (look.test.ts 'a concurrent trail.settled() started
  // BEFORE the look finishes still sees the issues'): the terminal read is
  // created first. While it yields its turn, the observe enters the gate —
  // before its first await — and reads, so the settled read finds the gate
  // held, waits it out, and carries the rows. Without the gate it resolves over
  // the in-flight read and the snapshot below comes up empty.
  const trail = createActTrail();
  const { open, observe } = heldObserve(trail);
  const drained = snapshotAtDrain(trail.settled());
  const executing = observe.execute?.({ kind: 'console' }, { toolCallId: 't1', messages: [] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  open();
  await executing;
  expect((await drained).bugs).toEqual([
    { kind: 'console', detail: 'TypeError: cart is undefined', evidence: 'app.js:12:3' },
    { kind: 'console', detail: 'failed to fetch' },
  ]);
});

test('no trail wired — observe behaves exactly as before', async () => {
  const { adapter } = fakeAdapter({ console: ERROR_ROWS });
  const observe = createObserveTool(adapter, recorder());
  const res = (await observe.execute?.(
    { kind: 'console' },
    { toolCallId: 't1', messages: [] },
  )) as { kind: string; count: number };
  expect(res.kind).toBe('console');
  expect(res.count).toBe(5);
});
