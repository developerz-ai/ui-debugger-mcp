/**
 * Unit tests for emulator console-port allocation (`ports.ts`) — the free-port
 * scan runs over a fake probe; `isPortFree` is exercised against a real socket.
 */

import { describe, expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { AdapterError } from '../../errors.js';
import {
  emulatorSerial,
  isPortFree,
  PORT_MAX,
  PORT_MIN,
  type PortProbe,
  pickEmulatorPort,
} from './ports.js';

/** Probe fake: every port is free except the listed ones. */
function probeBusy(busy: number[]): PortProbe {
  return async (port) => !busy.includes(port);
}

describe('emulatorSerial', () => {
  test('names the device after its console port', () => {
    expect(emulatorSerial(5554)).toBe('emulator-5554');
    expect(emulatorSerial(5584)).toBe('emulator-5584');
  });
});

describe('pickEmulatorPort', () => {
  test('picks the lowest slot when everything is free', async () => {
    expect(await pickEmulatorPort(probeBusy([]))).toBe(PORT_MIN);
  });

  test('skips a slot whose console port is taken', async () => {
    expect(await pickEmulatorPort(probeBusy([5554]))).toBe(5556);
  });

  test('skips a slot whose adb port (port + 1) is taken', async () => {
    // 5554 is bindable but its emulator would fail to claim 5555 — take the next slot.
    expect(await pickEmulatorPort(probeBusy([5555]))).toBe(5556);
  });

  test('only ever returns even ports in the emulator range', async () => {
    const port = await pickEmulatorPort(probeBusy([5554, 5555, 5556, 5557, 5558]));
    expect(port).toBe(5560);
    expect(port % 2).toBe(0);
    expect(port).toBeLessThanOrEqual(PORT_MAX);
  });

  test('throws AdapterError when every slot is busy', async () => {
    const all: number[] = [];
    for (let p = PORT_MIN; p <= PORT_MAX + 1; p += 1) all.push(p);
    const err = await pickEmulatorPort(probeBusy(all)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdapterError);
    expect((err as AdapterError).message).toContain('no free emulator port');
  });
});

describe('isPortFree', () => {
  test('false while a socket holds the port, true once released', async () => {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen({ port: 0, host: '127.0.0.1' }, () => {
        const address = server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('server did not bind a TCP port'));
          return;
        }
        resolve(address.port);
      });
    });

    expect(await isPortFree(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await isPortFree(port)).toBe(true);
  });
});
