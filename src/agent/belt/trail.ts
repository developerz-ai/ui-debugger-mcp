/**
 * The run's shared evidence trail — the spine `act`/`look`/`observe` write and
 * `report` reads.
 *
 * `act` records every step it finishes, ok or not, AT ACT TIME; `look` records
 * each visual issue the vision guy flags; `observe` records every error-level
 * console row it reads back. The timing is the whole point. The SDK runs a
 * step's tool calls CONCURRENTLY (`Promise.all` over the call list) and
 * `onStepFinish` only fires once they have all settled, so when the driver
 * emits a tool and `report` in ONE step — which models do, despite the prompt
 * calling `report` terminal — `report` executes while that tool is still in
 * flight. A trail lifted at step end reaches the terminal read too late: the
 * verdict ships without the last thing the run did.
 *
 * So the trail also counts the work in flight and the terminal read waits for
 * it ({@link ActTrail.settled}). That can never deadlock: the step's own
 * `Promise.all` already awaits every tool call, so `report` only ever waits on
 * work that must finish for its own step to finish at all.
 */

import type { Bug, Step, VisualIssue } from '../../findings/schema.js';

/**
 * The three evidence streams a run accumulates, as `report` (and the loop's
 * running flush) consume them. Live arrays — everything recorded so far, in
 * call order, already deduped.
 */
export interface TrailEvidence {
  /** Ordered act steps, written by `act` as each act finishes. */
  readonly steps: readonly Step[];
  /** Bugs seen so far (console errors today), deduped by normalized detail. */
  readonly bugs: readonly Bug[];
  /** Visual issues seen so far, deduped by normalized issue + location. */
  readonly visual: readonly VisualIssue[];
}

/**
 * The shared trail: the run's {@link TrailEvidence} plus the in-flight
 * bookkeeping the terminal read needs. One per run — `act` writes steps, `look`
 * and `observe` write the streamed findings, the loop's running flush snapshots
 * all three, `report` merges them into the verdict.
 */
export interface ActTrail extends TrailEvidence {
  /** Recorded steps in act order — the array the loop's running flush snapshots. */
  readonly steps: Step[];
  /** Announce an act in flight; call the returned function once it settles. */
  begin(): () => void;
  /** Record one finished act — `ok: true` with its frame, or `ok: false` with the error. */
  record(step: Step): void;
  /** Record one functional bug (a console error). Deduped by normalized `detail`. */
  recordBug(bug: Bug): void;
  /** Record one visual issue. Deduped by normalized `issue` + `where`. */
  recordVisual(issue: VisualIssue): void;
  /** The trail once no act is in flight — the read `report` takes before it writes. */
  settled(): Promise<TrailEvidence>;
}

/**
 * Normalized pairing key for two descriptions of the same evidence — case- and
 * whitespace-insensitive (the same normalization the running flush has always
 * applied). One key per stream: bugs pair on {@link evidenceKey} of `detail`,
 * visual issues on `issue` + `where`.
 */
export function evidenceKey(...parts: string[]): string {
  return parts.join(' @ ').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Let already-queued microtasks run — one full turn of the event loop. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build a fresh {@link ActTrail} for one run. */
export function createActTrail(): ActTrail {
  const steps: Step[] = [];
  const bugs: Bug[] = [];
  const visual: VisualIssue[] = [];
  // Dedupe keys mirror the arrays: the console channel is a ring buffer read
  // non-destructively, and looks repeat on an unchanged screen, so a re-read
  // must add nothing.
  const bugKeys = new Set<string>();
  const visualKeys = new Set<string>();
  let inFlight = 0;
  let idle: Promise<void> | null = null;
  let markIdle: (() => void) | null = null;
  return {
    steps,
    bugs,
    visual,
    begin() {
      inFlight += 1;
      idle ??= new Promise<void>((resolve) => {
        markIdle = resolve;
      });
      let settled = false;
      return () => {
        // Idempotent: a double-settle must not drop a sibling act's count.
        if (settled) return;
        settled = true;
        inFlight -= 1;
        if (inFlight > 0) return;
        markIdle?.();
        idle = null;
        markIdle = null;
      };
    },
    record(step) {
      steps.push(step);
    },
    recordBug(bug) {
      const key = evidenceKey(bug.detail);
      if (bugKeys.has(key)) return;
      bugKeys.add(key);
      bugs.push(bug);
    },
    recordVisual(issue) {
      const key = evidenceKey(issue.issue, issue.where);
      if (visualKeys.has(key)) return;
      visualKeys.add(key);
      visual.push(issue);
    },
    async settled() {
      // Yield a full turn before checking: the sibling tool calls of this step are
      // launched in microtasks, so an act listed AFTER `report` in the call list has
      // not entered `begin()` yet when the terminal read starts. One turn guarantees
      // every sibling has begun — otherwise the barrier would read an empty gate and
      // miss exactly the act it exists to wait for.
      await nextTurn();
      while (idle !== null) await idle;
      return { steps, bugs, visual };
    },
  };
}
