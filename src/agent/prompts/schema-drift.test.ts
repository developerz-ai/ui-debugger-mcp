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
import { ACT_ACTIONS } from '../belt/act.js';
import { NODE_FIELDS, OBSERVE_KINDS } from '../belt/observe.js';
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

test('the base prompt\'s "act" belt line lists exactly ACT_ACTIONS, in order', () => {
  const match = debugAgentPrompt(false).match(/`act` — take action: ([^.]+)\./);
  expect(match).not.toBeNull();
  const verbs = (match?.[1] ?? '').split(',').map((verb) => verb.trim());
  expect(verbs).toEqual([...ACT_ACTIONS]);
});
