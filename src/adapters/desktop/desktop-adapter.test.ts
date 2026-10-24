import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DesktopTarget } from '../../config/schema.js';
import { AdapterError } from '../../errors.js';
import type { Node, ScrollDirection } from '../contract.js';
import {
  type AtspiNode,
  type AtspiReadOptions,
  type AtspiSource,
  BusctlAtspi,
  matchesQuery,
} from './atspi.js';
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
  measured: true,
  ...over,
});

/** A node AT-SPI could not measure (no `Component`) — zeros are a placeholder. */
const unmeasured = (name: string): AtspiNode =>
  atspiNode({ name, measured: false, bounds: { x: 0, y: 0, width: 0, height: 0 } });

class FakeAtspi implements AtspiSource {
  constructor(readonly nodes: AtspiNode[]) {}
  async readTree(_opts?: AtspiReadOptions): Promise<AtspiNode[]> {
    return this.nodes;
  }
}

/**
 * An AT-SPI source that behaves like the real walk: it collects **query matches** and
 * stops at `maxNodes` — so a `maxNodes` tighter than the caller's post-walk narrowing
 * (region/filters) hides matches that sit deeper. Records the options it was given.
 */
class WalkingAtspi implements AtspiSource {
  lastOpts: AtspiReadOptions | undefined;
  constructor(readonly nodes: AtspiNode[]) {}
  async readTree(opts: AtspiReadOptions = {}): Promise<AtspiNode[]> {
    this.lastOpts = opts;
    const query = opts.query;
    const matched = query ? this.nodes.filter((n) => matchesQuery(n, query)) : this.nodes;
    return matched.slice(0, opts.maxNodes ?? matched.length);
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
  /** Per-call window-wait cap — how much of the run's budget `open` handed down. */
  readonly waits: number[] = [];
  /** The ABSOLUTE deadline of each window wait — what its xdotool calls are capped by. */
  readonly deadlines: (number | undefined)[] = [];
  async activateWindow(match: WindowMatch, timeoutMs: number, deadline?: number): Promise<void> {
    this.calls.push(`activate:${JSON.stringify(match)}`);
    this.waits.push(timeoutMs);
    this.deadlines.push(deadline);
  }
}

/** A window that never comes up — stands in for the real 10s xdotool poll. */
class StuckPointer extends FakePointer {
  override activateWindow(match: WindowMatch): Promise<void> {
    this.calls.push(`activate:${JSON.stringify(match)}`);
    return new Promise<void>(() => {});
  }
}

/**
 * An AT-SPI source whose walk answers only AFTER the wait's deadline — the shape of
 * a bus that replies late. `waitFor` must not read that as the node having appeared.
 */
class LateAtspi implements AtspiSource {
  async readTree(_opts?: AtspiReadOptions): Promise<AtspiNode[]> {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return [atspiNode({ name: 'OK' })];
  }
}

class FakeCapture implements ScreenCapture {
  async capture(): Promise<Uint8Array> {
    return new Uint8Array([1, 2, 3]);
  }
}

const config: DesktopTarget = { adapter: 'desktop', launch: 'true', window: { title: 'App' } };

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

/** Build an adapter over the match-counting {@link WalkingAtspi} walk. */
function walking(nodes: AtspiNode[]): { adapter: DesktopAdapter; atspi: WalkingAtspi } {
  const atspi = new WalkingAtspi(nodes);
  return {
    adapter: DesktopAdapter.create({
      config,
      atspi,
      input: new FakePointer(),
      capture: new FakeCapture(),
    }),
    atspi,
  };
}

test('find with filters does not let `limit` stop the walk at a filtered-out match', async () => {
  // The first breadth-first "Save" is disabled; the enabled one sits deeper. `limit: 1`
  // used to cap the *walk*, so the filter then dropped the only node it was given and
  // click reported `no element matched query "Save"` for a button that is right there.
  const { adapter, atspi } = walking([
    atspiNode({ name: 'Save', enabled: false }),
    atspiNode({ name: 'Save', enabled: true }),
  ]);
  const found = await adapter.find({ query: 'Save', filters: { enabled_eq: true } });
  expect(found?.enabled).toBe(true);
  expect(atspi.lastOpts?.maxNodes).toBe(200); // not 1 — filters are applied after the walk
});

test('find without filters still stops the walk at the first match', async () => {
  const { adapter, atspi } = walking([atspiNode({ name: 'Save' })]);
  expect((await adapter.find({ query: 'Save' }))?.name).toBe('Save');
  expect(atspi.lastOpts?.maxNodes).toBe(1); // the walk-pruning optimization is intact
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

// --- zero-size targets ------------------------------------------------------

test('click on a zero-size node throws instead of clicking the screen corner', async () => {
  // AT-SPI reported no Component (or the widget is not laid out yet): its "center" is
  // (0,0). The old code clicked the desktop's top-left and reported success.
  const { adapter, input } = build([unmeasured('App root')]);
  await expect(adapter.click('App root')).rejects.toThrow(/has zero size \(0x0\)/);
  await expect(adapter.click('App root')).rejects.toThrow(AdapterError);
  expect(input.calls).toEqual([]);
});

test('type into a zero-size node throws before any keystroke', async () => {
  const { adapter, input } = build([unmeasured('Ghost field')]);
  await expect(adapter.type('Ghost field', 'secret')).rejects.toThrow(AdapterError);
  expect(input.calls).toEqual([]); // no click, and the text never reaches the screen
});

test('a zero-size Node ref is rejected too (not just resolved selectors)', async () => {
  const { adapter } = build([]);
  const node: Node = {
    role: 'button',
    name: '',
    bounds: { x: 40, y: 40, width: 0, height: 10 },
    enabled: true,
  };
  await expect(adapter.click(node)).rejects.toThrow(/button has zero size \(0x10\)/);
});

test('scroll within a zero-size region throws instead of parking at the origin', async () => {
  const { adapter, input } = build([unmeasured('Panel')]);
  await expect(adapter.scroll({ direction: 'down', within: 'Panel' })).rejects.toThrow(
    AdapterError,
  );
  expect(input.calls).toEqual([]);
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

test('waitFor hands its deadline to the walk so one poll cannot outlive the timeout', async () => {
  // `maxNodes` bounds matches, not visited nodes: on a big tree (Electron with a11y on)
  // a fruitless walk runs for minutes, and waitFor — which only checks the clock between
  // polls — overshot its own timeout by a whole walk.
  const { adapter, atspi } = walking([]);
  const started = Date.now();
  await expect(adapter.waitFor({ query: 'Ghost', timeout: 50 })).rejects.toThrow(AdapterError);
  const deadline = atspi.lastOpts?.deadline;
  expect(deadline).toBeGreaterThanOrEqual(started + 50);
  expect(deadline).toBeLessThan(started + 5_000);
});

test('waitFor rejects networkIdle and an empty wait (unsupported on desktop)', async () => {
  const { adapter } = build();
  await expect(adapter.waitFor({ networkIdle: true })).rejects.toThrow(AdapterError);
  await expect(adapter.waitFor({})).rejects.toThrow(AdapterError);
});

test('waitFor rejects a query that only appears after the timeout', async () => {
  // The node shows up 60ms into a 20ms wait: that is not a success — resolving would
  // report a match the caller waited too long for.
  const adapter = DesktopAdapter.create({
    config,
    atspi: new LateAtspi(),
    input: new FakePointer(),
    capture: new FakeCapture(),
  });
  await expect(adapter.waitFor({ query: 'OK', timeout: 20 })).rejects.toThrow(AdapterError);
  await expect(adapter.waitFor({ query: 'OK', timeout: 20 })).rejects.toThrow(/waitFor timed out/);
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

// --- open (managed process lifecycle) -----------------------------------------

/** Build an adapter whose window never appears, so only the launch outcome decides `open`. */
function stuck(launch: string): DesktopAdapter {
  return DesktopAdapter.create({
    config: { adapter: 'desktop', launch, window: { title: 'Ghost' } },
    atspi: new FakeAtspi([]),
    input: new StuckPointer(),
    capture: new FakeCapture(),
  });
}

test('open fails loud with the launch command exit code, not a window timeout', async () => {
  // Without the death latch this waits out WINDOW_WAIT_MS (10s) and blames the window.
  await expect(stuck('exit 3').open('Ghost')).rejects.toThrow(/exit code 3/);
  await expect(stuck('exit 3').open('Ghost')).rejects.toThrow(AdapterError);
});

test('open names the real reason when the launch binary is missing', async () => {
  // /bin/sh reports "command not found" as 127 — the actionable signal, in seconds.
  await expect(stuck('__uidbg_no_such_binary__ --go').open('Ghost')).rejects.toThrow(
    /exit code 127/,
  );
});

test('open reports a launch killed by a signal', async () => {
  await expect(stuck('kill -TERM $$').open('Ghost')).rejects.toThrow(/killed by SIGTERM/);
});

test('open resolves once the window activates while the app stays up', async () => {
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'sleep 5', window: { title: 'App' } },
    atspi: new FakeAtspi([]),
    input,
    capture: new FakeCapture(),
  });
  await expect(adapter.open('App')).resolves.toBeUndefined();
  expect(input.calls).toEqual(['activate:{"title":"App"}']);
  await expect(adapter.close()).resolves.toBeUndefined(); // kills the group
});

test('open waits for the window no longer than the run has budget left', async () => {
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'sleep 5', window: { title: 'App' } },
    atspi: new FakeAtspi([]),
    input,
    capture: new FakeCapture(),
  });

  await adapter.open('App', 2_500); // tighter than the adapter's own 10s wait
  await adapter.open('App'); // no budget → the adapter's own wait stands

  expect(input.waits).toEqual([2_500, 10_000]);
  await expect(adapter.close()).resolves.toBeUndefined();
});

test('open hands the window wait an ABSOLUTE deadline its xdotool calls cannot outlive', async () => {
  // A duration alone is not enough: the xdotool calls the wait makes are capped by
  // the time left until the deadline, so an in-flight search cannot outlive the
  // budget the run has left.
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'sleep 5', window: { title: 'App' } },
    atspi: new FakeAtspi([]),
    input,
    capture: new FakeCapture(),
  });
  const started = Date.now();
  await adapter.open('App', 2_500);
  const deadline = input.deadlines[0];
  expect(typeof deadline).toBe('number');
  expect(deadline as number).toBeGreaterThanOrEqual(started + 2_500);
  expect(deadline as number).toBeLessThanOrEqual(Date.now() + 2_500);
  await expect(adapter.close()).resolves.toBeUndefined();
});

test('open refuses to launch when there is no window to drive', async () => {
  // No `window` config and a blank open target (what session-builder passes): the old
  // code spawned the app and resolved having verified nothing.
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'true' },
    atspi: new FakeAtspi([]),
    input,
    capture: new FakeCapture(),
  });
  await expect(adapter.open('  ')).rejects.toThrow(/no window to drive/);
  expect(input.calls).toEqual([]);
  await expect(adapter.close()).resolves.toBeUndefined(); // nothing was spawned
});

/** True while `pid` is alive (`kill -0`); false once it's gone (ESRCH). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('close SIGTERMs the whole process group, not just the shell', async () => {
  // The launched shell backgrounds a real child (`sleep`) and waits on it — a group
  // kill (`process.kill(-pid, ...)`) must reach that grandchild too, not just the
  // `/bin/sh` leader. Without `-pid` the child would be orphaned and outlive close().
  const dir = await mkdtemp(join(tmpdir(), 'uidbg-adapter-'));
  const pidFile = join(dir, 'child.pid');
  const adapter = DesktopAdapter.create({
    config: {
      adapter: 'desktop',
      launch: `sleep 30 & echo $! > ${JSON.stringify(pidFile)}; wait`,
      window: { title: 'App' },
    },
    atspi: new FakeAtspi([]),
    input: new FakePointer(),
    capture: new FakeCapture(),
  });
  try {
    await adapter.open('App');
    const start = Date.now();
    let childPid = 0;
    while (!childPid) {
      const text = (await readFile(pidFile, 'utf8').catch(() => '')).trim();
      childPid = Number(text) || 0;
      if (!childPid) {
        expect(Date.now() - start).toBeLessThan(5000); // the child never wrote its pid
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    expect(isAlive(childPid)).toBe(true);

    await adapter.close();

    const closeStart = Date.now();
    while (isAlive(childPid)) {
      expect(Date.now() - closeStart).toBeLessThan(3000); // the grandchild survived close()
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('open respawns the managed app after it exits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'uidbg-adapter-'));
  const file = join(dir, 'runs');
  const runs = async (): Promise<number> => {
    const text = await readFile(file, 'utf8').catch(() => '');
    return text.split('\n').filter((line) => line.length > 0).length;
  };
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: `echo run >> ${JSON.stringify(file)}` },
    atspi: new FakeAtspi([]),
    input: new FakePointer(),
    capture: new FakeCapture(),
  });
  try {
    await adapter.open('App');
    // The launch command exits immediately; the exit handler must clear the dead
    // process so a later `open` respawns. Poll — before the fix the stale
    // `#process` pins `open` to the corpse and the run count never reaches 2.
    const start = Date.now();
    while ((await runs()) < 2) {
      expect(Date.now() - start).toBeLessThan(5000); // second open never respawned
      await new Promise((resolve) => setTimeout(resolve, 50));
      await adapter.open('App');
    }
    // A close after the app died on its own is a clean no-op (nothing to kill).
    await expect(adapter.close()).resolves.toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- scoped reads (duplicate labels across applications) ---------------------

/**
 * A canned a11y bus holding TWO applications whose buttons share the label
 * "Save" — the FOREIGN one listed FIRST among the registry root's children,
 * so an unscoped walk reaches its button before the managed app's.
 *
 * The tree is registry root → application → frame → button, mirroring a real
 * AT-SPI tree. Each button sits at its own place on the screen, so the click
 * coordinates say WHICH app was hit.
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
    if (args.includes('GetState')) return call([[0x100 | (1 << 24) | (1 << 25) | (1 << 30), 0]]);
    if (args.includes('GetExtents')) return call([node.bounds]);
    throw new Error(`unexpected busctl call: ${args.join(' ')}`);
  };
  return { exec };
}

/** Build an adapter over the REAL {@link BusctlAtspi} on the two-app fake bus. */
function overTwoApps(target: DesktopTarget): { adapter: DesktopAdapter; input: FakePointer } {
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config: target,
    atspi: new BusctlAtspi({ exec: twoAppBus().exec }),
    input,
    capture: new FakeCapture(),
  });
  return { adapter, input };
}

test('find resolves the duplicate label inside the managed application', async () => {
  // The foreign app is listed first among the registry root's children, so an
  // unscoped walk reaches ITS "Save" first — the click would land in the wrong
  // window. Scoped to the managed app, the managed button is the one found.
  const { adapter } = overTwoApps({
    adapter: 'desktop',
    launch: 'true',
    window: { title: 'Managed App' },
  });
  const found = await adapter.find({ query: 'Save' });
  expect(found?.bounds).toEqual({ x: 400, y: 500, width: 100, height: 40 });
});

test('click and type act on the managed application, never the foreign one', async () => {
  const { adapter, input } = overTwoApps({
    adapter: 'desktop',
    launch: 'true',
    window: { title: 'Managed App' },
  });
  await adapter.click('Save');
  await adapter.type('Save', 'hello');
  // The managed button's center — the foreign one's would be (60, 40).
  expect(input.calls).toEqual(['click:450,520', 'click:450,520', 'type:hello']);
});

test('a read with no window ever selected fails loud instead of reading the desktop', async () => {
  // No `window` config and `open` never called: there is no window to scope to,
  // and an unscoped read would resolve the label against ANY application.
  const { adapter } = overTwoApps({ adapter: 'desktop', launch: 'true' });
  await expect(adapter.readState({ query: 'Save' })).rejects.toThrow(/no window selected/);
  await expect(adapter.find({ query: 'Save' })).rejects.toThrow(AdapterError);
  // The waitFor poll reads too — it must fail loud, not time out on a tree it
  // was never allowed to read.
  await expect(adapter.waitFor({ query: 'Save', timeout: 50 })).rejects.toThrow(
    /no window selected/,
  );
});

test('open re-scopes the reads to the window it selected', async () => {
  // A later `navigate` opens another window; the reads must follow it.
  const input = new FakePointer();
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'sleep 5' },
    atspi: new BusctlAtspi({ exec: twoAppBus().exec }),
    input,
    capture: new FakeCapture(),
  });
  await adapter.open('Foreign App');
  const found = await adapter.find({ query: 'Save' });
  expect(found?.bounds).toEqual({ x: 10, y: 20, width: 100, height: 40 });
  await adapter.close();
});

test('every read path carries the scope down to the AT-SPI walk', async () => {
  // The scope is the guard against the duplicate-label bug: a read that
  // reaches the bus without it walks every application on the desktop.
  const { adapter, atspi } = walking([atspiNode({ name: 'OK' })]);
  await adapter.readState({ query: 'OK' });
  expect(atspi.lastOpts?.scope).toEqual({ title: 'App' });
  await adapter.find({ query: 'OK' });
  expect(atspi.lastOpts?.scope).toEqual({ title: 'App' });
  // The `within` region scope resolves through the same scoped read.
  await adapter.readState({ query: 'OK', within: 'OK' });
  expect(atspi.lastOpts?.scope).toEqual({ title: 'App' });
  // The waitFor poll reads too.
  await adapter.waitFor({ query: 'OK', timeout: 100 });
  expect(atspi.lastOpts?.scope).toEqual({ title: 'App' });
});

test('the scope in force is the last opened window, else the configured one', async () => {
  const source = new WalkingAtspi([atspiNode({ name: 'OK' })]);
  const adapter = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'sleep 5', window: { title: 'App' } },
    atspi: source,
    input: new FakePointer(),
    capture: new FakeCapture(),
  });
  await adapter.readState({ query: 'OK' });
  expect(source.lastOpts?.scope).toEqual({ title: 'App' }); // the configured window
  // A configured window wins over the open target — it is the window xdotool
  // activates, so it is the window the scope must name.
  await adapter.open('Other Window');
  await adapter.readState({ query: 'OK' });
  expect(source.lastOpts?.scope).toEqual({ title: 'App' });
  await adapter.close();

  // With no configured window, the opened one is the scope.
  const other = new WalkingAtspi([atspiNode({ name: 'OK' })]);
  const unscoped = DesktopAdapter.create({
    config: { adapter: 'desktop', launch: 'sleep 5' },
    atspi: other,
    input: new FakePointer(),
    capture: new FakeCapture(),
  });
  await unscoped.open('Other Window');
  await unscoped.readState({ query: 'OK' });
  expect(other.lastOpts?.scope).toEqual({ title: 'Other Window' });
  await unscoped.close();
});
