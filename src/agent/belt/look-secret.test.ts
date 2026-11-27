import { expect, test } from 'bun:test';
import type { Adapter } from '../../adapters/contract.js';
import { createSecretRedactor } from '../../redact.js';
import { runLook, type VisionRequest } from './look.js';

const SECRET = 'h@unter2';
const REDACTED = '<redacted, 8 chars>'; // h@unter2 = 8 chars

function fakeAdapter(): Adapter {
  return {
    selectorDialect: 'web',
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async () => [],
    screenshot: async () => new Uint8Array([137, 80, 78, 71]),
    waitFor: async () => {},
    console: async () => [],
    network: async () => [],
    close: async () => {},
  };
}

function recordVision(text: string): {
  generate: (req: VisionRequest) => Promise<{ text: string }>;
  seen: VisionRequest[];
} {
  const seen: VisionRequest[] = [];
  const generate = async (req: VisionRequest) => {
    seen.push(req);
    return { text };
  };
  return { generate, seen };
}

test('runLook redacts persona values in the question text sent to the vision model', async () => {
  const { generate, seen } = recordVision(JSON.stringify({ description: 'ok' }));
  const redactor = createSecretRedactor([SECRET]);
  const res = await runLook(
    fakeAdapter(),
    generate,
    { saveScreenshot: async () => Promise.resolve('x') },
    {
      question: `does the login box echo ${SECRET}?`,
    },
    undefined,
    undefined,
    redactor,
  );

  const prompt = seen[0]?.messages[0]?.content;
  const textPart = Array.isArray(prompt) ? prompt[0] : null;
  expect(textPart?.type).toBe('text');
  expect(textPart?.text).not.toContain(SECRET);
  expect(textPart?.text).toContain(REDACTED);
  expect(res.description).toBe('ok');
});

test('runLook redacts persona values in the expect text sent to the vision model', async () => {
  const { generate, seen } = recordVision(JSON.stringify({ description: 'ok' }));
  const redactor = createSecretRedactor([SECRET]);
  await runLook(
    fakeAdapter(),
    generate,
    { saveScreenshot: async () => Promise.resolve('x') },
    {
      expect: 'password field shows ' + SECRET,
    },
    undefined,
    undefined,
    redactor,
  );

  const prompt = seen[0]?.messages[0]?.content;
  const textPart = Array.isArray(prompt) ? prompt[0] : null;
  expect(textPart?.text).not.toContain(SECRET);
  expect(textPart?.text).toContain(REDACTED);
});
