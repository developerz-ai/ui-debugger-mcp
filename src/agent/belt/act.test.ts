import { expect, test } from 'bun:test';
import type {
  Adapter,
  Node,
  NodeRef,
  Query,
  ScrollOptions,
  WaitOptions,
} from '../../adapters/contract.js';
import { AdapterError, AgentError } from '../../errors.js';
import type { Findings } from '../../findings/schema.js';
import {
  type ActInput,
  ActInputSchema,
  type ActResult,
  createActTool,
  runAct,
  type StepRecorder,
} from './act.js';
import { createReportTool } from './report.js';
import { createActTrail } from './trail.js';

/** Calls the fake adapter recorded, to assert routing + ordering. */
interface AdapterCalls {
  find: Query[];
  click: NodeRef[];
  type: Array<{ target: NodeRef; text: string }>;
  pressKey: string[];
  scroll: ScrollOptions[];
  open: string[];
  waitFor: WaitOptions[];
  order: string[];
}

/** A fake {@link Adapter} that records calls and returns a canned `find` result. */
function fakeAdapter(found: Node | null): {
  adapter: Adapter;
  calls: AdapterCalls;
  png: Uint8Array;
} {
  const png = new Uint8Array([1, 2, 3, 4]);
  const calls: AdapterCalls = {
    find: [],
    click: [],
    type: [],
    pressKey: [],
    scroll: [],
    open: [],
    waitFor: [],
    order: [],
  };
  const adapter: Adapter = {
    open: async (target) => {
      calls.open.push(target);
      calls.order.push('open');
    },
    find: async (opts) => {
      calls.find.push(opts);
      return found;
    },
    click: async (target) => {
      calls.click.push(target);
      calls.order.push('click');
    },
    type: async (target, text) => {
      calls.type.push({ target, text });
      calls.order.push('type');
    },
    pressKey: async (key) => {
      calls.pressKey.push(key);
      calls.order.push('pressKey');
    },
    scroll: async (opts) => {
      calls.scroll.push(opts);
      calls.order.push('scroll');
    },
    readState: async () => [],
    screenshot: async () => {
      calls.order.push('screenshot');
      return png;
    },
    waitFor: async (opts) => {
      calls.waitFor.push(opts);
      calls.order.push('waitFor');
    },
    console: async () => [],
    network: async () => [],
    close: async () => {},
  };
  return { adapter, calls, png };
}

/** Calls the fake recorder received. */
interface RecorderCalls {
  logs: Array<{ channel: string; line: string }>;
  screenshots: Array<{ label: string; data: Uint8Array }>;
}

/** A fake {@link StepRecorder} that records what it was asked to persist. */
function fakeRecorder(): { recorder: StepRecorder; rec: RecorderCalls } {
  const rec: RecorderCalls = { logs: [], screenshots: [] };
  const recorder: StepRecorder = {
    appendLog: async (channel, line) => {
      rec.logs.push({ channel, line });
      return `logs/${channel}.log`;
    },
    saveScreenshot: async (label, data) => {
      rec.screenshots.push({ label, data });
      return `screenshots/001-${label}.png`;
    },
  };
  return { recorder, rec };
}

const button: Node = {
  role: 'button',
  name: 'Save',
  bounds: { x: 0, y: 0, width: 10, height: 10 },
  enabled: true,
};

test('click → find then click the resolved node, label from target', async () => {
  const { adapter, calls, png } = fakeAdapter(button);
  const { recorder, rec } = fakeRecorder();
  const res = await runAct(adapter, recorder, {
    action: 'click',
    target: 'role=button[name=Save]',
  });
  expect(calls.find).toEqual([{ query: 'role=button[name=Save]' }]);
  expect(calls.click).toEqual([button]);
  expect(res.action).toBe('click');
  expect(res.label).toBe('click button "Save"');
  expect(rec.screenshots).toEqual([{ label: 'click button "Save"', data: png }]);
  expect(rec.logs[0]?.channel).toBe('agent');
  expect(rec.logs[0]?.line).toContain('act click button "Save" → ');
  expect(res.screenshot).toBe('screenshots/001-click button "Save".png');
});

test('type → find then type text, label carries char count not the raw text', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder, rec } = fakeRecorder();
  const res = await runAct(adapter, recorder, { action: 'type', target: '#email', text: 'a@b.co' });
  expect(calls.type).toEqual([{ target: button, text: 'a@b.co' }]);
  expect(res.label).toBe('type 6 chars into button "Save"');
  // the secret-ish input never lands in the label, the log line, or the frame name
  expect(rec.logs[0]?.line).not.toContain('a@b.co');
  expect(rec.screenshots[0]?.label).not.toContain('a@b.co');
});

test('navigate → open(target), no find', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, { action: 'navigate', target: 'https://x.test' });
  expect(calls.open).toEqual(['https://x.test']);
  expect(calls.find).toEqual([]);
  expect(res.label).toBe('navigate to https://x.test');
});

// Observed end-to-end: given the goal "debug the Nimbus Store home page", the driver's
// FIRST act was navigate → https://nimbus-store.vercel.app, a public site it inferred
// from the goal text. The run then reported six confident bugs about a stranger's app.
test('navigate off the app under test is refused, naming where the run belongs', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();

  const attempt = runAct(
    adapter,
    recorder,
    { action: 'navigate', target: 'https://nimbus-store.vercel.app' },
    undefined,
    undefined,
    'http://127.0.0.1:5179',
  );

  await expect(attempt).rejects.toThrow(AgentError);
  await expect(attempt).rejects.toThrow(/leaves the app under test \(http:\/\/127\.0\.0\.1:5179\)/);
  expect(calls.open).toEqual([]); // never reached the adapter
});

test('navigate within the app under test passes — paths and same-origin URLs', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const origin = 'http://127.0.0.1:5179';

  await runAct(
    adapter,
    recorder,
    { action: 'navigate', target: '/checkout' },
    undefined,
    undefined,
    origin,
  );
  await runAct(
    adapter,
    recorder,
    { action: 'navigate', target: 'http://127.0.0.1:5179/cart?x=1' },
    undefined,
    undefined,
    origin,
  );

  expect(calls.open).toEqual(['/checkout', 'http://127.0.0.1:5179/cart?x=1']);
});

// Desktop/android `navigate` means a window title or an app package, never a URL —
// pinning an origin there would break every non-web run.
test('with no origin (desktop/android) navigate is unrestricted', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  await runAct(adapter, recorder, { action: 'navigate', target: 'com.example.app/.MainActivity' });
  expect(calls.open).toEqual(['com.example.app/.MainActivity']);
});

test('wait → waitFor with all conditions, label lists them', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, {
    action: 'wait',
    target: '#ready',
    networkIdle: true,
    timeout: 5000,
  });
  expect(calls.waitFor).toEqual([{ query: '#ready', networkIdle: true, timeout: 5000 }]);
  expect(res.label).toBe('wait for "#ready" + network idle + 5000ms');
});

test('wait on networkIdle alone → no target needed', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, { action: 'wait', networkIdle: true });
  expect(calls.waitFor).toEqual([{ query: undefined, networkIdle: true, timeout: undefined }]);
  expect(res.label).toBe('wait for network idle');
});

test('bare wait is rejected by the belt, not by the adapter', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  // A timeout alone is a sleep: still no condition, still rejected.
  for (const input of [{}, { networkIdle: false }, { target: '' }, { timeout: 1000 }] as const) {
    await expect(runAct(adapter, recorder, { action: 'wait', ...input })).rejects.toThrow(
      /act 'wait' requires 'target'.*'networkIdle'/,
    );
  }
  expect(calls.waitFor).toEqual([]);
});

test('a rejected bare wait still lands on the trail as a failed step', async () => {
  const { adapter } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  await expect(runAct(adapter, recorder, { action: 'wait' }, trail)).rejects.toThrow(AgentError);
  expect(trail.steps[0]?.step).toBe('wait');
  expect(trail.steps[0]?.ok).toBe(false);
  expect(trail.steps[0]?.note).toContain("act 'wait' requires");
});

test('records the post-action frame: screenshot is taken AFTER the action', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await runAct(adapter, recorder, { action: 'click', target: '#x' });
  expect(calls.order).toEqual(['click', 'screenshot']);
});

// --- Every step reaches the trail, with a truthful `ok` --------------------

test('a successful act is recorded on the trail as ok:true, with its frame', async () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  const res = await runAct(adapter, recorder, { action: 'click', target: '#x' }, trail);
  expect(res.ok).toBe(true);
  expect(trail.steps).toEqual([
    {
      step: 'click button "Save"',
      ok: true,
      screenshot: 'screenshots/001-click button "Save".png',
    },
  ]);
});

test('the trail read settles only after the act it announced has recorded', async () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  // What a same-step `act` + `report` looks like: the terminal read starts while
  // the act is still in flight and must still see it.
  const acting = runAct(adapter, recorder, { action: 'click', target: '#x' }, trail);
  const settled = await trail.settled();
  await acting;
  expect(settled.map((s) => s.step)).toEqual(['click button "Save"']);
});

test('an act that throws is recorded as ok:false with the error, then rethrown', async () => {
  const { adapter } = fakeAdapter(button);
  adapter.click = async () => {
    throw new AdapterError('node detached');
  };
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  await expect(
    runAct(adapter, recorder, { action: 'click', target: '#save' }, trail),
  ).rejects.toThrow(AdapterError);
  // labelled from the input (no target-derived label exists once the action threw),
  // flagged false, error text kept as the note
  expect(trail.steps).toEqual([
    { step: 'click #save', ok: false, note: 'AdapterError: node detached' },
  ]);
});

test('an act that throws before resolving is labelled from its input', async () => {
  const { adapter } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  await expect(
    runAct(adapter, recorder, { action: 'click', target: '#missing' }, trail),
  ).rejects.toThrow(AgentError);
  expect(trail.steps[0]?.step).toBe('click #missing');
  expect(trail.steps[0]?.ok).toBe(false);
  expect(trail.steps[0]?.note).toContain('no element matched');
});

test('a missing operand is recorded too — labelled by the bare action', async () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  await expect(runAct(adapter, recorder, { action: 'key' }, trail)).rejects.toThrow(AgentError);
  expect(trail.steps).toEqual([
    { step: 'key', ok: false, note: "AgentError: act 'key' requires 'key'" },
  ]);
});

test('a failed type step never leaks the typed text into the trail', async () => {
  const { adapter } = fakeAdapter(button);
  adapter.type = async () => {
    throw new AdapterError('input readonly');
  };
  const { recorder } = fakeRecorder();
  const trail = createActTrail();
  await expect(
    runAct(adapter, recorder, { action: 'type', target: '#email', text: 'hunter2@x.test' }, trail),
  ).rejects.toThrow(AdapterError);
  expect(JSON.stringify(trail.steps)).not.toContain('hunter2');
});

test('a failed evidence capture is recorded as ok:false under the acted label', async () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const failing: StepRecorder = {
    ...recorder,
    saveScreenshot: async () => {
      throw new AgentError('disk full');
    },
  };
  const trail = createActTrail();
  await expect(runAct(adapter, failing, { action: 'click', target: '#x' }, trail)).rejects.toThrow(
    AgentError,
  );
  expect(trail.steps).toEqual([
    { step: 'click button "Save"', ok: false, note: 'AgentError: disk full' },
  ]);
});

test('click with no match → throws AgentError, never clicks or records', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder, rec } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'click', target: '#missing' })).rejects.toThrow(
    AgentError,
  );
  expect(calls.click).toEqual([]);
  expect(rec.screenshots).toEqual([]);
  expect(rec.logs).toEqual([]);
});

test('key → pressKey(key), no find, label is the key', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, { action: 'key', key: 'Control+A' });
  expect(calls.pressKey).toEqual(['Control+A']);
  expect(calls.find).toEqual([]);
  expect(res.action).toBe('key');
  expect(res.label).toBe('key Control+A');
});

test('scroll → scroll(direction), target maps to within, amount in label', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, {
    action: 'scroll',
    direction: 'down',
    amount: 300,
    target: '#list',
  });
  expect(calls.scroll).toEqual([{ direction: 'down', amount: 300, within: '#list' }]);
  expect(res.label).toBe('scroll down 300px');
});

test('scroll without amount/target → viewport scroll, label omits px', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, { action: 'scroll', direction: 'up' });
  expect(calls.scroll).toEqual([{ direction: 'up', amount: undefined, within: undefined }]);
  expect(res.label).toBe('scroll up');
});

test('key without key → throws AgentError, never presses', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'key' })).rejects.toThrow(AgentError);
  expect(calls.pressKey).toEqual([]);
});

test('scroll without direction → throws AgentError, never scrolls', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'scroll' })).rejects.toThrow(AgentError);
  expect(calls.scroll).toEqual([]);
});

test('adapter errors propagate (fail loud, no swallow)', async () => {
  const { adapter } = fakeAdapter(button);
  adapter.click = async () => {
    throw new AdapterError('node detached');
  };
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'click', target: '#x' })).rejects.toThrow(
    AdapterError,
  );
});

test('schema rejects an unknown action', () => {
  expect(ActInputSchema.safeParse({ action: 'hover', target: '#x' }).success).toBe(false);
});

test('schema accepts a minimal click', () => {
  expect(ActInputSchema.safeParse({ action: 'click', target: '#x' }).success).toBe(true);
});

test('schema caps wait timeout at 60s — an uncapped wait would hang session teardown', () => {
  expect(ActInputSchema.safeParse({ action: 'wait', timeout: 600_000 }).success).toBe(false);
  expect(ActInputSchema.safeParse({ action: 'wait', timeout: 60_001 }).success).toBe(false);
  expect(ActInputSchema.safeParse({ action: 'wait', timeout: 60_000 }).success).toBe(true);
});

// The flat schema can't encode per-action requirements, so `runAct` enforces them.
test('type without text → throws AgentError (flat schema, runtime guard)', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'type', target: '#x' })).rejects.toThrow(
    AgentError,
  );
  // never typed, never recorded
  expect(calls.type).toEqual([]);
});

test('click without target → throws AgentError before any find', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'click' })).rejects.toThrow(AgentError);
  expect(calls.find).toEqual([]);
});

test('navigate without target → throws AgentError', async () => {
  const { adapter, calls } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'navigate' })).rejects.toThrow(AgentError);
  expect(calls.open).toEqual([]);
});

test('createActTool exposes a described tool with an input schema', () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  const act = createActTool(adapter, recorder);
  expect(typeof act.description).toBe('string');
  expect(act.inputSchema).toBeDefined();
});

// --- switch_tab + the multi-tab hint ----------------------------------------

/** Adapter that knows about tabs, recording every switch. */
function tabAdapter(count: number): { adapter: Adapter; switched: number[] } {
  const { adapter } = fakeAdapter(button);
  const switched: number[] = [];
  const tabs = Array.from({ length: count }, (_, index) => ({
    index,
    url: `http://x/${index}`,
    title: `Tab ${index}`,
    active: index === 0,
  }));
  return {
    adapter: {
      ...adapter,
      tabs: async () => tabs,
      selectTab: async (index: number) => {
        switched.push(index);
      },
    },
    switched,
  };
}

test('switch_tab routes the index to the adapter', async () => {
  const { adapter, switched } = tabAdapter(2);
  const res = await runAct(adapter, fakeRecorder().recorder, {
    action: 'switch_tab',
    target: '1',
  });
  expect(switched).toEqual([1]);
  expect(res.label).toBe('switch to tab 1');
});

test('switch_tab rejects a target that is not a tab index', async () => {
  const { adapter } = tabAdapter(2);
  await expect(
    runAct(adapter, fakeRecorder().recorder, { action: 'switch_tab', target: 'the popup' }),
  ).rejects.toThrow(AgentError);
});

test('switch_tab fails loud on a target with no tabs', async () => {
  const { adapter } = fakeAdapter(button);
  await expect(
    runAct(adapter, fakeRecorder().recorder, { action: 'switch_tab', target: '1' }),
  ).rejects.toThrow(AgentError);
});

test('act reports the tab list once a second tab is open', async () => {
  const { adapter } = tabAdapter(2);
  const res = await runAct(adapter, fakeRecorder().recorder, { action: 'click', target: 'Save' });
  expect(res.tabs?.length).toBe(2);
});

test('act stays silent about tabs when only one is open', async () => {
  const { adapter } = tabAdapter(1);
  const res = await runAct(adapter, fakeRecorder().recorder, { action: 'click', target: 'Save' });
  expect(res.tabs).toBeUndefined();
});

test('a failing tabs() never fails an otherwise-good act', async () => {
  const { adapter } = fakeAdapter(button);
  const flaky: Adapter = {
    ...adapter,
    tabs: async () => {
      throw new Error('page closed');
    },
  };
  const res = await runAct(flaky, fakeRecorder().recorder, { action: 'click', target: 'Save' });
  expect(res.ok).toBe(true);
  expect(res.tabs).toBeUndefined();
});

// --- unrequested full-document loads ----------------------------------------

/**
 * Adapter whose driven page loaded a new document during the act — the shape a
 * form submit with no `preventDefault`, or a click on a plain link, produces.
 * The queue drains on read, exactly like the real adapter's.
 */
function loadingAdapter(
  urls: string[],
  found: Node | null = button,
): { adapter: Adapter; drains: number } {
  const { adapter } = fakeAdapter(found);
  const queue = [...urls];
  const state = { drains: 0 };
  return {
    adapter: {
      ...adapter,
      takeUnrequestedLoads: async () => {
        state.drains += 1;
        return queue.splice(0, queue.length);
      },
    },
    get drains() {
      return state.drains;
    },
  };
}

test('act reports a full-document load the driver did not ask for', async () => {
  const { adapter } = loadingAdapter(['http://x/?email=a%40b.com']);
  const res = await runAct(adapter, fakeRecorder().recorder, {
    action: 'click',
    target: 'Subscribe',
  });
  expect(res.navigated).toEqual(['http://x/?email=a%40b.com']);
});

test('the reloaded step carries the load on the trail, still ok', async () => {
  const { adapter } = loadingAdapter(['http://x/?email=a%40b.com']);
  const trail = createActTrail();
  await runAct(adapter, fakeRecorder().recorder, { action: 'click', target: 'Subscribe' }, trail);
  const [step] = await trail.settled();
  expect(step?.ok).toBe(true);
  expect(step?.note).toContain('http://x/?email=a%40b.com');
  expect(step?.note).toMatch(/state was lost/i);
});

test('act stays silent when nothing navigated', async () => {
  const { adapter } = loadingAdapter([]);
  const res = await runAct(adapter, fakeRecorder().recorder, { action: 'click', target: 'Save' });
  expect(res.navigated).toBeUndefined();
});

test('a deliberate navigate is not reported as unrequested', async () => {
  // The adapter drains its own `open`, so nothing is left to report — but the
  // drain must still HAPPEN, or the next act inherits this navigation.
  const loader = loadingAdapter([]);
  const res = await runAct(loader.adapter, fakeRecorder().recorder, {
    action: 'navigate',
    target: 'http://x/next',
  });
  expect(res.navigated).toBeUndefined();
  expect(loader.drains).toBe(1);
});

test('a failed act drains too, so its loads never surface on the next step', async () => {
  // A bare `wait` throws inside performAct, so the act fails with the surprise
  // load already queued from whatever happened before it.
  const loader = loadingAdapter(['http://x/gone']);
  const recorder = fakeRecorder().recorder;
  await expect(runAct(loader.adapter, recorder, { action: 'wait' })).rejects.toThrow(AgentError);
  const res = await runAct(loader.adapter, recorder, { action: 'click', target: 'Save' });
  expect(res.navigated).toBeUndefined();
});

test('a failing takeUnrequestedLoads() never fails an otherwise-good act', async () => {
  const { adapter } = fakeAdapter(button);
  const flaky: Adapter = {
    ...adapter,
    takeUnrequestedLoads: async () => {
      throw new Error('page closed');
    },
  };
  const res = await runAct(flaky, fakeRecorder().recorder, { action: 'click', target: 'Save' });
  expect(res.ok).toBe(true);
  expect(res.navigated).toBeUndefined();
});

// --- concurrency: a step's batched acts must not interleave -----------------

test('the act tool serializes concurrent calls — batched types never interleave', async () => {
  // Models batch "type email" + "type password" into ONE step, and the SDK runs a
  // step's tool calls concurrently. Keyboard input goes to the PAGE, so overlapping
  // acts type into whichever field last took focus. This reproduces that: each act
  // records enter/exit, and any overlap shows up as interleaved markers.
  const order: string[] = [];
  const { adapter } = fakeAdapter(button);
  const slow: Adapter = {
    ...adapter,
    type: async (_target, text) => {
      order.push(`enter:${text}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push(`exit:${text}`);
    },
  };

  const tool = createActTool(slow, fakeRecorder().recorder);
  const run = (text: string) =>
    (tool as unknown as { execute: (input: ActInput) => Promise<ActResult> }).execute({
      action: 'type',
      target: 'Field',
      text,
    });

  await Promise.all([run('email'), run('password')]);

  // Strictly one act at a time: every enter is immediately followed by its exit.
  expect(order).toEqual(['enter:email', 'exit:email', 'enter:password', 'exit:password']);
});

test('two acts queued in ONE step: a report racing them still sees BOTH', async () => {
  // The driver batches `act` + `act` + `report` into one step and the SDK runs them
  // concurrently. Act #2 waits its turn on the serialization queue, so it used to
  // enter the trail's gate only AFTER act #1 released it — and `settled()`'s waiter
  // is scheduled before the queue continuation, so the terminal read saw an idle
  // gate and wrote a verdict missing act #2. The loop then stops on that report, so
  // act #2 — which really ran against the live UI — reached no persisted file at all.
  const trail = createActTrail();
  const { adapter } = fakeAdapter(button);
  // Label each act after its own target so the two are distinguishable, and let a
  // click take a real tick — a live act spans event-loop turns, which is exactly
  // when the barrier used to be checked between the two queued acts.
  const named: Adapter = {
    ...adapter,
    find: async (opts) => ({ ...button, name: `${opts.query}` }),
    click: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    },
  };
  const act = createActTool(named, fakeRecorder().recorder, trail);

  const written: Findings[] = [];
  const report = createReportTool(
    {
      writeFindings: async (findings) => {
        written.push(findings);
        return 'findings.json';
      },
    },
    () => trail.settled(),
  );
  const call = (t: unknown, input: unknown): Promise<unknown> =>
    (t as { execute: (i: unknown) => Promise<unknown> }).execute(input);

  await Promise.all([
    call(act, { action: 'click', target: 'A' }),
    call(act, { action: 'click', target: 'B' }),
    call(report, { status: 'passed', steps: [], bugs: [], visual: [] }),
  ]);

  expect(written.at(-1)?.steps.map((step) => step.step)).toEqual([
    'click button "A"',
    'click button "B"',
  ]);
});

test('a failed act does not wedge the queue for the next one', async () => {
  let first = true;
  const { adapter } = fakeAdapter(button);
  const flaky: Adapter = {
    ...adapter,
    type: async () => {
      if (first) {
        first = false;
        throw new Error('element detached');
      }
    },
  };
  const tool = createActTool(flaky, fakeRecorder().recorder);
  const run = (text: string) =>
    (tool as unknown as { execute: (input: ActInput) => Promise<ActResult> }).execute({
      action: 'type',
      target: 'Field',
      text,
    });

  const failed = run('first');
  const after = run('second');
  await expect(failed).rejects.toThrow();
  // The rejection reaches the driver AND the chain keeps moving.
  await expect(after).resolves.toMatchObject({ ok: true });
});

test('type with clear empties the field before typing, not after focusing it', async () => {
  const { adapter, calls } = fakeAdapter(button);
  await runAct(adapter, fakeRecorder().recorder, {
    action: 'type',
    target: 'Title',
    text: 'new title',
    clear: true,
  });
  // Select-all + Delete must land BEFORE the typing, and the typing must be last:
  // a trailing click (every `type` focuses by clicking) would collapse a selection,
  // so clearing has to actually empty the field.
  expect(calls.pressKey).toEqual(['Control+a', 'Delete']);
  expect(calls.type.map((c) => c.text)).toEqual(['', 'new title']);
});

test('type without clear still appends — the default is unchanged', async () => {
  const { adapter, calls } = fakeAdapter(button);
  await runAct(adapter, fakeRecorder().recorder, {
    action: 'type',
    target: 'Title',
    text: 'more',
  });
  expect(calls.pressKey).toEqual([]);
  expect(calls.type.map((c) => c.text)).toEqual(['more']);
});
