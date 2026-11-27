import type { LoopInbox, ProgressWriter } from '../agent/loop.js';
import type { Findings } from '../findings/schema.js';
import type { FindingsStore } from './findings-store.js';

/** Run lifecycle status — mirrors the findings verdict (`running` until concluded). */
export type SessionStatus = Findings['status'];

/** Selectable top-level findings keys for a sparse `snapshot` (the `get_findings` `fields` param). */
export type SnapshotField = keyof Findings;

/** The only adapter capability the session itself uses: release the target on close. */
export interface SessionAdapter {
  close(): Promise<void>;
}

/**
 * Post-verdict findings condenser — the summary actor. Given the run's terminal
 * findings, returns one actionable paragraph for the smart agent. Bound to the
 * summary model OUTSIDE the session (so the session stays model-blind); the session
 * invokes it only when the driver left `findings.summary` empty, passing its abort
 * signal so teardown cancels the in-flight model call instead of abandoning it.
 */
export type SummarizeStep = (findings: Findings, signal?: AbortSignal) => Promise<string>;

/**
 * Outcome of the post-verdict replay attempt:
 *  - `rendered` — the clip was stitched; `path` is recorded in `findings.evidence`.
 *  - `skipped`  — no clip was produced. A `note` (when present) explains why — e.g.
 *    ffmpeg is not installed — and the session surfaces it into the findings so a
 *    reviewer knows the missing `replay.mp4` was expected, not silently dropped. No
 *    `note` means there was simply nothing to stitch (no screenshots); skipped quietly.
 */
export type ReplayOutcome = { kind: 'rendered'; path: string } | { kind: 'skipped'; note?: string };

/**
 * Post-verdict replay generator — stitches the run's ordered screenshots into a
 * captioned `replay.mp4` for PR evidence, reporting its {@link ReplayOutcome}. Bound
 * to ffmpeg + the session paths OUTSIDE the session, so the session stays tool- and
 * path-blind (the same shape as {@link SummarizeStep}). It probes for ffmpeg and
 * skips gracefully when absent — never crashing teardown. Receives the session's
 * abort signal so teardown KILLS the encoder instead of orphaning it: the process
 * can exit moments later, and a detached ffmpeg would outlive the run.
 */
export type ReplayStep = (signal?: AbortSignal) => Promise<ReplayOutcome>;

/** Everything needed to construct a session. The loop is handed to `start()`, not the constructor. */
export interface SessionOptions<A extends SessionAdapter> {
  /** Stable session id (from `generateSessionId`). */
  id: string;
  /** The goal the smart agent handed over, in plain language. */
  story: string;
  /** Optional explicit pass/fail rules for the run. */
  criteria?: string;
  /** The target driver (browser/desktop/android), behind the shared adapter contract. */
  adapter: A;
  /** On-disk evidence locker for this session. */
  findingsStore: FindingsStore;
  /**
   * Optional summary actor: fills `findings.summary` after the verdict when the
   * driver left it empty. Omit to keep whatever summary the driver wrote.
   */
  summarize?: SummarizeStep;
  /**
   * Optional replay generator: stitches the ordered screenshots into a captioned
   * `replay.mp4` after the verdict and records its path in `findings.evidence`.
   * Omit to skip replay generation. Best-effort — the session wraps it fail-soft.
   */
  replay?: ReplayStep;
}

/** The lifecycle seams the session hands a {@link LoopRunner}: its inbox, progress sink, abort signal. */
export interface LoopRunContext {
  /** Mid-run messages, drained and cleared between steps (backs the session's `inbox`). */
  inbox: LoopInbox;
  /** Where the loop flushes its running step trail and final verdict (the findings store). */
  progress: ProgressWriter;
  /** Aborts the in-flight model/tool calls when the session closes (`end_session`). */
  signal: AbortSignal;
}

/**
 * Builds and runs the debug loop to its verdict, bound to the session's seams.
 * Assembled outside the session (model + belt + prompt) so the session stays
 * model-blind. Resolves once the driver `report`s (or the step cap trips), rejects
 * if aborted or if the agent fails. Its resolved value is ignored — the verdict is
 * read back from the findings store the `report` step wrote.
 */
export type LoopRunner = (context: LoopRunContext) => Promise<unknown>;
