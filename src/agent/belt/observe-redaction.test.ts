/**
 * Belt observe redaction: a configured persona's values must never reach the
 * driver's model, in a RESULT or in a thrown tool error. All values here are
 * SYNTHETIC; no target, browser or credential is involved.
 */

import { expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import type {
  Adapter,
  ConsoleEntry,
  LogQuery,
  NetworkEntry,
  Node,
  Query,
  SelectorDialect,
  TabInfo,
} from '../../adapters/contract.js';
import { UiDebuggerError } from '../../errors.js';
import { createSecretRedactor } from '../../redact.js';
import type { EvidenceRecorder } from './look.js';
import { createObserveTool, runObserve } from './observe.js';
import { withRedactedErrors } from './redact-output.js';
import { resolveTargetRef } from './target-refs.js';

// One short value (survives percent/JSON escapes) and one with characters that
// change spelling on the wire (space, slash, @). Neither is a live credential.
const SECRETS = ['hunter2', 'a b/c@dev.local'];
const redact = createSecretRedactor(SECRETS);

function noSecret(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
    expect(text).not.toContain(secret.replaceAll(' ', '+'));
    expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
  }
}

/** The SDK passes toolCallId/messages/context on every execute call. */
const OPTIONS = { toolCallId: 't1', messages: [], context: {} };

type Execute = (input: unknown, options: unknown) => unknown;

/**
 * AI SDK `Tool.execute` is typed as a union that also admits async iterables.
 * These fakes always return a plain value, so narrow at the test boundary.
 */
function executor(toolValue: { execute?: unknown }): Execute {
  if (typeof toolValue.execute !== 'function') throw new Error('expected tool.execute');
  return toolValue.execute as Execute;
}

async function caught(fn: Execute, input: unknown, options: unknown): Promise<unknown> {
  try {
    await fn(input, options);
  } catch (error) {
    return error;
  }
  throw new Error('expected execute to throw');
}

/** Build a tool whose execute delegates to the real observe tool's execute. */
function wrappedObserve(values: Parameters<typeof fakeAdapter>[0]) {
  const fixture = fakeAdapter(values);
  return withRedactedErrors(
    tool({
      inputSchema: z.object({ kind: z.string() }),
      execute: async (input) =>
        executor(createObserveTool(fixture.adapter, recorder, undefined, redact))(input, OPTIONS),
    }),
    redact,
  );
}

const secret = (i: number): string => SECRETS[i] ?? '';

const recorder: EvidenceRecorder = {
  saveScreenshot: async () => 'screenshots/000-fake.png',
};

interface Fixture {
  adapter: Adapter;
  lastQuery?: Query;
  found?: boolean;
}

function fakeAdapter(
  values: {
    nodes?: Node[];
    console?: ConsoleEntry[];
    network?: NetworkEntry[];
    tabs?: TabInfo[];
    fail?: (kind: string) => Error;
  },
  dialect: SelectorDialect = 'web',
): Fixture {
  const fixture: Fixture = { adapter: { selectorDialect: dialect } as Adapter };
  const fail = (kind: string): void => {
    const error = values.fail?.(kind);
    if (error) throw error;
  };
  fixture.adapter.open = async () => {};
  fixture.adapter.close = async () => {};
  fixture.adapter.find = async () => {
    fixture.found = true;
    return null;
  };
  fixture.adapter.click = async () => {};
  fixture.adapter.type = async () => {};
  fixture.adapter.pressKey = async () => {};
  fixture.adapter.scroll = async () => {};
  fixture.adapter.waitFor = async () => {};
  fixture.adapter.screenshot = async () => new Uint8Array();
  fixture.adapter.readState = async (opts: Query = {}) => {
    fixture.lastQuery = opts;
    fail('tree');
    return values.nodes ?? [];
  };
  fixture.adapter.console = async (_opts: LogQuery = {}) => {
    fail('console');
    return values.console ?? [];
  };
  fixture.adapter.network = async (_opts: LogQuery = {}) => {
    fail('network');
    return values.network ?? [];
  };
  if (values.tabs) fixture.adapter.tabs = async () => values.tabs ?? [];
  return fixture;
}

const node = (suffix: string): Node => ({
  role: 'textbox',
  name: `value ${suffix}`,
  bounds: { x: 0, y: 0, width: 1, height: 1 },
  enabled: true,
});

test('runObserve masks raw and encoded values in network requestBody/responseBody/headers/url/error', async () => {
  const entry: NetworkEntry = {
    method: 'POST',
    url: `https://dev.local/login?next=${encodeURIComponent(secret(0))}&email=${encodeURIComponent(secret(1))}`,
    status: 401,
    ok: false,
    requestBody: JSON.stringify({ password: secret(0), email: secret(1) }),
    responseBody: `invalid password ${secret(0)} for ${secret(1)}`,
    requestHeaders: {
      authorization: `Bearer ${secret(0)}`,
      'x-email': encodeURIComponent(secret(1)),
    },
    responseHeaders: { 'x-user': JSON.stringify(secret(1)).slice(1, -1) },
    error: `401 at /${secret(0)}`,
    timestamp: 1,
  };
  const { adapter } = fakeAdapter({ network: [entry] });
  const result = await runObserve(adapter, recorder, { kind: 'network' }, redact);
  expect(result.kind).toBe('network');
  noSecret(JSON.stringify(result));

  // Failures are never hidden by the network filter: an adapter error quoting
  // a persona value must not reach the model along the thrown path either.
  const observe = wrappedObserve({
    fail: () => new UiDebuggerError(`network ${secret(0)} ${encodeURIComponent(secret(1))}`),
  });
  const thrown = await caught(executor(observe), { kind: 'network' }, OPTIONS);
  expect(thrown).toBeInstanceOf(Error);
  noSecret(`${(thrown as Error).message}\n${(thrown as Error).stack}`);
});

test('runObserve masks console text and location, including the thrown error', async () => {
  const entry: ConsoleEntry = {
    level: 'error',
    text: `failed login for ${secret(0)} ${JSON.stringify(secret(1))}`,
    location: `https://dev.local/app.js?token=${encodeURIComponent(secret(0))}:12`,
    timestamp: 1,
  };
  const { adapter } = fakeAdapter({ console: [entry] });
  const result = await runObserve(adapter, recorder, { kind: 'console' }, redact);
  expect(result.kind).toBe('console');
  noSecret(JSON.stringify(result));

  const observe = wrappedObserve({
    fail: () => new UiDebuggerError(`console read failed for ${secret(1)}`),
  });
  const thrown = await caught(executor(observe), { kind: 'console' }, OPTIONS);
  noSecret(`${(thrown as Error).message}\n${(thrown as Error).stack}`);
});

test('runObserve masks tree text columns and target refs while keeping selector targets usable', async () => {
  const { adapter } = fakeAdapter({ nodes: [node(secret(0)), node(secret(1))] });
  const result = await runObserve(adapter, recorder, { kind: 'tree' }, redact);
  expect(result.kind).toBe('tree');
  noSecret(JSON.stringify(result));

  // A node whose SELECTOR carried the secret gets an opaque ref instead: the
  // driver can address it, but the model never sees the raw value. Resolving
  // that ref on the adapter still yields the original selector.
  const nodes = (result as { nodes: Array<{ target?: string; name?: string }> }).nodes;
  const opaque = nodes.find((n) => n.target?.startsWith('@@ref:'));
  expect(opaque).toBeDefined();
  const selector = resolveTargetRef(adapter, opaque?.target ?? '');
  expect(selector).toContain(secret(0));
  noSecret(JSON.stringify(nodes));

  const observe = wrappedObserve({
    fail: () => new UiDebuggerError(`no node named ${secret(0)}`),
  });
  const thrown = await caught(executor(observe), { kind: 'tree' }, OPTIONS);
  noSecret(`${(thrown as Error).message}\n${(thrown as Error).stack}`);
});

test('runObserve masks tab url/title, in the result and in a thrown error', async () => {
  const tabs: TabInfo[] = [
    {
      index: 0,
      url: `https://dev.local/?token=${encodeURIComponent(secret(0))}`,
      title: `signed in as ${secret(1)}`,
      active: true,
    },
  ];
  const { adapter } = fakeAdapter({ network: [], tabs });
  const result = await runObserve(adapter, recorder, { kind: 'tabs' }, redact);
  expect(result.kind).toBe('tabs');
  noSecret(JSON.stringify(result));

  const tabsFixture = fakeAdapter({ tabs });
  const observe = withRedactedErrors(
    tool({
      inputSchema: z.object({ kind: z.string() }),
      execute: async (input) => {
        if (tabsFixture.adapter.tabs) {
          tabsFixture.adapter.tabs = async () => {
            throw new UiDebuggerError(`tabs for ${secret(0)} unavailable`);
          };
        }
        return executor(createObserveTool(tabsFixture.adapter, recorder, undefined, redact))(
          input,
          OPTIONS,
        );
      },
    }),
    redact,
  );
  const thrown = await caught(executor(observe), { kind: 'tabs' }, OPTIONS);
  expect(thrown).toBeInstanceOf(UiDebuggerError);
  noSecret(`${(thrown as Error).message}\n${(thrown as Error).stack}`);
});
