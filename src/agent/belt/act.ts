/**
 * `act` — the driver's write tool (inner belt).
 *
 * One verb, six intents, picked by a `z.discriminatedUnion('action', …)`. Each
 * routes through the shared {@link Adapter} contract so the loop stays
 * adapter-blind — the same `act({ action: 'click', target })` drives web (CDP),
 * desktop (X11/Wayland) or android (ADB):
 *   - `click`    → `find` + `click`   (resolve the node, then click it)
 *   - `type`     → `find` + `type`    (resolve the field, then type into it)
 *   - `navigate` → `open`             (go to a URL / window / activity)
 *   - `wait`     → `waitFor`          (block on a node / network idle / timeout)
 *   - `key` · `scroll` — declared so the driver's API is stable, but the contract
 *     has no key-press / scroll verb yet; they fail loud until one lands.
 *
 * Click/type resolve their target through `find` FIRST (not the selector overload
 * baked into `click`/`type`) for two reasons: fail loud with a clear "no element
 * matched" when the node is missing, and derive the step **label from the target**
 * (its role + accessible name) for the evidence trail.
 *
 * After the action it records one step: a line to `logs/agent.log` plus an ordered
 * post-action frame to `screenshots/` (the replay video). Recording is not
 * best-effort — a failed capture surfaces, never a silent fallback.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Adapter, Node } from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';
import type { LogChannel } from '../../session/findings-store.js';

/** Click a resolved node. */
const ClickAction = z.object({
  action: z.literal('click'),
  target: z
    .string()
    .describe(
      'selector to click: CSS/role/text (web), a11y role+name (desktop), id/text (android)',
    ),
});

/** Type text into a resolved field. */
const TypeAction = z.object({
  action: z.literal('type'),
  target: z.string().describe('selector for the field to type into'),
  text: z.string().describe('the text to type into the field'),
});

/** Press a key or chord (reserved — no contract verb yet). */
const KeyAction = z.object({
  action: z.literal('key'),
  key: z.string().describe('key or chord to press, e.g. Enter | Tab | Escape | Control+A'),
  target: z
    .string()
    .optional()
    .describe('selector to focus before the keypress (omit for the active element)'),
});

/** Scroll a region or the viewport (reserved — no contract verb yet). */
const ScrollAction = z.object({
  action: z.literal('scroll'),
  direction: z.enum(['up', 'down', 'left', 'right']).describe('scroll direction'),
  target: z.string().optional().describe('selector to scroll within (omit for the viewport)'),
  amount: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('pixels to scroll (adapter default if omitted)'),
});

/** Go to a URL / window / activity. */
const NavigateAction = z.object({
  action: z.literal('navigate'),
  target: z.string().describe('where to go: URL (web), window (desktop), activity (android)'),
});

/** Block until a node appears / network settles / timeout. */
const WaitAction = z.object({
  action: z.literal('wait'),
  target: z.string().optional().describe('wait until a node matching this selector appears'),
  networkIdle: z.boolean().optional().describe('wait until in-flight requests settle (web)'),
  timeout: z.number().int().positive().optional().describe('hard cap in ms; throws on expiry'),
});

/** `act` input — a discriminated union on `action`; the agent picks one intent per call. */
export const ActInputSchema = z.discriminatedUnion('action', [
  ClickAction,
  TypeAction,
  KeyAction,
  ScrollAction,
  NavigateAction,
  WaitAction,
]);

export type ActInput = z.infer<typeof ActInputSchema>;

/** Structured `act` result — confirms the intent and points at the evidence frame. */
export interface ActResult {
  /** The action performed (mirrors the input discriminant). */
  action: ActInput['action'];
  /** Target-derived step label, e.g. `click button "Save"`. */
  label: string;
  /** Path to the post-action screenshot saved as evidence. */
  screenshot: string;
}

/**
 * The slice of the findings store `act` records through. {@link FindingsStore}
 * satisfies it structurally, so the real store drops in; tests pass a fake.
 */
export interface StepRecorder {
  /** Append a line to `logs/<channel>.log`. */
  appendLog(channel: LogChannel, line: string): Promise<string>;
  /** Save a PNG frame as `screenshots/NNN-<label>.png`. */
  saveScreenshot(label: string, data: Uint8Array): Promise<string>;
}

/** Resolve a selector to a node via `find`, failing loud when nothing matches. */
async function resolve(adapter: Adapter, target: string): Promise<Node> {
  const node = await adapter.find({ query: target });
  if (!node) throw new AgentError(`act: no element matched ${JSON.stringify(target)}`);
  return node;
}

/** Target-derived label for a resolved node — `role "name"`, or just `role` when unnamed. */
function describeNode(node: Node): string {
  const name = node.name.trim();
  return name ? `${node.role} ${JSON.stringify(name)}` : node.role;
}

/** Describe what a `wait` is blocking on, for the step label. */
function describeWait(query?: string, networkIdle?: boolean, timeout?: number): string {
  const parts = [
    query ? JSON.stringify(query) : undefined,
    networkIdle ? 'network idle' : undefined,
    timeout ? `${timeout}ms` : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' + ') : 'next frame';
}

/** Perform one action against the contract and return its target-derived step label. */
async function performAct(adapter: Adapter, input: ActInput): Promise<string> {
  switch (input.action) {
    case 'click': {
      const node = await resolve(adapter, input.target);
      await adapter.click(node);
      return `click ${describeNode(node)}`;
    }
    case 'type': {
      const node = await resolve(adapter, input.target);
      await adapter.type(node, input.text);
      return `type ${input.text.length} chars into ${describeNode(node)}`;
    }
    case 'navigate': {
      await adapter.open(input.target);
      return `navigate to ${input.target}`;
    }
    case 'wait': {
      await adapter.waitFor({
        query: input.target,
        networkIdle: input.networkIdle,
        timeout: input.timeout,
      });
      return `wait for ${describeWait(input.target, input.networkIdle, input.timeout)}`;
    }
    case 'key':
      throw new AgentError(
        "act 'key' is not supported yet: the adapter contract has no key-press verb",
      );
    case 'scroll':
      throw new AgentError(
        "act 'scroll' is not supported yet: the adapter contract has no scroll verb",
      );
    default: {
      const unreachable: never = input;
      throw new AgentError(`unknown act action: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Route one `act` call through the {@link Adapter}, then record the step. Pure
 * over the contract + {@link StepRecorder} seams, so it unit-tests against fakes.
 */
export async function runAct(
  adapter: Adapter,
  recorder: StepRecorder,
  input: ActInput,
): Promise<ActResult> {
  const label = await performAct(adapter, input);
  const png = await adapter.screenshot();
  const screenshot = await recorder.saveScreenshot(label, png);
  await recorder.appendLog('agent', `act ${label} → ${screenshot}`);
  return { action: input.action, label, screenshot };
}

/** Build the `act` tool bound to one adapter + recorder, for the debug agent's belt. */
export function createActTool(adapter: Adapter, recorder: StepRecorder) {
  return tool({
    description:
      'Drive the target with one action, chosen by action: click | type | key | scroll | navigate | wait. Resolves target via find, then routes to the adapter (click/type/open/waitFor) and records a step to agent.log plus a post-action screenshot. Use observe to read state before and after.',
    inputSchema: ActInputSchema,
    execute: (input) => runAct(adapter, recorder, input),
  });
}
