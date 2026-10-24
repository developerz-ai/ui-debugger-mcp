import { expect, test } from 'bun:test';
import { AdapterError, ExecTimeoutError } from '../../errors.js';
import type { Node } from '../contract.js';
import {
  type AtspiNode,
  applyDesktopFilters,
  BusctlAtspi,
  busctlData,
  centerWithin,
  hasState,
  mapRole,
  matchesQuery,
  matchesScope,
  parseChildren,
  parseExtents,
  parseRoleNameQuery,
  parseStateWords,
  shapeNodes,
  stateFlags,
  toNode,
} from './atspi.js';
import type { ExecOptions } from './proc.js';

// --- mapRole ----------------------------------------------------------------

test('mapRole normalizes AT-SPI role names to contract roles', () => {
  expect(mapRole('push button')).toBe('button');
  expect(mapRole('entry')).toBe('textbox');
  expect(mapRole('page tab')).toBe('tab');
  expect(mapRole('frame')).toBe('window');
  expect(mapRole('Check Box')).toBe('checkbox');
});

test('mapRole passes unknown roles through cleaned', () => {
  expect(mapRole('  custom  widget ')).toBe('custom widget');
});

// --- busctlData -------------------------------------------------------------

test('busctlData returns the data field', () => {
  expect(busctlData('{"type":"s","data":["hi"]}')).toEqual(['hi']);
});

test('busctlData throws on non-JSON or a missing data field', () => {
  expect(() => busctlData('not json')).toThrow(AdapterError);
  expect(() => busctlData('{"type":"s"}')).toThrow(AdapterError);
});

// --- parseExtents -----------------------------------------------------------

test('parseExtents decodes (iiii) into Bounds', () => {
  expect(parseExtents([10, 20, 100, 40])).toEqual({ x: 10, y: 20, width: 100, height: 40 });
});

test('parseExtents throws on a bad shape', () => {
  expect(() => parseExtents([1, 2, 3])).toThrow(AdapterError);
  expect(() => parseExtents('nope')).toThrow(AdapterError);
  expect(() => parseExtents([1, 2, 3, 'x'])).toThrow(AdapterError);
});

// --- state bitfield ---------------------------------------------------------

const STATE_ENABLED_VISIBLE = (1 << 8) | (1 << 24) | (1 << 25) | (1 << 30);

test('hasState reads a bit from the split 64-bit field', () => {
  expect(hasState([1 << 8, 0], 8)).toBe(true);
  expect(hasState([1 << 8, 0], 9)).toBe(false);
  expect(hasState([0, 1 << 1], 33)).toBe(true); // bit 33 → high word, bit 1
});

test('parseStateWords decodes au into a word pair', () => {
  expect(parseStateWords([256, 0])).toEqual([256, 0]);
  expect(() => parseStateWords([256])).toThrow(AdapterError);
});

test('stateFlags requires ENABLED+SENSITIVE and SHOWING+VISIBLE', () => {
  expect(stateFlags([STATE_ENABLED_VISIBLE, 0])).toEqual({ enabled: true, visible: true });
  expect(stateFlags([1 << 8, 0])).toEqual({ enabled: false, visible: false }); // enabled w/o sensitive
  expect(stateFlags([(1 << 8) | (1 << 24), 0])).toEqual({ enabled: true, visible: false });
});

// --- parseChildren ----------------------------------------------------------

test('parseChildren decodes a(so) into refs', () => {
  expect(
    parseChildren([
      [':1.5', '/a'],
      [':1.6', '/b'],
    ]),
  ).toEqual([
    { dest: ':1.5', path: '/a' },
    { dest: ':1.6', path: '/b' },
  ]);
});

test('parseChildren throws on a malformed ref', () => {
  expect(() => parseChildren([[':1.5']])).toThrow(AdapterError);
  expect(() => parseChildren('nope')).toThrow(AdapterError);
});

// --- query parsing + matching -----------------------------------------------

test('parseRoleNameQuery splits role "name" from plain text', () => {
  expect(parseRoleNameQuery('button "Save"')).toEqual({ role: 'button', name: 'Save' });
  expect(parseRoleNameQuery("link 'Home'")).toEqual({ role: 'link', name: 'Home' });
  expect(parseRoleNameQuery('Save changes')).toEqual({ name: 'Save changes' });
});

test('matchesQuery matches role exactly and name as a case-insensitive substring', () => {
  const node: Node = {
    role: 'button',
    name: 'Save changes',
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    enabled: true,
  };
  expect(matchesQuery(node, { role: 'button', name: 'save' })).toBe(true);
  expect(matchesQuery(node, { role: 'link' })).toBe(false);
  expect(matchesQuery(node, { name: 'cancel' })).toBe(false);
});

// --- applyDesktopFilters ----------------------------------------------------

const node = (over: Partial<AtspiNode>): AtspiNode => ({
  role: 'button',
  name: 'Submit',
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  enabled: true,
  visible: true,
  measured: true,
  ...over,
});

test('applyDesktopFilters narrows by the whitelisted keys', () => {
  const nodes = [node({ name: 'a', visible: false }), node({ name: 'b', role: 'link' })];
  expect(applyDesktopFilters(nodes, { visible_eq: true }).map((n) => n.name)).toEqual(['b']);
  expect(applyDesktopFilters(nodes, { role_in: ['link'] }).map((n) => n.name)).toEqual(['b']);
  expect(applyDesktopFilters(nodes, { name_contains: 'A' }).map((n) => n.name)).toEqual(['a']);
});

test('applyDesktopFilters throws on an unknown key or wrong type', () => {
  expect(() => applyDesktopFilters([node({})], { bogus_eq: true })).toThrow(AdapterError);
  expect(() => applyDesktopFilters([node({})], { visible_eq: 'yes' })).toThrow(AdapterError);
});

// --- shapeNodes / toNode / centerWithin -------------------------------------

test('toNode drops the internal visible flag', () => {
  expect(toNode(node({ visible: false }))).toEqual({
    role: 'button',
    name: 'Submit',
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    enabled: true,
  });
});

test('centerWithin tests a node center against a region', () => {
  const n = node({ bounds: { x: 10, y: 10, width: 20, height: 20 } }); // center (20,20)
  expect(centerWithin(n, { x: 0, y: 0, width: 50, height: 50 })).toBe(true);
  expect(centerWithin(n, { x: 100, y: 100, width: 10, height: 10 })).toBe(false);
});

test('shapeNodes applies query, filters, region, limit and returns plain Nodes', () => {
  const nodes = [
    node({ name: 'Save', bounds: { x: 0, y: 0, width: 10, height: 10 } }),
    node({ name: 'Save copy', bounds: { x: 500, y: 500, width: 10, height: 10 } }),
    node({ name: 'Cancel', bounds: { x: 0, y: 0, width: 10, height: 10 } }),
  ];
  const out = shapeNodes(nodes, { query: 'Save' }, 200, { x: 0, y: 0, width: 100, height: 100 });
  expect(out.map((n) => n.name)).toEqual(['Save']); // 'Save copy' excluded by region
  expect(out[0]).not.toHaveProperty('visible');
});

test('shapeNodes excludes unmeasured nodes from a region scope', () => {
  // A Component-less node's bounds are a placeholder, not a rect at (0,0) — scoping
  // by `within` must not report it as sitting in a region that covers the origin.
  const nodes = [
    node({ name: 'App root', measured: false, bounds: { x: 0, y: 0, width: 0, height: 0 } }),
    node({ name: 'Save', bounds: { x: 10, y: 10, width: 10, height: 10 } }),
  ];
  const out = shapeNodes(nodes, {}, 200, { x: 0, y: 0, width: 100, height: 100 });
  expect(out.map((n) => n.name)).toEqual(['Save']);
});

test('shapeNodes caps by limit', () => {
  const nodes = [node({ name: 'a' }), node({ name: 'b' }), node({ name: 'c' })];
  expect(shapeNodes(nodes, {}, 2).map((n) => n.name)).toEqual(['a', 'b']);
});

test('shapeNodes rejects a bad limit instead of silently truncating', () => {
  // `slice(0, -1)` would quietly drop the last node; NaN would return nothing.
  const nodes = [node({ name: 'a' }), node({ name: 'b' })];
  expect(() => shapeNodes(nodes, { limit: -1 }, 200)).toThrow(AdapterError);
  expect(() => shapeNodes(nodes, { limit: Number.NaN }, 200)).toThrow(AdapterError);
});

// --- scope matching ---------------------------------------------------------

test('matchesScope matches a window by its title', () => {
  expect(matchesScope({ role: 'window', name: 'My App — Untitled' }, { title: 'My App' })).toBe(
    true,
  );
});

test('matchesScope matches an application by its title OR its class', () => {
  // The class is the application's own identity (WM_CLASS); the title is the
  // window's, so an application matches either.
  expect(matchesScope({ role: 'application', name: 'myapp' }, { class: 'myapp' })).toBe(true);
  expect(matchesScope({ role: 'application', name: 'My App' }, { title: 'My App' })).toBe(true);
  expect(matchesScope({ role: 'application', name: 'My App' }, { title: 'Other' })).toBe(false);
});

test('matchesScope matches case-insensitively and on a literal substring', () => {
  expect(matchesScope({ role: 'window', name: 'My App' }, { title: 'my app' })).toBe(true);
  expect(matchesScope({ role: 'window', name: 'My App' }, { title: 'App' })).toBe(true);
  // Literal, not a regex: the parens are characters, not a group.
  expect(matchesScope({ role: 'window', name: 'My App (dev)' }, { title: 'App (dev)' })).toBe(true);
  expect(matchesScope({ role: 'window', name: 'My App (dev)' }, { title: '^My' })).toBe(false);
});

test('matchesScope rejects a node that is neither the window nor its application', () => {
  expect(matchesScope({ role: 'button', name: 'Save' }, { title: 'Save' })).toBe(false);
  expect(matchesScope({ role: 'window', name: 'Other App' }, { title: 'My App' })).toBe(false);
});

// --- BusctlAtspi.readTree (injected fake bus) -------------------------------

/** A canned a11y bus: root → app(frame) → button(push button), leaf has no children. */
function fakeBus(): { exec: (args: string[]) => Promise<string>; addressCalls: () => number } {
  let addressCalls = 0;
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) {
      addressCalls += 1;
      return call(['unix:path=/tmp/at-spi/bus']);
    }
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) {
      if (path === '/org/a11y/atspi/accessible/root') return call([[[':1.5', '/app']]]);
      if (path === '/app') return call([[[':1.5', '/btn']]]);
      return call([[]]);
    }
    if (args.includes('GetRoleName')) return call([path === '/app' ? 'frame' : 'push button']);
    if (args.includes('get-property')) return call(path === '/app' ? 'My App' : 'OK');
    if (args.includes('GetState')) return call([[STATE_ENABLED_VISIBLE, 0]]);
    if (args.includes('GetExtents')) {
      return call([path === '/app' ? [0, 0, 800, 600] : [10, 20, 100, 40]]);
    }
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec, addressCalls: () => addressCalls };
}

test('BusctlAtspi.readTree walks + normalizes the a11y tree', async () => {
  const bus = fakeBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree();
  expect(nodes.map((n) => n.role)).toEqual(['window', 'button']);
  expect(nodes.map((n) => n.name)).toEqual(['My App', 'OK']);
  const button = nodes[1];
  expect(button?.bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  expect(button?.enabled).toBe(true);
  expect(button?.visible).toBe(true);
  expect(bus.addressCalls()).toBe(1); // a11y bus address resolved once and cached
});

test('BusctlAtspi.readTree respects maxNodes', async () => {
  const bus = fakeBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({ maxNodes: 1 });
  expect(nodes).toHaveLength(1);
  expect(nodes[0]?.name).toBe('My App');
});

test('BusctlAtspi.readTree fails loud on a malformed reply', async () => {
  const exec = async (): Promise<string> => 'garbage';
  await expect(new BusctlAtspi({ exec }).readTree()).rejects.toThrow(AdapterError);
});

test('BusctlAtspi.readTree marks a node without Component unmeasured', async () => {
  // Application roots / toolkit fillers don't implement Component — busctl exits
  // non-zero on GetExtents. The walk keeps every node, but a bounds-less one is
  // flagged `measured: false`: its zeros are a placeholder, not a rect at the origin
  // (clicking it must fail loud, not land on the top-left of the desktop).
  const bus = fakeBus();
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetExtents') && args[4] === '/app') {
      throw Object.assign(new Error('busctl exited 1'), {
        stderr: 'Unknown interface org.a11y.atspi.Component',
      });
    }
    return bus.exec(args);
  };
  const nodes = await new BusctlAtspi({ exec }).readTree();
  expect(nodes.map((n) => n.name)).toEqual(['My App', 'OK']);
  expect(nodes[0]?.measured).toBe(false);
  expect(nodes[1]?.measured).toBe(true);
  expect(nodes[1]?.bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
});

test('BusctlAtspi.readTree with a query skips State/Extents for non-matching nodes', async () => {
  // The app frame doesn't match `button "OK"`, so its GetState/GetExtents calls
  // should never happen — only the matching button gets fully described.
  const bus = fakeBus();
  const stateOrExtentsCalls: string[] = [];
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetState') || args.includes('GetExtents')) {
      stateOrExtentsCalls.push(args[4] ?? '');
    }
    return bus.exec(args);
  };
  const nodes = await new BusctlAtspi({ exec }).readTree({ query: { role: 'button' } });
  expect(nodes.map((n) => n.name)).toEqual(['OK']);
  expect(stateOrExtentsCalls).toEqual(['/btn', '/btn']); // never called for '/app'
});

test('BusctlAtspi.readTree stops early once maxNodes matches are found', async () => {
  // Two buttons under the app; maxNodes: 1 with a query should return only the
  // first match instead of walking (and fully describing) the whole tree.
  let describedButtons = 0;
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) return call(['unix:path=/tmp/at-spi/bus']);
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) {
      if (path === '/org/a11y/atspi/accessible/root') return call([[[':1.5', '/app']]]);
      if (path === '/app')
        return call([
          [
            [':1.5', '/btn1'],
            [':1.6', '/btn2'],
          ],
        ]);
      return call([[]]);
    }
    if (args.includes('GetRoleName')) return call([path === '/app' ? 'frame' : 'push button']);
    if (args.includes('get-property')) return call(path === '/app' ? 'My App' : 'OK');
    if (args.includes('GetState')) {
      if (path.startsWith('/btn')) describedButtons += 1;
      return call([[STATE_ENABLED_VISIBLE, 0]]);
    }
    if (args.includes('GetExtents')) return call([[0, 0, 100, 40]]);
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  const nodes = await new BusctlAtspi({ exec }).readTree({
    query: { role: 'button' },
    maxNodes: 1,
  });
  expect(nodes).toHaveLength(1);
  expect(describedButtons).toBe(1); // btn2 never fully described once btn1 matched
});

test('BusctlAtspi.readTree abandons the walk once the deadline has passed', async () => {
  // Every visited node costs ~2 busctl spawns and `maxNodes` only bounds *matches*, so a
  // fruitless walk must be able to give up on the clock — `waitFor` passes its deadline.
  const bus = fakeBus();
  const visited: string[] = [];
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetRoleName')) visited.push(args[4] ?? '');
    return bus.exec(args);
  };
  const nodes = await new BusctlAtspi({ exec }).readTree({ deadline: Date.now() - 1 });
  expect(nodes).toEqual([]);
  expect(visited).toEqual([]); // stopped before spending a single describe call
});

test('BusctlAtspi.readTree walks normally while the deadline is in the future', async () => {
  const bus = fakeBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    deadline: Date.now() + 60_000,
  });
  expect(nodes.map((n) => n.name)).toEqual(['My App', 'OK']);
});

test('BusctlAtspi.readTree rejects when a busctl call lands after the deadline', async () => {
  // A wedged bus must not hold the walk (and the `waitFor` behind it) past its
  // deadline: the spawn is capped by the time left until then, and a reply that
  // arrives after it is a failure — not a partial tree to read as the answer.
  const bus = fakeBus();
  const exec = async (args: string[]): Promise<string> => {
    // The first spawn (GetAddress) answers only after the deadline has passed.
    await new Promise((resolve) => setTimeout(resolve, 60));
    return bus.exec(args);
  };
  await expect(new BusctlAtspi({ exec }).readTree({ deadline: Date.now() + 20 })).rejects.toThrow(
    ExecTimeoutError,
  );
});

test('BusctlAtspi.readTree passes the walk deadline down to every busctl spawn', async () => {
  // The per-call cap must be the time left until the deadline, not the fixed 10s
  // default — otherwise one wedged spawn outlives the enclosing budget.
  const bus = fakeBus();
  const deadlines: (number | undefined)[] = [];
  const exec = async (args: string[], opts?: ExecOptions): Promise<string> => {
    deadlines.push(opts?.deadline);
    return bus.exec(args);
  };
  const deadline = Date.now() + 60_000;
  await new BusctlAtspi({ exec }).readTree({ deadline });
  expect(deadlines.length).toBeGreaterThan(0);
  for (const seen of deadlines) expect(seen).toBe(deadline);
});

test('BusctlAtspi.readTree does not report a reply that arrived after expiry as a read', async () => {
  // The reply lands after the deadline: the walk must reject rather than hand back
  // a tree the caller would take as the answer.
  const bus = fakeBus();
  const exec = async (args: string[]): Promise<string> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return bus.exec(args);
  };
  const promise = new BusctlAtspi({ exec }).readTree({ deadline: Date.now() + 10 });
  await expect(promise).rejects.toThrow(ExecTimeoutError);
});

test('BusctlAtspi.readTree fails loud when GetExtents blows its per-call cap', async () => {
  // A wedged bus is NOT "this node has no Component": swallowing the timeout would
  // spend the whole cap again on every remaining node of the walk.
  const bus = fakeBus();
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetExtents')) {
      throw new ExecTimeoutError('desktop: `busctl` timed out after 10000ms (SIGKILLed)');
    }
    return bus.exec(args);
  };
  await expect(new BusctlAtspi({ exec }).readTree()).rejects.toThrow(ExecTimeoutError);
});

// --- scoped walks -----------------------------------------------------------

/**
 * A canned a11y bus holding TWO applications whose buttons share the label
 * "Save" — the shape that made the unscoped walk click the wrong app.
 *
 * The tree is registry root → application → frame → button, mirroring a real
 * AT-SPI tree (the root's children are the applications; their frames are the
 * windows). The FOREIGN application is listed FIRST, so an unscoped walk finds
 * its button first.
 */
function twoAppBus(): { exec: (args: string[]) => Promise<string> } {
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const nodes: Record<string, { role: string; name: string; bounds: number[] }> = {
    '/app1': { role: 'application', name: 'Foreign App', bounds: [0, 0, 800, 600] },
    '/app1/frame': { role: 'frame', name: 'Foreign App — Doc', bounds: [0, 0, 800, 600] },
    '/app1/btn': { role: 'push button', name: 'Save', bounds: [10, 20, 100, 40] },
    '/app2': { role: 'application', name: 'Managed App', bounds: [0, 0, 800, 600] },
    '/app2/frame': { role: 'frame', name: 'Managed App — Doc', bounds: [0, 0, 800, 600] },
    '/app2/btn': { role: 'push button', name: 'Save', bounds: [400, 500, 100, 40] },
  };
  const children: Record<string, [string, string][]> = {
    '/org/a11y/atspi/accessible/root': [
      [':1.5', '/app1'],
      [':1.6', '/app2'],
    ],
    '/app1': [[':1.5', '/app1/frame']],
    '/app1/frame': [[':1.5', '/app1/btn']],
    '/app2': [[':1.6', '/app2/frame']],
    '/app2/frame': [[':1.6', '/app2/btn']],
  };
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) return call(['unix:path=/tmp/at-spi/bus']);
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) return call([children[path] ?? []]);
    const node = nodes[path];
    if (!node) throw new Error(`unexpected busctl call: ${args.join(' ')}`);
    if (args.includes('GetRoleName')) return call([node.role]);
    if (args.includes('get-property')) return call(node.name);
    if (args.includes('GetState')) return call([[STATE_ENABLED_VISIBLE, 0]]);
    if (args.includes('GetExtents')) return call([node.bounds]);
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec };
}

test('BusctlAtspi.readTree without a scope sees every application on the desktop', async () => {
  // The bug this scope fixes: the registry root's children are EVERY app, so an
  // unscoped walk reaches the foreign app's "Save" before the managed one's.
  const bus = twoAppBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree();
  expect(nodes.filter((n) => n.name === 'Save')).toHaveLength(2);
});

test('BusctlAtspi.readTree with a scope returns only the subtree the scope names', async () => {
  const bus = twoAppBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    scope: { title: 'Managed App' },
  });
  // The title matches the WINDOW 'Managed App — Doc' as well as the application
  // 'Managed App'. Matching windows come first, so the walk is rooted at the
  // window; the foreign app's identically-labelled button is NOT in the result.
  expect(nodes.map((n) => n.name)).toEqual(['Managed App — Doc', 'Save']);
  expect(nodes.some((n) => n.name === 'Foreign App')).toBe(false);
});

test('BusctlAtspi.readTree scopes by the application class', async () => {
  const bus = twoAppBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    scope: { class: 'Foreign App' },
  });
  expect(nodes.map((n) => n.name)).toEqual(['Foreign App', 'Foreign App — Doc', 'Save']);
});

test('BusctlAtspi.readTree scopes to the window inside the matching application', async () => {
  // The title names the WINDOW, not the application: the scoped walk must
  // resolve the frame inside the app, not the app's other windows.
  const bus = twoAppBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    scope: { title: 'Managed App — Doc' },
  });
  expect(nodes.map((n) => n.name)).toEqual(['Managed App — Doc', 'Save']);
  expect(nodes.some((n) => n.name === 'Foreign App — Doc')).toBe(false);
});

test('BusctlAtspi.readTree lets the class pick the application, the title the window', async () => {
  // The class is the application's OWN identity, so it decides WHICH
  // application the read is bound to. The title names the WINDOW inside it —
  // it must not hand the read to a DIFFERENT application whose name happens
  // to carry the title.
  const bus = classAndTitleBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    scope: { title: 'Doc', class: 'myapp' },
  });
  // 'myapp' holds the 'Doc' window; 'Doc Editor' and 'Doc Viewer' are other
  // apps that also carry the title in their NAME — the class must keep the
  // read away from both (and their names must not read as an ambiguity).
  expect(nodes.map((n) => n.name)).toEqual(['Doc', 'Save']);
  expect(nodes.some((n) => n.name === 'Doc Editor')).toBe(false);
  expect(nodes.some((n) => n.name === 'Doc Viewer')).toBe(false);
});

test('BusctlAtspi.readTree ignores title-carrying applications once the class names the application', async () => {
  // Regression: with {class:'myapp', title:'Doc'}, two unrelated applications
  // named 'Doc Editor' and 'Doc Viewer' tripped the application-title
  // ambiguity error even though 'myapp' has exactly one matching window. The
  // application-title checks apply only when no class-qualified application
  // was found.
  const bus = classAndTitleBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    scope: { class: 'myapp', title: 'Doc' },
  });
  expect(nodes.map((n) => n.name)).toEqual(['Doc', 'Save']);
});

test('BusctlAtspi.readTree rejects a class-qualified scope whose title matches no window', async () => {
  // Regression: when the class matched 'myapp' but the title matched no
  // window in it, the WHOLE application was returned — find/click would then
  // resolve labels in another window of that app. A supplied title that no
  // window carries fails loud instead of degrading to the application.
  const bus = classAndTitleBus();
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { class: 'myapp', title: 'Balloon' } }),
  ).rejects.toThrow(/matched the application but no window in it carries that title/);
});

/**
 * A canned a11y bus where the title 'Doc' is carried by a WINDOW of one
 * application ('myapp') and only by the NAME of another ('Doc Editor', whose
 * window is 'Untitled 1').
 *
 * A scope naming just {title:'Doc'} must resolve the window, not the
 * application whose name happens to carry the title.
 */
function docWindowVsNamedAppBus(): { exec: (args: string[]) => Promise<string> } {
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const nodes: Record<string, { role: string; name: string; bounds: number[] }> = {
    '/app1': { role: 'application', name: 'Doc Editor', bounds: [0, 0, 800, 600] },
    '/app1/frame': { role: 'frame', name: 'Untitled 1', bounds: [0, 0, 800, 600] },
    '/app1/btn': { role: 'push button', name: 'Save', bounds: [10, 20, 100, 40] },
    '/app2': { role: 'application', name: 'myapp', bounds: [0, 0, 800, 600] },
    '/app2/frame': { role: 'frame', name: 'Doc', bounds: [0, 0, 800, 600] },
    '/app2/btn': { role: 'push button', name: 'Save', bounds: [400, 500, 100, 40] },
  };
  const children: Record<string, [string, string][]> = {
    '/org/a11y/atspi/accessible/root': [
      [':1.5', '/app1'],
      [':1.6', '/app2'],
    ],
    '/app1': [[':1.5', '/app1/frame']],
    '/app1/frame': [[':1.5', '/app1/btn']],
    '/app2': [[':1.6', '/app2/frame']],
    '/app2/frame': [[':1.6', '/app2/btn']],
  };
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) return call(['unix:path=/tmp/at-spi/bus']);
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) return call([children[path] ?? []]);
    const node = nodes[path];
    if (!node) throw new Error(`unexpected busctl call: ${args.join(' ')}`);
    if (args.includes('GetRoleName')) return call([node.role]);
    if (args.includes('get-property')) return call(node.name);
    if (args.includes('GetState')) return call([[STATE_ENABLED_VISIBLE, 0]]);
    if (args.includes('GetExtents')) return call([node.bounds]);
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec };
}

test('BusctlAtspi.readTree resolves a matching window before an application named by the title', async () => {
  // Regression: with {title:'Doc'}, the application named 'Doc Editor' won
  // immediately even though the only window actually titled 'Doc' belongs to
  // 'myapp' — find/click would act in the wrong application. Matching windows
  // are resolved BEFORE an application-name substring is taken as the scope.
  const bus = docWindowVsNamedAppBus();
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { title: 'Doc' } });
  expect(nodes.map((n) => n.name)).toEqual(['Doc', 'Save']);
  expect(nodes.some((n) => n.name === 'Doc Editor')).toBe(false);
  expect(nodes.some((n) => n.name === 'Untitled 1')).toBe(false);
});

test('BusctlAtspi.readTree scopes a top level that reports a frame, not an application', async () => {
  // Toolkits differ: real trees report the registry's children as
  // `application`, some as `frame` (→ the contract role `window`). The
  // top-level match must not hinge on that role string, or the scope resolves
  // to nothing on half the desktops.
  const bus = fakeBus(); // '/app' is a `frame` named 'My App'
  const nodes = await new BusctlAtspi({ exec: bus.exec }).readTree({
    scope: { title: 'My App' },
  });
  expect(nodes.map((n) => n.name)).toEqual(['My App', 'OK']);
});

test('BusctlAtspi.readTree rejects a scope that matches nothing', async () => {
  // Failing loud is the point: returning the whole desktop would resolve the
  // lookup against some OTHER application's identically-labelled button.
  const bus = twoAppBus();
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { title: 'No Such App' } }),
  ).rejects.toThrow(AdapterError);
});

test('BusctlAtspi.readTree rejects a scope whose class matches no application', async () => {
  const bus = twoAppBus();
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { class: 'nosuchapp' } }),
  ).rejects.toThrow(/no application or window matched the scope/);
});

/**
 * A canned a11y bus holding TWO applications whose NAMES both carry the scoped
 * title — "My App" and "My App Helper" — each with its own "Save" button.
 *
 * The scope title matches both applications, so the walk cannot pick one: it
 * must fail loud rather than read both subtrees and resolve the label against
 * whichever the bus listed first.
 */
function ambiguousTitleBus(frames: [string, string] = ['My App — Doc', 'My App Helper — Doc']): {
  exec: (args: string[]) => Promise<string>;
} {
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const nodes: Record<string, { role: string; name: string; bounds: number[] }> = {
    '/app1': { role: 'application', name: 'My App', bounds: [0, 0, 800, 600] },
    '/app1/frame': { role: 'frame', name: frames[0], bounds: [0, 0, 800, 600] },
    '/app1/btn': { role: 'push button', name: 'Save', bounds: [10, 20, 100, 40] },
    '/app2': { role: 'application', name: 'My App Helper', bounds: [0, 0, 800, 600] },
    '/app2/frame': { role: 'frame', name: frames[1], bounds: [0, 0, 800, 600] },
    '/app2/btn': { role: 'push button', name: 'Save', bounds: [400, 500, 100, 40] },
  };
  const children: Record<string, [string, string][]> = {
    '/org/a11y/atspi/accessible/root': [
      [':1.5', '/app1'],
      [':1.6', '/app2'],
    ],
    '/app1': [[':1.5', '/app1/frame']],
    '/app1/frame': [[':1.5', '/app1/btn']],
    '/app2': [[':1.6', '/app2/frame']],
    '/app2/frame': [[':1.6', '/app2/btn']],
  };
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) return call(['unix:path=/tmp/at-spi/bus']);
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) return call([children[path] ?? []]);
    const node = nodes[path];
    if (!node) throw new Error(`unexpected busctl call: ${args.join(' ')}`);
    if (args.includes('GetRoleName')) return call([node.role]);
    if (args.includes('get-property')) return call(node.name);
    if (args.includes('GetState')) return call([[STATE_ENABLED_VISIBLE, 0]]);
    if (args.includes('GetExtents')) return call([node.bounds]);
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec };
}

/**
 * A canned a11y bus holding an application 'myapp' (the class) with a window
 * titled "Doc", plus TWO unrelated applications — 'Doc Editor' and 'Doc
 * Viewer' — whose NAMES carry the same title.
 *
 * A scope naming both the class and the title must resolve to the 'Doc' window
 * inside 'myapp': the class is the application's own identity, so it decides
 * which application the read is bound to, and the other applications' names
 * must not trip an application-title ambiguity.
 */
function classAndTitleBus(): { exec: (args: string[]) => Promise<string> } {
  const call = (data: unknown): string => JSON.stringify({ type: 'x', data });
  const nodes: Record<string, { role: string; name: string; bounds: number[] }> = {
    '/app1': { role: 'application', name: 'myapp', bounds: [0, 0, 800, 600] },
    '/app1/frame': { role: 'frame', name: 'Doc', bounds: [0, 0, 800, 600] },
    '/app1/btn': { role: 'push button', name: 'Save', bounds: [10, 20, 100, 40] },
    '/app2': { role: 'application', name: 'Doc Editor', bounds: [0, 0, 800, 600] },
    '/app2/frame': { role: 'frame', name: 'Doc Editor — Doc', bounds: [0, 0, 800, 600] },
    '/app2/btn': { role: 'push button', name: 'Save', bounds: [400, 500, 100, 40] },
    '/app3': { role: 'application', name: 'Doc Viewer', bounds: [0, 0, 800, 600] },
    '/app3/frame': { role: 'frame', name: 'Doc Viewer — Doc', bounds: [0, 0, 800, 600] },
    '/app3/btn': { role: 'push button', name: 'Save', bounds: [700, 100, 100, 40] },
  };
  const children: Record<string, [string, string][]> = {
    '/org/a11y/atspi/accessible/root': [
      [':1.5', '/app1'],
      [':1.6', '/app2'],
      [':1.7', '/app3'],
    ],
    '/app1': [[':1.5', '/app1/frame']],
    '/app1/frame': [[':1.5', '/app1/btn']],
    '/app2': [[':1.6', '/app2/frame']],
    '/app2/frame': [[':1.6', '/app2/btn']],
    '/app3': [[':1.7', '/app3/frame']],
    '/app3/frame': [[':1.7', '/app3/btn']],
  };
  const exec = async (args: string[]): Promise<string> => {
    if (args.includes('GetAddress')) return call(['unix:path=/tmp/at-spi/bus']);
    const path = args[4] ?? '';
    if (args.includes('GetChildren')) return call([children[path] ?? []]);
    const node = nodes[path];
    if (!node) throw new Error(`unexpected busctl call: ${args.join(' ')}`);
    if (args.includes('GetRoleName')) return call([node.role]);
    if (args.includes('get-property')) return call(node.name);
    if (args.includes('GetState')) return call([[STATE_ENABLED_VISIBLE, 0]]);
    if (args.includes('GetExtents')) return call([node.bounds]);
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec };
}

test('BusctlAtspi.readTree rejects a title that matches two windows across applications', async () => {
  // "My App" and "My App Helper" both carry the scoped title, and so do both
  // their windows: matching windows come first, and TWO of them is the same
  // ambiguity one level down — the walk would start from both and the "Save"
  // lookup would resolve against whichever the bus listed first.
  const bus = ambiguousTitleBus();
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { title: 'My App' } }),
  ).rejects.toThrow(AdapterError);
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { title: 'My App' } }),
  ).rejects.toThrow(/ambiguous.*2 windows.*exactly one/);
});

test('BusctlAtspi.readTree rejects a title two applications carry when no window does', async () => {
  // No window carries the title, so the fallback applies: the title is taken
  // as an application name — and TWO applications carrying it is an
  // ambiguity, not a choice. (With a class in the scope the class-qualified
  // application decides and this check never runs.)
  const bus = ambiguousTitleBus(['Untitled 1', 'Untitled 2']);
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { title: 'My App' } }),
  ).rejects.toThrow(/ambiguous.*2 applications.*exactly one/);
});

test('BusctlAtspi.readTree rejects a scope that names two windows', async () => {
  // The same ambiguity one level down: two applications each hold a window
  // titled "Doc", so the title does not pick one window either.
  const bus = twoAppBus();
  await expect(
    new BusctlAtspi({ exec: bus.exec }).readTree({ scope: { title: 'Doc' } }),
  ).rejects.toThrow(/ambiguous.*2 windows.*exactly one/);
});

test('BusctlAtspi.readTree fails loud when the scoped walk runs out of time', async () => {
  // A deadline that is already spent is a TIMEOUT, not an empty tree: the walk
  // never reached the scoped window, so it cannot say the window has no
  // "Save" in it. Reporting an empty tree would send the caller looking for a
  // bug that is really a budget that ran out.
  const bus = twoAppBus();
  let calls = 0;
  const counting = async (args: string[]): Promise<string> => {
    calls += 1;
    return bus.exec(args);
  };
  await expect(
    new BusctlAtspi({ exec: counting }).readTree({
      scope: { title: 'Managed App' },
      deadline: Date.now() - 1,
    }),
  ).rejects.toThrow(/ran out of time before it reached the scoped window/);
  expect(calls).toBe(0); // no busctl spawn was spent on a walk that had no time
});
