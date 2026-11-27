import { expect, test } from 'bun:test';
import type { Adapter, ConsoleEntry, NetworkEntry } from '../../adapters/contract.js';
import { createSecretRedactor } from '../../redact.js';
import { runObserve } from './observe.js';
import { createObserveTool } from './observe-tool.js';

/** h@unter2 is synthetic (kitchen-secret). */
const SECRET = 'h@unter2';
const REDACTED = '<redacted, 8 chars>'; // h@unter2 = 8 chars

function fakeAdapter(consoleRows: ConsoleEntry[]): Adapter {
  return {
    selectorDialect: 'web',
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async () => [],
    screenshot: async () => new Uint8Array(),
    waitFor: async () => {},
    console: async () => consoleRows,
    network: async () => [],
    close: async () => {},
  };
}

function fakeNetwork(rows: NetworkEntry[]): Adapter {
  return {
    selectorDialect: 'web',
    open: async () => {},
    find: async () => null,
    click: async () => {},
    type: async () => {},
    pressKey: async () => {},
    scroll: async () => {},
    readState: async () => [],
    screenshot: async () => new Uint8Array(),
    waitFor: async () => {},
    console: async () => [],
    network: async () => rows,
    close: async () => {},
  };
}

test('redacted console read scrubs persona values from text AND location', async () => {
  const rows: ConsoleEntry[] = [
    {
      level: 'error',
      text: `login failed for ${SECRET}`,
      location: 'http://x/app.js?token=' + SECRET,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ];
  const redactor = createSecretRedactor([SECRET]);
  const res = await runObserve(
    fakeAdapter(rows),
    { saveScreenshot: async () => Promise.resolve('x') },
    { kind: 'console' },
    redactor,
  );
  expect(res.entries?.[0]?.text).toBe(`login failed for ${REDACTED}`);
  expect(res.entries?.[0]?.location).toBe(`http://x/app.js?token=${REDACTED}`);
});

test('redacted network read scrubs secret values in query AND body', async () => {
  const rows: NetworkEntry[] = [
    {
      method: 'POST',
      url: 'http://x/login?token=' + SECRET,
      status: 401,
      requestBody: `{"password":"${SECRET}"}`,
      responseBody: 'unauthorized',
      timestamp: '2026-01-01T00:00:00.000Z',
    },
  ];
  const redactor = createSecretRedactor([SECRET]);
  const res = await runObserve(
    fakeNetwork(rows),
    { saveScreenshot: async () => Promise.resolve('x') },
    { kind: 'network' },
    redactor,
  );
  expect(res.entries?.[0]?.url).toContain(`token=${REDACTED}`);
  expect(res.entries?.[0]?.requestBody).toContain(`"password":"${REDACTED}"`);
});

test('wired redactor keeps secret values out of observe-tool output (bug detail + evidence)', async () => {
  const tool = createObserveTool(
    fakeAdapter([
      {
        level: 'error',
        text: `login failed for ${SECRET}`,
        location: `http://x?token=${SECRET}`,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]),
    { saveScreenshot: async () => Promise.resolve('x') },
    undefined,
    createSecretRedactor([SECRET]),
  );
  const res = await tool.execute({ kind: 'console' });
  const entries = (res as { entries: Array<{ text: string; location: string }> }).entries;
  expect(entries[0]?.text).toBe(`login failed for ${REDACTED}`);
  expect(entries[0]?.location).toContain(REDACTED);
  expect(entries[0]?.text).not.toContain(SECRET);
  expect(entries[0]?.location).not.toContain(SECRET);
});

test('runObserve routes both console AND network through the redactor', async () => {
  const redactor = createSecretRedactor([SECRET]);
  const consoleRes = await runObserve(
    fakeAdapter([
      {
        level: 'error',
        text: `${SECRET}`,
        location: `x?token=${SECRET}`,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]),
    { saveScreenshot: async () => Promise.resolve('x') },
    { kind: 'console' },
    redactor,
  );
  expect(consoleRes.entries?.[0]?.text).not.toContain(SECRET);
  expect(consoleRes.entries?.[0]?.location).not.toContain(SECRET);

  const netRes = await runObserve(
    fakeNetwork([
      {
        method: 'GET',
        url: `http://x?token=${SECRET}`,
        status: 200,
        requestBody: '',
        responseBody: '{}',
        timestamp: '2026-01-01T00:00:00.000Z',
      },
    ]),
    { saveScreenshot: async () => Promise.resolve('x') },
    { kind: 'network' },
    redactor,
  );
  expect(netRes.entries?.[0]?.url).not.toContain(SECRET);
});
