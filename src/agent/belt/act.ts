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
 *   - `wait`     → `waitFor`          (block on a node and/or network idle, capped by timeout)
 *   - `key`      → `pressKey`         (press a key / chord on the focused element)
 *   - `scroll`   → `scroll`           (wheel the viewport, or a `target`-scoped region)
 *
 * Click/type resolve their target through `find` FIRST (not the selector overload
 * baked into `click`/`type`) for two reasons: fail loud with a clear "no element
 * matched" when the node is missing, and derive the step **label from the target**
 * (its role + accessible name) for the evidence trail.
 *
 * After the action it records one step: a line to `logs/agent.log` plus an ordered
 * post-action frame to `screenshots/` (the replay video). Recording is not
 * best-effort — a failed capture surfaces, never a silent fallback. Every finished
 * step lands on the run's {@link ActTrail} at act time, `ok: true` with its frame
 * or `ok: false` with the error (then rethrown, so the driver still sees it) — the
 * trail tells the truth about what worked AND what did not.
 */

import { tool } from 'ai';
import { z } from 'zod';
import type { Adapter, Node, TabInfo } from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';
import type { LogChannel } from '../../session/findings-store.js';
import type { ActTrail } from './trail.js';

/** The action verbs `act` routes to the shared contract. */
export const ACT_ACTIONS = [
  'click',
  'type',
  'key',
  'scroll',
  'navigate',
  'wait',
  'switch_tab',
] as const;

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
  action: z
    .enum(ACT_ACTIONS)
    .describe('what to do: click | type | key | scroll | navigate | wait | switch_tab'),
  target: z
    .string()
    .optional()
    .describe(
      'what to act on — CSS, role+name (button "Save"), or visible text (web); navigate: URL/window/activity; wait: selector to await (required unless networkIdle); scroll: region to scroll within (optional); switch_tab: tab index from observe({kind:"tabs"})',
    ),
  text: z.string().optional().describe('text to type (action=type)'),
  clear: z
    .boolean()
    .optional()
    .describe('replace the field contents instead of appending to them (action=type)'),
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
    .describe('wait until in-flight requests settle (action=wait, web); needed if no target'),
  timeout: z
    .number()
    .int()
    .positive()
    .max(60_000)
    .optional()
    .describe(
      'hard cap in ms, at most 60000 (60s — teardown must never hang); throws on expiry (action=wait)',
    ),
});

export type ActInput = z.infer<typeof ActInputSchema>;

/** Structured `act` result — confirms the intent and points at the evidence frame. */
export interface ActResult {
  /** The action performed (mirrors the input discriminant). */
  action: ActInput['action'];
  /** Target-derived step label, e.g. `click button "Save"`. */
  label: string;
  /**
   * Whether the step worked — always `true` here, since a failed act throws (and
   * reaches the trail as `ok: false`). Told to the driver so it never has to
   * guess whether an act landed.
   */
  ok: true;
  /** Path to the post-action screenshot saved as evidence. */
  screenshot: string;
  /**
   * Every open tab — present ONLY once more than one is open.
   *
   * A click that opens a tab (`target="_blank"`, an OAuth popup) leaves a blind
   * driver reading the tab it is still on, concluding "nothing happened", and
   * abandoning the flow. Surfacing the tab list exactly when it becomes relevant
   * turns that dead end into an obvious next step (`act switch_tab`), and costs
   * nothing on the single-tab pages that are the norm.
   */
  tabs?: TabInfo[];
  /**
   * URLs of full-document loads this act caused without being asked to — present
   * ONLY when there were any.
   *
   * A new document resets the page: typed fields are empty, a cart counter is
   * back to zero, a session may be gone. Nothing on screen distinguishes that
   * from "my click did nothing", so a driver that cannot see it reports the
   * reload-causing action as a success and then reasons about a page it has
   * never observed. Measured on `dummy/web`: a Subscribe click reloaded the
   * document and the run's summary called the newsletter working (#60).
   *
   * A navigation the driver ASKED for never lands here — {@link Adapter.open}
   * drains its own load, so this is only ever the surprise.
   */
  navigated?: string[];
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

/**
 * Describe what a `wait` is blocking on, for the step label. Never empty — the belt
 * rejects a `wait` with no condition before it gets here.
 */
function describeWait(query?: string, networkIdle?: boolean, timeout?: number): string {
  return [
    query ? JSON.stringify(query) : undefined,
    networkIdle ? 'network idle' : undefined,
    timeout ? `${timeout}ms` : undefined,
  ]
    .filter((part): part is string => part !== undefined)
    .join(' + ');
}

/**
 * Require an operand the flat schema can't enforce per-action; fail loud when
 * omitted. Generic over `T extends string` so it preserves narrow unions (e.g.
 * `scroll`'s `direction` enum) instead of widening them back to `string`.
 */
function required<T extends string>(value: T | undefined, field: string, action: string): T {
  if (value === undefined || value === '') {
    throw new AgentError(`act '${action}' requires '${field}'`);
  }
  return value;
}

/**
 * The tab index `switch_tab` names. `target` is a string for every other verb, so
 * the index arrives as one — reject anything that is not a whole, non-negative
 * number rather than silently driving tab 0.
 */
function tabIndex(target: string): number {
  const index = Number(target.trim());
  if (!Number.isInteger(index) || index < 0) {
    throw new AgentError(
      `act 'switch_tab' needs a tab index as 'target' (e.g. "1"), got ${JSON.stringify(target)} — list them with observe({kind:"tabs"})`,
    );
  }
  return index;
}

/**
 * Label an act from its INPUT — the fallback for a step that threw before a
 * target-derived label existed. Never echoes `text` (typed secrets stay out of
 * the trail, as they do out of the success label).
 */
function describeAttempt(input: ActInput): string {
  const operand =
    input.action === 'key' ? input.key : input.action === 'scroll' ? input.direction : input.target;
  return operand ? `${input.action} ${operand}` : input.action;
}

/** One-line error text for a failed step's `note`. */
function failureNote(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Perform one action against the contract and return its target-derived step label. */
/**
 * Refuse a `navigate` that leaves the app under test.
 *
 * Observed end-to-end: driven at the local fixture with the goal "debug the Nimbus
 * Store home page", the driver's FIRST action was
 * `navigate → https://nimbus-store.vercel.app` — a public site it inferred from the
 * goal text. It never returned, and the run ended with six confident, fully-evidenced
 * bugs about a stranger's production app, with nothing in the output hinting the
 * target had been left. The smart agent would have gone hunting for a CORS bug that
 * does not exist in its repo.
 *
 * `origin` is the run's own origin (web only; empty for desktop/android, whose
 * `navigate` means a window title or an app package). Same-origin URLs and relative
 * paths pass; anything else fails loud, naming where the driver is supposed to be.
 * A run that wanders off the app under test is worse than a run that stops.
 */
function assertSameOrigin(target: string, origin: string | undefined): void {
  if (!origin) return; // non-web target, or no origin to enforce
  let destination: URL;
  try {
    destination = new URL(target, origin); // relative paths resolve against the app
  } catch {
    return; // not URL-shaped — let the adapter reject it with its own message
  }
  if (destination.origin === origin) return;
  throw new AgentError(
    `act 'navigate' refused: '${target}' leaves the app under test (${origin}). ` +
      'Findings about another site cannot be acted on. Use a path or a URL on ' +
      `${origin}; if the app genuinely lives elsewhere, the smart agent must pass that url to start_debug.`,
  );
}

async function performAct(adapter: Adapter, input: ActInput, origin?: string): Promise<string> {
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
      if (input.clear === true) {
        // `type` appends by design (it focuses and types, it does not `fill`), so
        // re-typing a field silently produced doubled values like
        // "Finish project reportFinish project report" — which the driver then
        // reported as an app bug.
        //
        // Empty the field FIRST, then type: select-all-then-type would not work,
        // because every `type` focuses its target by clicking, and that click
        // collapses the selection it was meant to overwrite. Deleting instead
        // leaves an empty field, where the re-click's caret position is moot.
        // Built from existing contract verbs, so desktop and android get it too.
        await adapter.type(node, '');
        await adapter.pressKey('Control+a');
        await adapter.pressKey('Delete');
        await adapter.type(node, text);
        return `type ${text.length} chars into ${describeNode(node)} (replacing)`;
      }
      await adapter.type(node, text);
      return `type ${text.length} chars into ${describeNode(node)}`;
    }
    case 'navigate': {
      const target = required(input.target, 'target', 'navigate');
      assertSameOrigin(target, origin);
      await adapter.open(target);
      return `navigate to ${target}`;
    }
    case 'wait': {
      // Every adapter needs something to block on — a bare `wait` can only throw
      // (`waitFor requires query and/or networkIdle`). Reject it HERE so the driver
      // gets a steering message from its own tool, and the dead step lands on the
      // trail, instead of an adapter error it has to decode. A `timeout` alone is a
      // sleep, which the loop has no use for.
      if (!input.target && input.networkIdle !== true) {
        throw new AgentError(
          "act 'wait' requires 'target' (a selector to wait for) and/or 'networkIdle': true",
        );
      }
      await adapter.waitFor({
        query: input.target,
        networkIdle: input.networkIdle,
        timeout: input.timeout,
      });
      return `wait for ${describeWait(input.target, input.networkIdle, input.timeout)}`;
    }
    case 'key': {
      const key = required(input.key, 'key', 'key');
      await adapter.pressKey(key);
      return `key ${key}`;
    }
    case 'scroll': {
      const direction = required(input.direction, 'direction', 'scroll');
      await adapter.scroll({ direction, amount: input.amount, within: input.target });
      return `scroll ${direction}${input.amount !== undefined ? ` ${input.amount}px` : ''}`;
    }
    case 'switch_tab': {
      if (!adapter.selectTab) {
        throw new AgentError("act 'switch_tab' is not supported on this target (web only)");
      }
      const index = tabIndex(required(input.target, 'target', 'switch_tab'));
      await adapter.selectTab(index);
      return `switch to tab ${index}`;
    }
    default: {
      const unreachable: never = input.action;
      throw new AgentError(`unknown act action: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Route one `act` call through the {@link Adapter}, then record the step. Pure
 * over the contract + {@link StepRecorder} seams, so it unit-tests against fakes.
 *
 * The step lands on `trail` the moment it finishes — announced through
 * {@link ActTrail.begin} first, so a `report` racing in the SAME step waits for it
 * instead of writing a verdict that never mentions this act. Anything that throws
 * — a missing operand, an unresolved target, a dead adapter, a failed capture — is
 * recorded as an `ok: false` entry and then RETHROWN: the driver still sees the
 * error (and can retry), while the evidence trail keeps the step that did not work
 * instead of silently dropping it.
 */
export async function runAct(
  adapter: Adapter,
  recorder: StepRecorder,
  input: ActInput,
  trail?: ActTrail,
  entered?: () => void,
  origin?: string,
): Promise<ActResult> {
  // Enter the gate BEFORE the first await, so a same-step terminal read sees this
  // act in flight rather than an empty trail. `entered` is the release of a
  // `begin()` the CALLER already made — `createActTool` enters the gate when the
  // act is queued, which is earlier than this and is what makes a queued-but-not-
  // yet-started act visible to the barrier.
  const settle = entered ?? trail?.begin();
  // Label the attempt from the input up front: a throw inside `performAct` yields
  // no target-derived label, and an unlabelled failed step is not evidence.
  let label = describeAttempt(input);
  try {
    label = await performAct(adapter, input, origin);
    const png = await adapter.screenshot();
    const screenshot = await recorder.saveScreenshot(label, png);
    const navigated = await takeLoads(adapter);
    await recorder.appendLog('agent', `act ${label} → ${screenshot}`);
    trail?.record({
      step: label,
      ok: true,
      screenshot,
      ...(navigated.length > 0 ? { note: reloadNote(navigated) } : {}),
    });
    return {
      action: input.action,
      label,
      ok: true,
      screenshot,
      ...(navigated.length > 0 ? { navigated } : {}),
      ...(await extraTabs(adapter)),
    };
  } catch (error) {
    // Drain on the failure path too. The queue is cumulative, so a load left
    // behind by a failed act would be reported by the NEXT one — pinning the
    // reload on an action that did not cause it.
    await takeLoads(adapter);
    trail?.record({ step: label, ok: false, note: failureNote(error) });
    throw error;
  } finally {
    // After the record on BOTH paths — a waiter released early would read a trail
    // that is missing the very step it waited for.
    settle?.();
  }
}

/**
 * The full-document loads this act caused without being asked to, draining the
 * adapter's queue — see {@link ActResult.navigated}. Never fails an otherwise-good
 * act: a target with no document concept, or one that throws mid-teardown, reports
 * none. Called on the failure path too, so nothing bleeds into the next step.
 */
async function takeLoads(adapter: Adapter): Promise<string[]> {
  if (!adapter.takeUnrequestedLoads) return [];
  try {
    return await adapter.takeUnrequestedLoads();
  } catch {
    return [];
  }
}

/**
 * What the step trail says about a reload. Names the destination and the
 * consequence — the driver's next read is against a page it has not seen, and
 * anything it had typed, added or signed into is gone.
 */
function reloadNote(urls: string[]): string {
  return `the page loaded a new document (${urls.join(', ')}) — in-page state was lost, re-read the page before trusting anything observed before this step`;
}

/**
 * The open tabs, but only when there is more than one to report — see
 * {@link ActResult.tabs}. Never fails an otherwise-good act: a target that
 * cannot list tabs, or one that throws mid-teardown, simply reports none.
 */
async function extraTabs(adapter: Adapter): Promise<{ tabs?: TabInfo[] }> {
  if (!adapter.tabs) return {};
  try {
    const tabs = await adapter.tabs();
    return tabs.length > 1 ? { tabs } : {};
  } catch {
    return {};
  }
}

/**
 * Build the `act` tool bound to one adapter + recorder, for the debug agent's belt.
 * `trail` (when wired by the loop) is the run's shared step trail, so every act —
 * the ones that worked and the ones that threw — lands in the persisted findings.
 * `origin` is the app under test's origin (web only); see {@link assertSameOrigin}.
 */
export function createActTool(
  adapter: Adapter,
  recorder: StepRecorder,
  trail?: ActTrail,
  origin?: string,
) {
  /**
   * Acts run ONE AT A TIME, however many the driver emits in a step.
   *
   * A model routinely batches independent-looking actions into a single step —
   * `type` the email and `type` the password — and the SDK executes a step's tool
   * calls concurrently. But an act is compound (focus the target, then type into
   * it) and keyboard input is dispatched at the PAGE, not at an element: two acts
   * in flight interleave their keystrokes into whichever field last took focus.
   *
   * Observed end-to-end: a registration typed
   * `tTeessttuPsaesrs1TestPass123!…` into the password field and the app happily
   * created the account. Nothing errored — the run just silently tested something
   * other than what it typed, which is the worst failure mode a debugger can have.
   *
   * Chaining here rather than locking the adapter: the atomic unit is the whole
   * act, not any single contract call it makes.
   */
  let queue: Promise<unknown> = Promise.resolve();

  return tool({
    description:
      'Drive the target with one action, chosen by action: click | type | key | scroll | navigate | wait | switch_tab. Resolves target via find, then routes to the adapter (click/type/open/waitFor) and records a step to agent.log plus a post-action screenshot. Returns tabs when more than one is open — a click may have opened one. Returns navigated when the action reloaded the document without being asked to (a form that submits without preventDefault, a plain link, an expired session): the page was replaced and every bit of in-page state is gone, so re-read before concluding anything — and treat a submit that only reloads as a bug, not a success. Use observe to read state before and after.',
    inputSchema: ActInputSchema,
    execute: (input) => {
      // Enter the trail's gate NOW, not when this act's turn on the queue comes up.
      // `runAct` releases the gate in its `finally`, which is scheduled BEFORE the
      // queue continuation that starts the next act — so a `report` racing in the
      // same step saw an idle gate between two queued acts and wrote a verdict
      // missing every act but the first (and the loop then stops, so that act
      // reaches no persisted file at all).
      const entered = trail?.begin();
      const next = queue.then(() => runAct(adapter, recorder, input, trail, entered, origin));
      // The chain must survive a failed act: swallow the rejection on the QUEUE
      // copy only, so a thrown act still reaches the driver via `next`.
      queue = next.catch(() => undefined);
      return next;
    },
  });
}
