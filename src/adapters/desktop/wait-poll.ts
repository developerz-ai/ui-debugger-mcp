/**
 * The desktop `waitFor` poll loop, abort-aware — split out of `desktop-adapter.ts`.
 */

import { AdapterError } from '../../errors.js';

/** Pause between polls of the a11y tree. */
const POLL_MS = 500;

/** The rejection `WaitOptions.signal` asks for — an error named `AbortError`. */
export const abortError = (): DOMException =>
  new DOMException('desktop: waitFor aborted', 'AbortError');

export interface PollInit {
  /** One deadline-bounded read: true once the awaited node is present. */
  present: () => Promise<boolean>;
  /** Timeout wording, e.g. `waitFor timed out after 50ms (query)`. */
  label: string;
  /** Absolute epoch-ms instant the wait must not run past. */
  deadline: number;
  /** Rejects the moment the caller's signal fires; cuts short a walk and the nap. */
  aborted: Promise<never>;
}

/** Poll until present; reject on the deadline (loud) or on abort. Clears its nap timer on every path. */
export async function pollUntilPresent(init: PollInit): Promise<void> {
  const { deadline, aborted } = init;
  for (;;) {
    // The losing walk keeps running to its own deadline; its rejection must not go unhandled.
    const present = init.present();
    present.catch(() => {});
    if (await Promise.race([present, aborted])) {
      // A match that only landed after the deadline is not a success: the wait is
      // over, so resolving now would report a node the caller waited too long for.
      if (Date.now() > deadline) {
        throw new AdapterError(
          `desktop: ${init.label} — the query matched only after the deadline`,
        );
      }
      return;
    }
    if (Date.now() >= deadline) throw new AdapterError(`desktop: ${init.label}`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nap = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, POLL_MS);
    });
    try {
      await Promise.race([nap, aborted]);
    } finally {
      clearTimeout(timer);
    }
  }
}
