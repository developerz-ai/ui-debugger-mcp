import { expect, test } from 'bun:test';
import { AdapterError } from '../../errors.js';
import { closeOnFailure, createFailure } from './launch.js';

// --- closeOnFailure ---------------------------------------------------------

/** Stand-in for the Playwright context/browser handle: records how often it was closed. */
function fakeHandle(close: () => Promise<void> = async () => undefined) {
  let closes = 0;
  return {
    closes: () => closes,
    close: async () => {
      closes += 1;
      await close();
    },
  };
}

test('closeOnFailure returns the value and leaves the handle open on success', async () => {
  const handle = fakeHandle();
  expect(await closeOnFailure(handle, async () => 'adapter')).toBe('adapter');
  expect(handle.closes()).toBe(0);
});

test('closeOnFailure closes the handle when post-connect setup throws', async () => {
  // The real case: `context.newPage()` fails after Chrome is already up. Without the
  // close, that Chrome lives on holding the persistent-profile lock forever.
  const handle = fakeHandle();
  const boom = new Error('newPage: Target closed');

  await expect(
    closeOnFailure(handle, async () => {
      throw boom;
    }),
  ).rejects.toThrow(boom);
  expect(handle.closes()).toBe(1);
});

test('closeOnFailure surfaces the setup error even when close() also fails', async () => {
  // Teardown noise must never mask the cause.
  const handle = fakeHandle(async () => {
    throw new Error('close: browser has been closed');
  });

  await expect(
    closeOnFailure(handle, async () => {
      throw new Error('capture failed');
    }),
  ).rejects.toThrow('capture failed');
  expect(handle.closes()).toBe(1);
});

// --- createFailure ----------------------------------------------------------

const managed = { mode: 'managed', profileDir: '/w/chrome-user-data' } as const;
const attach = { mode: 'attach', cdpUrl: 'http://127.0.0.1:9222' } as const;

test('createFailure explains a locked profile and how to unblock it', () => {
  const error = createFailure(
    new Error(
      'browserType.launchPersistentContext: Browser closed.\n[err] The profile appears to be in use by another Chromium process (4242)',
    ),
    managed,
  );
  expect(error).toBeInstanceOf(AdapterError);
  expect(error.message).toContain('/w/chrome-user-data');
  expect(error.message).toContain('ui-debugger-mcp stop');
  expect(error.message).toContain('appears to be in use'); // original text kept
});

test('createFailure detects the other lock spellings too', () => {
  for (const detail of [
    // Verbatim from a real second `launchPersistentContext` on a live profile dir.
    'launchPersistentContext: Failed to create a ProcessSingleton for your profile directory.',
    'Failed to create /w/SingletonLock: File exists',
  ]) {
    expect(createFailure(new Error(detail), managed).message).toContain('is locked by another');
  }
});

test('createFailure wraps a non-lock launch failure without lock advice', () => {
  const error = createFailure(new Error("Executable doesn't exist at /opt/chrome"), managed);
  expect(error).toBeInstanceOf(AdapterError);
  expect(error.message).toContain("Executable doesn't exist");
  expect(error.message).not.toContain('locked');
});

test('createFailure names the cdpUrl when attach fails', () => {
  const error = createFailure(new Error('connectOverCDP: ECONNREFUSED'), attach);
  expect(error).toBeInstanceOf(AdapterError);
  expect(error.message).toContain('http://127.0.0.1:9222');
  expect(error.message).toContain('ECONNREFUSED');
});

test('createFailure passes an AdapterError through untouched (no double-wrap)', () => {
  const original = new AdapterError('attach mode requires `cdpUrl`');
  expect(createFailure(original, attach)).toBe(original);
});

test('createFailure stringifies a non-Error throw', () => {
  expect(createFailure('kaboom', managed).message).toContain('kaboom');
});
