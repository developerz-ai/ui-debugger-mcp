/**
 * Session — the per-run state container plus the debug agent's background run.
 *
 * One debug run = one `Session`. It holds the run's identity (`id`), the `story`
 * the smart agent handed over (+ optional pass/fail `criteria`), the live run
 * `status`, the queue of mid-run messages (`inbox`), the target `adapter`, and
 * the `findingsStore` that persists evidence to disk.
 *
 * `start()` kicks the debug agent loop off as a **background task** (non-blocking)
 * so the outer MCP tools stay live while it runs: `pushMessage()` injects work
 * (`send_message`) into the `inbox` the loop drains between steps, and `snapshot()`
 * reads the progress (`get_findings`) the loop flushes incrementally — optionally
 * long-polling (`wait`) until the run settles its verdict. When the
 * loop concludes, the session settles `status` from `running` to the terminal
 * verdict the `report` step wrote to disk (`passed`/`failed`); a run aborted by
 * `close()` (`end_session`) settles as `failed`; an agent crash settles as
 * `failed` and is surfaced into the findings as an {@link AgentError}, so
 * `get_findings` shows what went wrong instead of an empty verdict.
 *
 * The loop itself is assembled outside the session (model + belt + prompt) and
 * handed to `start()` as a {@link LoopRunner}. The session stays model- and
 * adapter-blind: it owns only the loop's *lifecycle* — its inbox seam, its
 * progress sink (the findings store), its abort signal, and the status it settles
 * into. `id` + `close()` make it a `ManagedSession` for the manager.
 */

import type { LoopInbox, ProgressWriter } from '../agent/loop.js';
import { AgentError } from '../errors.js';
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
 * skips gracefully when absent — never crashing teardown.
 */
export type ReplayStep = () => Promise<ReplayOutcome>;

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

/**
 * Per-run state container + background agent run, keyed into the manager by cwd.
 * Structurally a `ManagedSession` (exposes `id` + `close`).
 * @typeParam A - concrete adapter type; the session itself only needs `close()`.
 */
export class Session<A extends SessionAdapter = SessionAdapter> {
  readonly id: string;
  readonly story: string;
  readonly criteria?: string;

  readonly #adapter: A;
  readonly #findingsStore: FindingsStore;
  /** The summary actor, or `undefined` when no summarizer was wired (driver's summary stands). */
  readonly #summarize: SummarizeStep | undefined;
  /** The replay generator, or `undefined` when none was wired (no `replay.mp4` is produced). */
  readonly #replay: ReplayStep | undefined;
  readonly #inbox: string[] = [];
  readonly #abort = new AbortController();
  /** The background loop run, set once by `start()`; `null` until then. */
  #run: Promise<void> | null = null;
  #status: SessionStatus = 'running';

  constructor(options: SessionOptions<A>) {
    this.id = options.id;
    this.story = options.story;
    this.criteria = options.criteria;
    this.#adapter = options.adapter;
    this.#findingsStore = options.findingsStore;
    this.#summarize = options.summarize;
    this.#replay = options.replay;
  }

  /** Current run status. `running` until the loop settles a verdict (`passed`/`failed`). */
  get status(): SessionStatus {
    return this.#status;
  }

  /** Pending mid-run messages, oldest first (defensive copy; the loop drains them while running). */
  get inbox(): readonly string[] {
    return [...this.#inbox];
  }

  /**
   * Queue a mid-run message for the agent (the `send_message` tool). The loop
   * folds these in between steps; here we only enqueue.
   */
  pushMessage(message: string): void {
    this.#inbox.push(message);
  }

  /**
   * Start the debug agent loop as a background task (non-blocking): it runs to its
   * verdict while the outer tools stay responsive, and the session settles
   * `status` when it finishes. Returns the run promise for teardown/tests; normal
   * callers fire-and-forget it. Call once per session.
   * @throws {AgentError} if the loop has already been started.
   */
  start(runLoop: LoopRunner): Promise<void> {
    if (this.#run !== null) {
      throw new AgentError(`Session '${this.id}' is already running; start() may be called once.`);
    }
    this.#run = this.#execute(runLoop);
    return this.#run;
  }

  /**
   * Current findings view for `get_findings`: the persisted verdict (empty until
   * the loop writes one) with the live `status` overlaid. Pass `fields` to project
   * a subset (sparse read); omit for the whole findings object.
   *
   * Pass `wait` (ms) to long-poll: while the run is still `running`, the call
   * blocks until the loop settles a terminal verdict or `wait` elapses (whichever
   * comes first), then reads — so `get_findings` can wait out a near-done run
   * instead of busy-polling. Omit `wait` (or pass `0`) to read immediately. A run
   * that has already settled, or one not yet `start()`ed, returns at once.
   */
  snapshot(fields?: undefined, wait?: number): Promise<Findings>;
  snapshot(fields: readonly SnapshotField[], wait?: number): Promise<Partial<Findings>>;
  async snapshot(
    fields?: readonly SnapshotField[],
    wait?: number,
  ): Promise<Findings | Partial<Findings>> {
    if (wait !== undefined && wait > 0) await this.#waitForVerdict(wait);
    const findings = await this.#currentFindings();
    if (!fields || fields.length === 0) return findings;
    return Object.fromEntries(
      fields.filter((field) => field in findings).map((field) => [field, findings[field]] as const),
    ) as Partial<Findings>;
  }

  /**
   * Release the run's resources: abort the loop, wait for it to settle, then close
   * the target adapter. Called by the manager on `end_session`. A run still in
   * flight settles as `failed` (it never reached a verdict). Closing after a run
   * already concluded leaves its verdict untouched.
   */
  async close(): Promise<void> {
    this.#abort.abort();
    if (this.#run !== null) await this.#run;
    await this.#adapter.close();
  }

  /** Run the loop to settlement, then fold its outcome into `status` (+ findings on failure). */
  async #execute(runLoop: LoopRunner): Promise<void> {
    try {
      await runLoop({
        inbox: { drain: () => this.#drainInbox() },
        progress: this.#findingsStore,
        signal: this.#abort.signal,
      });
      // Aborted by `close()` but the loop resolved anyway (observed the signal and
      // returned instead of rejecting): honor the teardown contract — an aborted run
      // settles `failed`, never the verdict it may have written just before close.
      if (this.#abort.signal.aborted) {
        this.#status = 'failed';
        return;
      }
      this.#status = await this.#verdict();
      // Best-effort, non-blocking: race the summary against the abort signal so a
      // hung summary model can never stall `close()` (which aborts, then awaits the
      // run). A natural finish awaits it fully; teardown short-circuits the wait.
      await this.#raceAbort(this.#ensureSummary());
      // Then stitch the ordered screenshots into a captioned replay.mp4, recording
      // its path in findings.evidence — same best-effort, abort-raced contract, run
      // after the summary so its write-back preserves it.
      await this.#raceAbort(this.#ensureReplay());
    } catch (error) {
      this.#status = 'failed';
      // Aborted by `close()` — the teardown is the verdict; nothing to surface.
      if (this.#abort.signal.aborted) return;
      await this.#surfaceAgentError(error);
    }
  }

  /** Hand the loop every pending message and clear the queue (the `LoopInbox` seam over `#inbox`). */
  #drainInbox(): readonly string[] {
    return this.#inbox.splice(0, this.#inbox.length);
  }

  /**
   * Fill `findings.summary` with the summary actor's paragraph when the driver left
   * it empty (and a summarizer is wired). Best-effort and non-blocking: any failure
   * is swallowed so a missing summary never delays teardown — the verdict already
   * stands and `get_findings` falls back to the driver's own summary (if any). Writes
   * back under the settled terminal `status`, never a stale `running`.
   */
  async #ensureSummary(): Promise<void> {
    if (this.#summarize === undefined) return;
    try {
      const findings = await this.#findingsStore.tryReadFindings();
      if (findings === null || hasText(findings.summary)) return;
      // Summarize the terminal record: `#verdict()` may have settled `status` to a
      // value the persisted findings don't yet carry (e.g. `failed` over a stale
      // `running`), so the digest must reflect the final verdict, not the disk copy.
      const terminalFindings = { ...findings, status: this.#status };
      // Threaded abort: `#raceAbort` stops WAITING on teardown, but only the signal
      // actually cancels the in-flight model call instead of leaving it dangling.
      const summary = await this.#summarize(terminalFindings, this.#abort.signal);
      if (!hasText(summary)) return;
      await this.#findingsStore.writeFindings({ ...terminalFindings, summary });
    } catch {
      // Fail soft: the verdict stands; the driver's own summary (if any) is the fallback.
    }
  }

  /**
   * Stitch the run's ordered screenshots into a captioned `replay.mp4` and record
   * its path in `findings.evidence` — PR evidence the smart agent can attach. Runs
   * after the verdict (and after the summary, so its write-back preserves the
   * summary). Best-effort and fail-soft: no frames, a missing ffmpeg, or any stitch
   * failure is swallowed so the replay never delays teardown or overturns the
   * verdict. A `skipped` outcome with a `note` (e.g. ffmpeg absent) is recorded as a
   * step so the missing video is explained, not silent. Writes back under the settled
   * terminal `status`, never a stale `running`.
   */
  async #ensureReplay(): Promise<void> {
    if (this.#replay === undefined) return;
    try {
      const outcome = await this.#replay();
      if (outcome.kind === 'skipped') {
        if (outcome.note !== undefined) await this.#noteReplaySkipped(outcome.note);
        return;
      }
      const findings = await this.#findingsStore.tryReadFindings();
      if (findings === null) return;
      await this.#findingsStore.writeFindings({
        ...findings,
        status: this.#status,
        evidence: outcome.path,
      });
    } catch {
      // Fail soft: replay is best-effort PR evidence; the verdict always stands.
    }
  }

  /**
   * Record a skipped replay as a `skipped` (NOT failed) step in the findings so
   * `get_findings` explains the absent `replay.mp4` without making a clean run
   * read as broken — replay is optional PR evidence, and a missing ffmpeg is not
   * a test failure. `ok` stays true; `skipped` + `note` carry the reason (the loud
   * `agent.log` line is written upstream in the replay step). Preserves the
   * existing trail + summary; writes under the settled terminal `status`.
   * Best-effort — wrapped by `#ensureReplay`'s catch.
   */
  async #noteReplaySkipped(note: string): Promise<void> {
    const findings = await this.#findingsStore.tryReadFindings();
    if (findings === null) return;
    await this.#findingsStore.writeFindings({
      ...findings,
      status: this.#status,
      steps: [...findings.steps, { step: 'replay video', ok: true, skipped: true, note }],
    });
  }

  /**
   * Await `promise`, but stop waiting the moment the session aborts — so the
   * best-effort summary can never keep `close()` (which aborts, then awaits the run)
   * blocked on a hung model. The in-flight call is abandoned, not cancelled; the
   * verdict already stands, so dropping the summary is the documented fail-soft.
   */
  async #raceAbort(promise: Promise<void>): Promise<void> {
    const { signal } = this.#abort;
    if (signal.aborted) return;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        promise,
        new Promise<void>((resolve) => {
          onAbort = () => resolve();
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  /** The terminal verdict the `report` step wrote; `failed` if the run ended without one. */
  async #verdict(): Promise<'passed' | 'failed'> {
    const findings = await this.#findingsStore.tryReadFindings();
    return findings && findings.status !== 'running' ? findings.status : 'failed';
  }

  /** Write a `failed` verdict carrying the agent failure so `get_findings` surfaces it. */
  async #surfaceAgentError(error: unknown): Promise<void> {
    const agentError = toAgentError(error);
    const prior = await this.#findingsStore.tryReadFindings().catch(() => null);
    try {
      await this.#findingsStore.writeFindings({
        status: 'failed',
        steps: prior?.steps ?? [],
        bugs: prior?.bugs ?? [],
        visual: prior?.visual ?? [],
        summary: `Debug run failed: ${agentError.message}`,
      });
    } catch {
      // Best-effort surfacing — `status` is already `failed`, so the loud signal stands.
    }
  }

  /**
   * Block until the background run settles a terminal verdict or `timeoutMs`
   * elapses, whichever comes first (the `snapshot` long-poll). No-op when the run
   * already settled (status is no longer `running`) or was never `start()`ed
   * (`#run` is null) — neither changes on its own, so there is nothing to wait
   * for. The run promise never rejects (`#execute` folds failures into `status`),
   * so the race is safe; the timer is always cleared so a fast verdict leaves no
   * dangling handle.
   */
  async #waitForVerdict(timeoutMs: number): Promise<void> {
    const run = this.#run;
    if (run === null || this.#status !== 'running') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Latest verdict: persisted findings if present, else an empty run, status overlaid. */
  async #currentFindings(): Promise<Findings> {
    const persisted = await this.#findingsStore.tryReadFindings();
    return persisted
      ? { ...persisted, status: this.#status }
      : { status: this.#status, steps: [], bugs: [], visual: [] };
  }
}

/** Normalize any thrown value into an {@link AgentError} (passing an existing one through). */
function toAgentError(error: unknown): AgentError {
  if (error instanceof AgentError) return error;
  return new AgentError(error instanceof Error ? error.message : String(error));
}

/** True when `value` is a non-blank string (a real summary, not absent or whitespace). */
function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
