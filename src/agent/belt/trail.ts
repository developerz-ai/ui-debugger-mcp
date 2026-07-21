/**
 * The run's shared act trail — the evidence spine `act` writes and `report` reads.
 *
 * `act` records every step it finishes, ok or not, AT ACT TIME. The timing is the
 * whole point. The SDK runs a step's tool calls CONCURRENTLY (`Promise.all` over
 * the call list) and `onStepFinish` only fires once they have all settled, so when
 * the driver emits `act` and `report` in ONE step — which models do, despite the
 * prompt calling `report` terminal — `report` executes while that act is still in
 * flight. A trail lifted at step end reaches the terminal read too late: the
 * verdict ships without the last thing the run did.
 *
 * So the trail also counts the acts in flight and the terminal read waits for them
 * ({@link ActTrail.settled}). That can never deadlock: the step's own `Promise.all`
 * already awaits every act, so `report` only ever waits on work that must finish
 * for its own step to finish at all.
 */

import type { Step } from '../../findings/schema.js';

/**
 * The shared trail: an ordered {@link Step} log plus the in-flight bookkeeping the
 * terminal read needs. One per run — `act` writes it, the loop's running flush
 * snapshots it, `report` merges it into the verdict.
 */
export interface ActTrail {
  /** Recorded steps in act order — the array the loop's running flush snapshots. */
  readonly steps: Step[];
  /** Announce an act in flight; call the returned function once it settles. */
  begin(): () => void;
  /** Record one finished act — `ok: true` with its frame, or `ok: false` with the error. */
  record(step: Step): void;
  /** The trail once no act is in flight — the read `report` takes before it writes. */
  settled(): Promise<readonly Step[]>;
}

/** Let already-queued microtasks run — one full turn of the event loop. */
function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Build a fresh {@link ActTrail} for one run. */
export function createActTrail(): ActTrail {
  const steps: Step[] = [];
  let inFlight = 0;
  let idle: Promise<void> | null = null;
  let markIdle: (() => void) | null = null;
  return {
    steps,
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
    async settled() {
      // Yield a full turn before checking: the sibling tool calls of this step are
      // launched in microtasks, so an act listed AFTER `report` in the call list has
      // not entered `begin()` yet when the terminal read starts. One turn guarantees
      // every sibling has begun — otherwise the barrier would read an empty gate and
      // miss exactly the act it exists to wait for.
      await nextTurn();
      while (idle !== null) await idle;
      return steps;
    },
  };
}
