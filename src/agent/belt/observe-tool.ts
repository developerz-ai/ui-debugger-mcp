/**
 * Build the `observe` tool bound to one adapter + recorder, for the debug agent's belt.
 * `trail` (when wired by the loop) is the run's evidence trail: every error-level
 * console row a read returns is recorded there BEFORE the gate releases — dedupe
 * is the trail's job, so re-reads of the ring buffer add nothing — and a `report`
 * racing in the SAME step carries them even when the driver's `bugs` array omits
 * them. Other kinds record nothing; a failed read records nothing.
 *
 * `redact` threads through to {@link runObserve}'s console and network channels
 * (identity when omitted), so both the entries the driver reads and the error
 * rows recorded on the trail below arrive persona-redacted.
 */
import { tool } from 'ai';
import { ObserveInputSchema } from './observe.js';
import { runObserve } from './observe.js';
import type { Redactor } from '../../redact.js';
import type { Adapter } from '../adapters/contract.js';
import type { EvidenceRecorder } from './look.js';
import type { ActTrail } from './trail.js';

export function createObserveTool(
  adapter: Adapter,
  recorder: EvidenceRecorder,
  trail?: ActTrail,
  redact: Redactor = (line) => line,
) {
  return tool({
    description:
      'Read the target without mutating it. Pick a channel with kind (tree=UI nodes incl. iframe content, screenshot=PNG evidence saved to screenshots/ — returns its path, console=logs, network=requests with status/timing/payloads, tabs=open tabs); compose with query/fields/filters/limit/within. Use it to inspect state before and after acting.',
    inputSchema: ObserveInputSchema,
    execute: async (input) => {
      // Enter the trail's gate BEFORE the first await (same discipline as `act`),
      // so a same-step terminal read sees this read in flight rather than an idle
      // gate.
      const settle = trail?.begin();
      try {
        const result = await runObserve(adapter, recorder, input, redact);
        // Record AFTER the result exists, BEFORE releasing: the read succeeded, so
        // its error rows are real surfaced findings.
        if (result.kind === 'console') {
          for (const entry of result.entries) {
            // Error rows only — warn/log/info are working noise, not findings.
            if (entry.level !== 'error') continue;
            trail?.recordBug({
              kind: 'console',
              detail: entry.text,
              ...(entry.location !== undefined && { evidence: entry.location }),
            });
          }
        }
        return result;
      } finally {
        settle?.();
      }
    },
  });
}
