import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/** A window that never comes up — stands in for the real 10s xdotool poll. */
class StuckPointer extends FakePointer {
  override activateWindow(match: WindowMatch): Promise<void> {
    this.calls.push(`activate:${JSON.stringify(match)}`);
    return new Promise<void>(() => {});
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

test('open refuses to launch when there is no window to drive', async () => {
  // No `window` config and a blank open target (what session-builder passes): the old
  // code spawned the app and resolved having verified nothing.
  const { adapter, input } = build();
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
