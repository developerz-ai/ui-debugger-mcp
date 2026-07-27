/**
 * Prompt-vs-schema drift guard.
 *
 * The prompts TEACH the driver a vocabulary of `act` actions, `observe` kinds and
 * tree `fields` via inline code examples (`` act({action:"click"}) ``,
 * `` observe({kind:"tree"}) ``, `` fields:["role","name"] ``) and the canonical
 * "tool belt" verb list. Nothing stops a doc edit from teaching a verb the belt
 * schemas reject — that shipped once (`hover`, a `frames` kind/action neither
 * schema has) and burns the driver's steps on a call the belt throws away.
 *
 * This test extracts every such example from the base prompt (both eye modes)
 * and all three target addenda, and asserts it names something
 * {@link ACT_ACTIONS} / {@link OBSERVE_KINDS} / {@link NODE_FIELDS} actually accepts.
 */

import { expect, test } from 'bun:test';
import type { Adapter, Node } from '../../adapters/contract.js';
import { ACT_ACTIONS } from '../belt/act.js';
import { NODE_FIELDS, OBSERVE_KINDS, runObserve } from '../belt/observe.js';
import { ANDROID_ADDENDUM_PROMPT } from './android-addendum.js';
import { debugAgentPrompt } from './debug-agent.js';
import { DESKTOP_ADDENDUM_PROMPT } from './desktop-addendum.js';
import { WEB_ADDENDUM_PROMPT } from './web-addendum.js';

/** Every prompt string a driver session can be composed from, labelled for failure messages. */
const PROMPTS: Record<string, string> = {
  'debug-agent (vision mode)': debugAgentPrompt(false),
  'debug-agent (self-look mode)': debugAgentPrompt(true),
  'web addendum': WEB_ADDENDUM_PROMPT,
  'desktop addendum': DESKTOP_ADDENDUM_PROMPT,
  'android addendum': ANDROID_ADDENDUM_PROMPT,
};

test('every act({action:"…"}) example names a real ACT_ACTIONS verb', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    for (const match of prompt.matchAll(/action:"([a-zA-Z]+)"/g)) {
      const action = match[1];
      if (action !== undefined && !(ACT_ACTIONS as readonly string[]).includes(action)) {
        throw new Error(`${name}: act action "${action}" is not in ACT_ACTIONS`);
      }
    }
  }
});

test('every observe({kind:"…"}) example names a real OBSERVE_KINDS channel', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    for (const match of prompt.matchAll(/kind:"([a-zA-Z]+)"/g)) {
      const kind = match[1];
      if (kind !== undefined && !(OBSERVE_KINDS as readonly string[]).includes(kind)) {
        throw new Error(`${name}: observe kind "${kind}" is not in OBSERVE_KINDS`);
      }
    }
  }
});

test('every fields:[…] example lists only real NODE_FIELDS columns', () => {
  for (const [name, prompt] of Object.entries(PROMPTS)) {
    for (const match of prompt.matchAll(/fields:\[([^\]]*)\]/g)) {
      const list = match[1];
      if (list === undefined) continue;
      const requested = list
        .split(',')
        .map((raw) => raw.trim().replace(/^"|"$/g, ''))
        .filter((field) => field.length > 0);
      for (const field of requested) {
        if (!(NODE_FIELDS as readonly string[]).includes(field)) {
          throw new Error(`${name}: field "${field}" is not in NODE_FIELDS`);
        }
      }
    }
  }
});

// --- the native addenda vs what the belt really does ------------------------

/** The two addenda whose target has no DOM, no tabs, and no Playwright selectors. */
const NATIVE_PROMPTS: Record<string, string> = {
  'desktop addendum': DESKTOP_ADDENDUM_PROMPT,
  'android addendum': ANDROID_ADDENDUM_PROMPT,
};

/** A minimal NATIVE-shaped adapter — no `tabs`, which is what marks a web target. */
function nativeAdapter(nodes: Node[]): Adapter {
  return {
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async () => nodes,
    screenshot: async () => new Uint8Array(),
    waitFor: async () => {},
    console: async () => [],
    network: async () => [],
    close: async () => {},
  };
}

test('the native addenda teach the exact `target` form the belt emits for them', async () => {
  // Both addenda order the driver to COPY a node's `target` verbatim, so a target
  // in web syntax (`role=button[name="Save" i]`) means every click and type on
  // desktop/android dies in `find` — the addendum example and the emitted string
  // must be the same string.
  const node: Node = {
    role: 'button',
    name: 'Save',
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    enabled: true,
  };
  const res = await runObserve(
    nativeAdapter([node]),
    { saveScreenshot: async () => 'screenshots/001.png' },
    { kind: 'tree' },
  );
  if (res.kind !== 'tree') throw new Error('expected tree result');
  const target = res.nodes[0]?.target;
  expect(target).toBe('button "Save"');
  for (const [name, prompt] of Object.entries(NATIVE_PROMPTS)) {
    if (!prompt.includes(`\`${target}\``)) {
      throw new Error(`${name}: does not teach the emitted target \`${target}\``);
    }
  }
});

test('the native addenda declare tabs + switch_tab unsupported (the belt throws on both)', () => {
  for (const [name, prompt] of Object.entries(NATIVE_PROMPTS)) {
    const block = prompt.split('\n\n').find((part) => part.includes('kind:"tabs"'));
    if (block === undefined) throw new Error(`${name}: never mentions observe({kind:"tabs"})`);
    expect(block).toContain('switch_tab');
    expect(block).toContain('unsupported');
  }
});

test('the native addenda do not sell `observe({kind:"screenshot"})` as vision', () => {
  // `runObserve`'s screenshot branch returns `{path, bytes}` and never image bytes;
  // `look` is the only thing that judges pixels.
  for (const [name, prompt] of Object.entries(NATIVE_PROMPTS)) {
    const row = prompt.split('\n').find((line) => line.includes('kind:"screenshot"'));
    if (row === undefined) throw new Error(`${name}: never mentions the screenshot channel`);
    expect(row).toContain('path');
    expect(row).not.toContain('look');
    // …and `look` still has a row of its own.
    expect(prompt.split('\n').some((line) => line.includes('| `look` |'))).toBe(true);
  }
});

test('the base prompt\'s "act" belt line lists exactly ACT_ACTIONS, in order', () => {
  const match = debugAgentPrompt(false).match(/`act` — ([^.]+)\./);
  expect(match).not.toBeNull();
  const verbs = (match?.[1] ?? '').split(',').map((verb) => verb.trim());
  expect(verbs).toEqual([...ACT_ACTIONS]);
});
