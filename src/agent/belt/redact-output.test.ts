import { expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import { AgentError, VisionUnavailableError } from '../../errors.js';
import { createSecretRedactor } from '../../redact.js';
import { redactStrings, withRedactedOutput } from './redact-output.js';

/** `hunter2` is a SYNTHETIC persona value, never a real credential. */
const REDACT = createSecretRedactor(['hunter2']);
const MASK = '<redacted, 7 chars>';

/** Run a wrapped tool's execute the way the SDK does. */
const call = (t: { execute?: unknown }, input: unknown = {}) =>
  (t.execute as (input: unknown, options: object) => Promise<unknown>)(input, {});

test('redactStrings masks every nested string and leaves non-plain values alone', () => {
  const bytes = new Uint8Array([1, 2]);
  const out = redactStrings(
    { label: 'typed hunter2', tabs: [{ index: 0, url: 'http://x/?k=hunter2' }], ok: true, bytes },
    REDACT,
  );
  expect(out).toEqual({
    label: `typed ${MASK}`,
    tabs: [{ index: 0, url: `http://x/?k=${MASK}` }],
    ok: true,
    bytes,
  });
});

test('withRedactedOutput masks a persona value in an act-shaped and a look-shaped result', async () => {
  const act = withRedactedOutput(
    tool({
      inputSchema: z.object({}),
      execute: async () => ({ ok: true, navigated: ['http://x/welcome?pw=hunter2'] }),
    }),
    REDACT,
  );
  const look = withRedactedOutput(
    tool({
      inputSchema: z.object({}),
      execute: async () => ({ description: 'the field shows hunter2', issues: [] }),
    }),
    REDACT,
  );
  expect(JSON.stringify([await call(act), await call(look)])).not.toContain('hunter2');
});

test('withRedactedOutput masks a thrown error message — a tool error reaches the model verbatim', async () => {
  const failing = withRedactedOutput(
    tool({
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw new Error('could not type "hunter2" into #password');
      },
    }),
    REDACT,
  );
  const error = await call(failing).catch((e: unknown) => e);
  expect((error as Error).message).toBe(`could not type "${MASK}" into #password`);
});

test('withRedactedOutput rethrows a secret-free error UNCHANGED — its class is load-bearing', async () => {
  const latch = new VisionUnavailableError('look is unavailable for this run');
  const failing = withRedactedOutput(
    tool({
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw latch;
      },
    }),
    REDACT,
  );
  expect(await call(failing).catch((e: unknown) => e)).toBe(latch);
});

test('a redacted error keeps its class and name, and carries the secret nowhere — not in message, stack or cause', async () => {
  const thrown = [
    new VisionUnavailableError('provider said: bad image for hunter2'),
    new DOMException('aborted while typing hunter2', 'AbortError'),
    new TypeError('hunter2 is not a function'),
  ];
  for (const original of thrown) {
    const failing = withRedactedOutput(
      tool({
        inputSchema: z.object({}),
        execute: async (): Promise<string> => {
          throw original;
        },
      }),
      REDACT,
    );
    const error = (await call(failing).catch((e: unknown) => e)) as Error;
    expect(error).not.toBe(original);
    expect(error).toBeInstanceOf(original.constructor);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe(original.name);
    expect(error.message).toContain(MASK);
    expect(error.cause).toBeUndefined();
    expect(`${error.message}\n${error.stack}\n${String(error)}`).not.toContain('hunter2');
  }
});

test('a thrown NON-error carrying a secret becomes a redacted AgentError', async () => {
  const failing = withRedactedOutput(
    tool({
      inputSchema: z.object({}),
      execute: async (): Promise<string> => {
        throw 'typed hunter2';
      },
    }),
    REDACT,
  );
  const error = await call(failing).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(AgentError);
  expect((error as Error).message).toBe(`typed ${MASK}`);
});
