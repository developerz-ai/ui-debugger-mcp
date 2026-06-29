import { expect, test } from 'bun:test';
import type { Adapter, Node, NodeRef, Query, WaitOptions } from '../../adapters/contract.js';
import { AdapterError, AgentError } from '../../errors.js';
import { ActInputSchema, createActTool, runAct, type StepRecorder } from './act.js';

/** Calls the fake adapter recorded, to assert routing + ordering. */
interface AdapterCalls {
  find: Query[];
  click: NodeRef[];
  type: Array<{ target: NodeRef; text: string }>;
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
  const calls: AdapterCalls = { find: [], click: [], type: [], open: [], waitFor: [], order: [] };
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
    pressKey: async () => {
      calls.order.push('pressKey');
    },
    scroll: async () => {
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

test('wait with no conditions → labels next frame', async () => {
  const { adapter } = fakeAdapter(null);
  const { recorder } = fakeRecorder();
  const res = await runAct(adapter, recorder, { action: 'wait' });
  expect(res.label).toBe('wait for next frame');
});

test('records the post-action frame: screenshot is taken AFTER the action', async () => {
  const { adapter, calls } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await runAct(adapter, recorder, { action: 'click', target: '#x' });
  expect(calls.order).toEqual(['click', 'screenshot']);
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

test('key → throws AgentError (no contract verb yet)', async () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'key', key: 'Enter' })).rejects.toThrow(
    AgentError,
  );
});

test('scroll → throws AgentError (no contract verb yet)', async () => {
  const { adapter } = fakeAdapter(button);
  const { recorder } = fakeRecorder();
  await expect(runAct(adapter, recorder, { action: 'scroll', direction: 'down' })).rejects.toThrow(
    AgentError,
  );
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
