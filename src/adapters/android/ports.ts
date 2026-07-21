/**
 * Emulator console-port allocation — the one thing that makes **managed** android
 * mode bindable.
 *
 * A managed run must drive only the emulator it started (`idea/adapters.md`), but
 * `adb -e` just means "the single emulator" — with a pre-existing one running it
 * silently drives (and `close` kills) a device we never launched. Fix: spawn with
 * an explicit `-port <p>`, which names the device `emulator-<p>`, and bind every
 * later call to that serial (`adb -s emulator-<p>`).
 *
 * The emulator only accepts **even** console ports in 5554–5584 and claims the
 * next (odd) port for its adb channel — so a slot is free only when both are.
 */

import { createServer } from 'node:net';
import { AdapterError } from '../../errors.js';

/** Lowest console port the emulator accepts (`emulator-5554`, the default slot). */
export const PORT_MIN = 5554;
/** Highest console port the emulator accepts — 16 slots of two ports each. */
export const PORT_MAX = 5584;

/** Port probe seam — resolves true when nothing is listening on `port`. */
export type PortProbe = (port: number) => Promise<boolean>;

/** ADB serial of an emulator started on console `port`. */
export function emulatorSerial(port: number): string {
  return `emulator-${port}`;
}

/**
 * True when `port` is bindable on loopback — i.e. no emulator (or anything else)
 * holds it. Never rejects: a bind failure *is* the "busy" answer.
 */
export const isPortFree: PortProbe = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => {
      server.close(() => resolve(true));
    });
  });

/**
 * First free console port for a managed emulator, or a loud {@link AdapterError}
 * when every slot is taken. Both `port` and `port + 1` (the adb channel) must be
 * free. Inherently racy against another launcher — the boot wait catches that.
 */
export async function pickEmulatorPort(probe: PortProbe = isPortFree): Promise<number> {
  for (let port = PORT_MIN; port <= PORT_MAX; port += 2) {
    if ((await probe(port)) && (await probe(port + 1))) return port;
  }
  throw new AdapterError(
    `android: no free emulator port in ${PORT_MIN}-${PORT_MAX} (too many emulators running)`,
  );
}
