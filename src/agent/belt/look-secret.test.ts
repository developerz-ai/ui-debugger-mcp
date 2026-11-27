/**
 * Vision (`look`) and self-look: prose reaching the model/driver must carry no
 * persona secret, but the screenshot frame must stay byte-exact (redacting a
 * short secret inside base64 would corrupt the image). All values SYNTHETIC.
 */

import { expect, test } from 'bun:test';
import { tool } from 'ai';
import { z } from 'zod';
import type { Adapter } from '../../adapters/contract.js';
import { UiDebuggerError } from '../../errors.js';
import { createSecretRedactor } from '../../redact.js';
import {
  createLookExecute,
  createSelfLookTool,
  type EvidenceRecorder,
  type LookResult,
  runLook,
  type SelfLookResult,
  type VisionRequest,
} from './look.js';
import { withRedactedErrors, withRedactedOutput } from './redact-output.js';

const SECRET = 'hunter2';
const ENCODED = '%68%75%6e%74%65%72%32';
const redact = createSecretRedactor([SECRET]);
const MASK = '<redacted, 7 chars>';

/** A PNG-ish frame whose base64 could accidentally contain a short token. */
const FRAME = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x01, 0x02, 0x03, 0x04]);
const FRAME_B64 = Buffer.from(FRAME).toString('base64');

/** The SDK passes toolCallId/messages/context on every execute call. */
const OPTIONS = { toolCallId: 't1', messages: [], context: {} };

/**
 * AI SDK `Tool.execute` is typed as a union that also admits async iterables.
 * These fakes always return a plain value, so narrow at the test boundary.
 */
async function call<T>(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<T> {
  return (await (fn as (...a: unknown[]) => Promise<T>)(...args)) as T;
}

async function caught(fn: (...args: never[]) => unknown, ...args: unknown[]): Promise<unknown> {
  return call<unknown>(fn, ...args).catch((error: unknown) => error);
}

/** The SDK types both methods as optional; our tools always define them. */
function executor(toolValue: {
  execute?: (...args: never[]) => unknown;
}): (...args: never[]) => unknown {
  const execute = toolValue.execute;
  if (!execute) throw new Error('expected tool.execute');
  return execute;
}

function modelOutput(toolValue: {
  toModelOutput?: (...args: never[]) => unknown;
}): (...args: never[]) => unknown {
  const output = toolValue.toModelOutput;
  if (!output) throw new Error('expected tool.toModelOutput');
  return output;
}

function noSecret(text: string): void {
  expect(text).not.toContain(SECRET);
  expect(text).not.toContain(ENCODED);
  expect(text).not.toContain(JSON.stringify(SECRET).slice(1, -1));
}

interface Saved {
  label: string;
  bytes: Uint8Array;
}

function fakeEvidence(): { recorder: EvidenceRecorder; saved: Saved[] } {
  const saved: Saved[] = [];
  return {
    saved,
    recorder: {
      saveScreenshot: async (label, bytes) => {
        saved.push({ label, bytes });
        return 'screenshots/001-look.png';
      },
    },
  };
}

/** Fake screenshot source: the "screen" renders the synthetic secret as text. */
function fakeAdapter(fail?: (error: Error) => void): Adapter {
  return {
    selectorDialect: 'web',
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async () => [],
    screenshot: async () => {
      fail?.(new UiDebuggerError(`screenshot of ${SECRET} failed`));
      return FRAME;
    },
    waitFor: async () => {},
    console: async () => [],
    network: async () => [],
    close: async () => {},
  };
}

test('vision look: prompt, description and issues reaching the model carry no secret', async () => {
  const { recorder, saved } = fakeEvidence();
  let request: VisionRequest | undefined;
  const generate = async (req: VisionRequest) => {
    request = req;
    return {
      text: JSON.stringify({
        description: `the login field shows ${SECRET}`,
        matches: false,
        issues: [
          {
            what: `label reads ${SECRET} ${ENCODED}`,
            where: `near ${JSON.stringify(SECRET).slice(1, -1)}`,
            severity: 'medium',
          },
        ],
      }),
    };
  };

  // The model-bound call is wrapped where session-builder wires it: prose gets
  // masked, while the question/expect and the reply are otherwise unchanged.
  const execute = createLookExecute(fakeAdapter(), generate, recorder);
  const look = withRedactedErrors(
    tool({
      inputSchema: z.object({ question: z.string().optional(), expect: z.string().optional() }),
      execute: async (input) => execute(input),
    }),
    redact,
  );
  // Belt inputs are redacted by withToolLog before reaching the tool in the real
  // loop; here we hand it masked input the same way and check the model-bound
  // prompt and reply. runLook's own result is asserted independently below.
  const result = await call<LookResult>(
    executor(look),
    { question: `is ${MASK} visible?`, expect: `a red ${MASK} badge` },
    OPTIONS,
  );

  // runLook is the unredacted core: the belt wrapper is what feeds the model.
  // Give it a fake reply with the secret and assert both tool paths mask it.
  const wrapped = withRedactedOutput(
    tool({ inputSchema: z.object({}), execute: async () => result }),
    redact,
  );
  const masked = await call<LookResult>(executor(wrapped), {}, OPTIONS);
  expect(masked.description).toContain(MASK);
  expect(masked.issues[0]?.what).toContain(MASK);
  expect(masked.issues[0]?.where).toContain(MASK);
  noSecret(JSON.stringify(masked));
  noSecret(JSON.stringify(request?.system));
  noSecret(JSON.stringify(request?.messages));
  // The frame the model judged is the frame saved as evidence, unmodified.
  expect(saved).toHaveLength(1);
  expect(saved[0]?.bytes).toEqual(FRAME);
});

test('vision look: a thrown provider/screenshot error is redacted on the model path', async () => {
  const { recorder } = fakeEvidence();
  const generate = async () => {
    throw new UiDebuggerError(`vision provider rejected ${SECRET}`);
  };
  const execute = createLookExecute(fakeAdapter(), generate, recorder);
  const look = withRedactedErrors(
    tool({
      inputSchema: z.object({ question: z.string().optional() }),
      execute: async (input) => execute(input),
    }),
    redact,
  );
  const thrown = await caught(executor(look), { question: 'what text?' }, OPTIONS);
  expect(thrown).toBeInstanceOf(UiDebuggerError);
  noSecret(`${(thrown as Error).message}\n${(thrown as Error).stack}`);

  const screenshotFailure = withRedactedErrors(
    tool({
      inputSchema: z.object({}),
      execute: async () =>
        runLook(
          fakeAdapter((error) => {
            throw error;
          }),
          async () => ({ text: '{}' }),
          recorder,
          { question: 'what text?' },
        ),
    }),
    redact,
  );
  const fromScreenshot = await caught(executor(screenshotFailure), {}, OPTIONS);
  noSecret(`${(fromScreenshot as Error).message}\n${(fromScreenshot as Error).stack}`);
});

test('self-look: prompt/model output is redacted while the base64 frame stays byte-exact', async () => {
  const { recorder, saved } = fakeEvidence();
  const selfLook = withRedactedErrors(createSelfLookTool(fakeAdapter(), recorder), redact);
  const result = await call<SelfLookResult>(
    executor(selfLook),
    { question: redact(`is ${SECRET} shown?`), expect: redact(`a ${SECRET} badge`) },
    OPTIONS,
  );

  // Error wrapping must not touch the successful result: the frame is binary and
  // a redactor match inside it would corrupt the image.
  expect(result.frame).toBe(FRAME_B64);
  expect([...Buffer.from(result.frame, 'base64')]).toEqual([...FRAME]);
  expect(saved[0]?.bytes).toEqual(FRAME);
  noSecret(result.prompt);
  expect(result.prompt).toContain(MASK);

  const output = await call<{ type: string; value: unknown } | undefined>(modelOutput(selfLook), {
    input: { question: 'is the badge shown?' },
    output: result,
    toolCallId: OPTIONS.toolCallId,
  } as never);
  if (output?.type !== 'content') throw new Error('expected content tool output');
  const parts = output.value as Array<{ type: string; text?: string; data?: { data?: string } }>;
  const text = parts.map((part) => part.text ?? '').join('\n');
  noSecret(text);
  expect(text).toContain(MASK);
  const filePart = parts.find((part) => part.type === 'file');
  expect(filePart?.data?.data).toBe(FRAME_B64);
  expect(result.bytes).toBe(FRAME.byteLength);
});

test('self-look: a thrown capture error carries no secret to the driver', async () => {
  const { recorder } = fakeEvidence();
  const selfLook = withRedactedErrors(
    createSelfLookTool(
      fakeAdapter((error) => {
        throw error;
      }),
      recorder,
    ),
    redact,
  );
  const thrown = await caught(executor(selfLook), {}, OPTIONS);
  expect(thrown).toBeInstanceOf(UiDebuggerError);
  expect((thrown as Error).message).not.toContain(SECRET);
  noSecret(`${(thrown as Error).message}\n${(thrown as Error).stack}`);
});
