/**
 * The navigation guard `act` applies to `navigate` — the run stays on the app
 * under test. Split from `act.ts` (one responsibility per file).
 */

import { AgentError } from '../../errors.js';

/**
 * Refuse a `navigate` that leaves the app under test.
 *
 * Observed end-to-end: driven at the local fixture with the goal "debug the Nimbus
 * Store home page", the driver's FIRST action was
 * `navigate → https://nimbus-store.vercel.app` — a public site it inferred from the
 * goal text. It never returned, and the run ended with six confident, fully-evidenced
 * bugs about a stranger's production app, with nothing in the output hinting the
 * target had been left. The smart agent would have gone hunting for a CORS bug that
 * does not exist in its repo.
 *
 * `origin` is the run's own origin (web only; empty for desktop/android, whose
 * `navigate` means a window title or an app package). Same-origin URLs and relative
 * paths pass; anything else fails loud, naming where the driver is supposed to be.
 * A run that wanders off the app under test is worse than a run that stops.
 */
export function assertSameOrigin(target: string, origin: string | undefined): void {
  if (!origin) return; // non-web target, or no origin to enforce
  let destination: URL;
  try {
    destination = new URL(target, origin); // relative paths resolve against the app
  } catch {
    return; // not URL-shaped — let the adapter reject it with its own message
  }
  if (destination.origin === origin) return;
  throw new AgentError(
    `act 'navigate' refused: '${target}' leaves the app under test (${origin}). ` +
      'Findings about another site cannot be acted on. Use a path or a URL on ' +
      `${origin}; if the app genuinely lives elsewhere, the smart agent must pass that url to start_debug.`,
  );
}
