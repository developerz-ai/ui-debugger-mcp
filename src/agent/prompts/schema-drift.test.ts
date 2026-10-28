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
 * The terminal `report` example is the same kind of drift risk: it teaches the
 * driver the exact verdict object the `report` tool validates. A key the schema
 * does not have is STRIPPED by Zod — the call succeeds and the verdict lands
 * without the field the driver thought it reported. An enum value the schema
 * rejects fails the call at the worst possible moment — the run's last step.
 *
 * This test extracts every such example from the base prompt (both eye modes)
 * and all three target addenda, and asserts it names something
 * {@link ACT_ACTIONS} / {@link OBSERVE_KINDS} / {@link NODE_FIELDS} actually accepts.
 * The report example is read OUT of the prompt at test time — never copied here
 * — and checked against {@link ReportInputSchema} and the findings sub-schemas.
 */

import { expect, test } from 'bun:test';
import type { Adapter, Node } from '../../adapters/contract.js';
import { BugSchema, StepSchema, VisualIssueSchema } from '../../findings/schema.js';
import { ACT_ACTIONS } from '../belt/act.js';
import { NODE_FIELDS, OBSERVE_KINDS, runObserve } from '../belt/observe.js';
import { ReportInputSchema } from '../belt/report.js';
import { ANDROID_ADDENDUM_PROMPT } from './android-addendum.js';
import { debugAgentPrompt } from './debug-agent.js';
import { DESKTOP_ADDENDUM_PROMPT } from './desktop-addendum.js';
import { WEB_ADDENDUM_PROMPT } from './web-addendum.js';

/** The base prompt in both eye modes — the terminal `report` example lives here. */
const BASE_PROMPTS: Record<string, string> = {
  'debug-agent (vision mode)': debugAgentPrompt(false),
  'debug-agent (self-look mode)': debugAgentPrompt(true),
};

/** Every prompt string a driver session can be composed from, labelled for failure messages. */
const PROMPTS: Record<string, string> = {
  ...BASE_PROMPTS,
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

/** A minimal NATIVE-shaped adapter — it DECLARES the native dialect (and has no `tabs`). */
function nativeAdapter(nodes: Node[]): Adapter {
  return {
    selectorDialect: 'native',
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

// --- the terminal `report` example vs the report schemas --------------------

/** The heading the terminal `report` example lives under in the base prompt. */
const REPORT_SECTION = '## Terminal `report` call';

/** The top-level keys the report example must show — the guard reads each one. */
const REQUIRED_REPORT_KEYS = ['status', 'steps', 'bugs', 'visual'] as const;

/** A severity the findings schema does not accept — the drift the guard must catch. */
const OUT_OF_ENUM_SEVERITY = 'critical';

/**
 * The `"key": value` pairs of one example object.
 *
 * Values are kept as RAW TEXT: the example is pseudo-JSON — its enums are
 * unions (`"passed" | "failed"`) — so a value is read, never `JSON.parse`d. A
 * value ends at the comma that closes it, so one key's text never leaks into
 * the next key's candidates.
 */
type ExamplePairs = ReadonlyMap<string, string>;

/**
 * The offset just past the value that starts at `start`: the matching close
 * bracket of a `{…}`/`[…]` value, the next top-level comma of a scalar, or the
 * end of the text.
 */
function endOfValue(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth <= 0) return index;
    } else if (char === ',' && depth === 0) return index;
  }
  return text.length;
}

/** The `"key": value` pairs of one object body. */
function objectPairs(body: string): ExamplePairs {
  const pairs = new Map<string, string>();
  let rest = body;
  for (;;) {
    const match = /"((?:[^"\\]|\\.)*)"\s*:/.exec(rest);
    if (match === null) return pairs;
    const valueStart = match.index + match[0].length;
    const valueEnd = endOfValue(rest, valueStart);
    pairs.set(match[1] ?? '', rest.slice(valueStart, valueEnd).trim());
    rest = rest.slice(valueEnd);
  }
}

/** The body of the example's outer object — the text between its braces. */
function exampleBody(example: string): string {
  const start = example.indexOf('{');
  if (start < 0) throw new Error('the report example is not an object');
  return example.slice(start + 1, endOfValue(example, start));
}

/** The bodies of the objects an array value holds, at the array's own level. */
function arrayObjectBodies(value: string): readonly string[] {
  const bodies: string[] = [];
  let depth = 0;
  let start = -1;
  for (let index = 0; index < value.length; index += 1) {
    const char = value.charAt(index);
    if (char === '{') {
      depth += 1;
      if (depth === 1) start = index;
    } else if (char === '}') {
      if (depth === 1 && start >= 0) {
        bodies.push(value.slice(start + 1, index));
        start = -1;
      }
      depth -= 1;
    }
  }
  return bodies;
}

/** The quoted strings of a raw value — the enum candidates it teaches. */
function stringCandidates(value: string): readonly string[] {
  return [...value.matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');
}

/** The value of one key — a key the example never shows is drift, not a skip. */
function requiredValue(pairs: ExamplePairs, key: string): string {
  const value = pairs.get(key);
  if (value === undefined) {
    throw new Error(`the report example never shows "${key}"`);
  }
  return value;
}

/** Every key an example object teaches must be one the schema accepts. */
function assertExampleKeys(what: string, accepted: readonly string[], pairs: ExamplePairs): void {
  for (const key of pairs.keys()) {
    if (!accepted.includes(key)) {
      throw new Error(
        `the report example's ${what} teaches "${key}", which the schema does not accept`,
      );
    }
  }
}

/**
 * Every candidate the example teaches must be an accepted value — and every
 * accepted value must be taught: a half-taught enum is drift too (a driver that
 * never hears "failed" reports a pass it did not earn).
 */
function assertExampleEnum(what: string, accepted: readonly string[], value: string): void {
  const candidates = stringCandidates(value);
  for (const candidate of candidates) {
    if (!accepted.includes(candidate)) {
      throw new Error(
        `the report example teaches "${candidate}" as ${what}, which the schema does not accept`,
      );
    }
  }
  for (const option of accepted) {
    if (!candidates.includes(option)) {
      throw new Error(`the report example never teaches "${option}" as ${what}`);
    }
  }
}

/**
 * Pull the fenced ```json report example out of a prompt.
 *
 * Throws when the section or the fence is missing: a guard that cannot find
 * the example must never pass silently.
 */
function extractReportExample(prompt: string): string {
  const section = prompt.split(REPORT_SECTION)[1];
  if (section === undefined) {
    throw new Error(`the prompt has no "${REPORT_SECTION}" section`);
  }
  const fenced = section.match(/```json\r?\n([\s\S]*?)```/);
  const body = fenced?.[1];
  if (body === undefined) {
    throw new Error(`the "${REPORT_SECTION}" section has no fenced json example`);
  }
  return body;
}

/**
 * Assert the report example teaches exactly what the `report` schemas accept.
 *
 * Throws on any drift: a key the schema does not have, a key the example never
 * shows, a value outside a field's enum, or an enum value the example never
 * teaches. The example text is a PARAMETER — the caller reads it out of the
 * prompt — so a test can feed this a mutated copy.
 */
function assertReportExampleMatchesSchemas(example: string): void {
  const top = objectPairs(exampleBody(example));
  const reportKeys = Object.keys(ReportInputSchema.shape);

  for (const key of top.keys()) {
    if (!reportKeys.includes(key)) {
      throw new Error(
        `the report example teaches "${key}", which the report schema does not accept`,
      );
    }
  }

  for (const key of REQUIRED_REPORT_KEYS) {
    requiredValue(top, key);
    if (!reportKeys.includes(key)) {
      throw new Error(`the report schema has no "${key}" field`);
    }
  }

  assertExampleEnum(
    'a status',
    ReportInputSchema.shape.status.options,
    requiredValue(top, 'status'),
  );

  const stepKeys = Object.keys(StepSchema.shape);
  for (const body of arrayObjectBodies(requiredValue(top, 'steps'))) {
    assertExampleKeys('a step', stepKeys, objectPairs(body));
  }

  const bugKeys = Object.keys(BugSchema.shape);
  const bugKinds = BugSchema.shape.kind.options;
  for (const body of arrayObjectBodies(requiredValue(top, 'bugs'))) {
    const bug = objectPairs(body);
    assertExampleKeys('a bug', bugKeys, bug);
    assertExampleEnum('a bug kind', bugKinds, requiredValue(bug, 'kind'));
  }

  const visualKeys = Object.keys(VisualIssueSchema.shape);
  const severities = VisualIssueSchema.shape.severity.options;
  for (const body of arrayObjectBodies(requiredValue(top, 'visual'))) {
    const visual = objectPairs(body);
    assertExampleKeys('a visual issue', visualKeys, visual);
    assertExampleEnum('a visual severity', severities, requiredValue(visual, 'severity'));
  }
}

test("the base prompt's report example teaches exactly what the report schemas accept", () => {
  for (const [name, prompt] of Object.entries(BASE_PROMPTS)) {
    try {
      assertReportExampleMatchesSchemas(extractReportExample(prompt));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${name}: ${reason}`);
    }
  }
});

test('the report-example guard rejects an unknown key and an out-of-enum severity', () => {
  const example = extractReportExample(debugAgentPrompt(false));

  // The real example passes…
  expect(() => assertReportExampleMatchesSchemas(example)).not.toThrow();

  // …a key the report schema does not have…
  const unknownKey = example.replace(/^\{/, '{ "notAReportKey": "x",');
  expect(unknownKey).not.toBe(example);
  expect(() => assertReportExampleMatchesSchemas(unknownKey)).toThrow(
    /the report example teaches "notAReportKey"/,
  );

  // …a key a NESTED finding does not have…
  const unknownBugKey = example.replace(/"kind":/, '"notABugKey": "x", "kind":');
  expect(unknownBugKey).not.toBe(example);
  expect(() => assertReportExampleMatchesSchemas(unknownBugKey)).toThrow(
    /a bug teaches "notABugKey"/,
  );

  // …and a severity outside the findings enum.
  const severities = [...VisualIssueSchema.shape.severity.options];
  const mutated = severities.map((option, index) =>
    index === severities.length - 1 ? OUT_OF_ENUM_SEVERITY : option,
  );
  const badSeverity = example.replace(
    /"severity":\s*"[^"]*"(?:\s*\|\s*"[^"]*")+/,
    `"severity": ${mutated.map((option) => `"${option}"`).join('|')}`,
  );
  expect(badSeverity).not.toBe(example);
  expect(() => assertReportExampleMatchesSchemas(badSeverity)).toThrow(
    new RegExp(OUT_OF_ENUM_SEVERITY),
  );
});

test('the report-example guard rejects an enum value the example never teaches', () => {
  const example = extractReportExample(debugAgentPrompt(false));

  // A half-taught enum is drift too: drop "flow" and the driver never hears
  // the one bug kind only it can report.
  const halfTaught = example.replace(
    /"kind":\s*"console"\|"network"\|"flow"/,
    '"kind": "console"|"network"',
  );
  expect(halfTaught).not.toBe(example);
  expect(() => assertReportExampleMatchesSchemas(halfTaught)).toThrow(/never teaches "flow"/);
});

test('the report-example guard fails loud when the example cannot be read', () => {
  expect(() => extractReportExample('a prompt with no report section')).toThrow();
  expect(() => extractReportExample(`${REPORT_SECTION}\n\nno fenced example`)).toThrow();
  expect(() => assertReportExampleMatchesSchemas('not an example')).toThrow();

  const example = extractReportExample(debugAgentPrompt(false));
  const noSteps = example.replace(/"steps":\s*\[[^\]]*\],/, '');
  expect(noSteps).not.toBe(example);
  expect(() => assertReportExampleMatchesSchemas(noSteps)).toThrow(/never shows "steps"/);
});
