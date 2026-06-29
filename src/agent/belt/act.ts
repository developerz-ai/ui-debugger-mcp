/**
 * `act` — the driver's write tool (inner belt).
 *
 * One verb, six intents, picked by an `action` enum on a flat input object (a
 * discriminated union renders as a JSON-Schema `anyOf` that some tool-calling
 * models can't fill — see {@link ActInputSchema}). Each intent routes through the
 * shared {@link Adapter} contract so the loop stays
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

/** The six action verbs `act` routes to the shared contract. */
export const ACT_ACTIONS = ['click', 'type', 'key', 'scroll', 'navigate', 'wait'] as const;

/**
 * `act` input — ONE flat object the driver fills per call: `action` picks the
 * verb, the rest are its (optional) operands, validated per-action in
 * {@link performAct}.
 *
 * Flat on purpose. A `z.discriminatedUnion('action', …)` renders as a JSON-Schema
 * `anyOf`, which several tool-calling models — including our default driver
 * (glm) — fail to populate: they emit the call with empty `{}` args and the run
 * churns without ever acting. A single flat object with an enum discriminant is
 * filled reliably, at the cost of moving "click needs a target", "type needs
 * text" out of the schema and into a loud runtime check.
 */
export const ActInputSchema = z.object({
  action: z.enum(ACT_ACTIONS).describe('what to do: click | type | key | scroll | navigate | wait'),
  target: z
    .string()
    .optional()
    .describe(
      'what to act on — CSS, role+name (button "Save"), or visible text (web); navigate: URL/window/activity; wait: selector to await',
    ),
  text: z.string().optional().describe('text to type (action=type)'),
  key: z
    .string()
    .optional()
    .describe('key or chord to press (action=key), e.g. Enter | Tab | Escape | Control+A'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('scroll direction (action=scroll)'),
  amount: z.number().int().positive().optional().describe('pixels to scroll (action=scroll)'),
  networkIdle: z
    .boolean()
    .optional()
    .describe('wait until in-flight requests settle (action=wait, web)'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('hard cap in ms; throws on expiry (action=wait)'),
});

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

/** Require an operand the flat schema can't enforce per-action; fail loud when omitted. */
function required(value: string | undefined, field: string, action: string): string {
  if (value === undefined || value === '') {
    throw new AgentError(`act '${action}' requires '${field}'`);
  }
  return value;
}

/** Perform one action against the contract and return its target-derived step label. */
async function performAct(adapter: Adapter, input: ActInput): Promise<string> {
  switch (input.action) {
    case 'click': {
      const node = await resolve(adapter, required(input.target, 'target', 'click'));
      await adapter.click(node);
      return `click ${describeNode(node)}`;
    }
    case 'type': {
      // Validate `text` before resolving the target: a stale selector must not mask
      // the real `requires 'text'` failure, nor cost an unnecessary `find()`.
      const text = required(input.text, 'text', 'type');
      const node = await resolve(adapter, required(input.target, 'target', 'type'));
      await adapter.type(node, text);
      return `type ${text.length} chars into ${describeNode(node)}`;
    }
    case 'navigate': {
      const target = required(input.target, 'target', 'navigate');
      await adapter.open(target);
      return `navigate to ${target}`;
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
      const unreachable: never = input.action;
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
