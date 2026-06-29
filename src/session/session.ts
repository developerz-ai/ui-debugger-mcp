/**
 * Session — the per-run state container (no agent yet).
 *
 * One debug run = one `Session`. It holds the run's identity (`id`), the `story`
 * the smart agent handed over (+ optional pass/fail `criteria`), the live run
 * `status`, the queue of mid-run messages (`inbox`), the target `adapter`, and
 * the `findingsStore` that persists evidence to disk.
 *
 * This task is the container only — the debug agent loop is wired in later (PR6).
 * That wiring will drain the `inbox` between steps, push step/finding updates
 * through the store, and flip `status` to `passed`/`failed` on report or abort.
 * Here we expose just the surface the outer MCP tools need: `pushMessage()` to
 * inject work (`send_message`) and `snapshot()` to read the current verdict
 * (`get_findings`). `id` + `close()` make it a `ManagedSession` for the manager.
 */

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

/** Everything needed to construct a session. The agent loop is attached later (PR6). */
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
}

/**
 * Per-run state container, keyed into the manager by cwd. Structurally a
 * `ManagedSession` (exposes `id` + `close`).
 * @typeParam A - concrete adapter type; the session itself only needs `close()`.
 */
export class Session<A extends SessionAdapter = SessionAdapter> {
  readonly id: string;
  readonly story: string;
  readonly criteria?: string;

  readonly #adapter: A;
  readonly #findingsStore: FindingsStore;
  readonly #inbox: string[] = [];
  #status: SessionStatus = 'running';

  constructor(options: SessionOptions<A>) {
    this.id = options.id;
    this.story = options.story;
    this.criteria = options.criteria;
    this.#adapter = options.adapter;
    this.#findingsStore = options.findingsStore;
  }

  /** Current run status. `running` until the agent reports a verdict (PR6). */
  get status(): SessionStatus {
    return this.#status;
  }

  /** Pending mid-run messages, oldest first (defensive copy — drained by the agent in PR6). */
  get inbox(): readonly string[] {
    return [...this.#inbox];
  }

  /**
   * Queue a mid-run message for the agent (the `send_message` tool). The agent
   * folds these in between steps (PR6); here we only enqueue.
   */
  pushMessage(message: string): void {
    this.#inbox.push(message);
  }

  /**
   * Current findings view for `get_findings`: the persisted verdict (empty
   * until the agent writes one) with the live `status` overlaid. Pass `fields`
   * to project a subset (sparse read); omit for the whole findings object.
   */
  snapshot(): Promise<Findings>;
  snapshot(fields: readonly SnapshotField[]): Promise<Partial<Findings>>;
  async snapshot(fields?: readonly SnapshotField[]): Promise<Findings | Partial<Findings>> {
    const findings = await this.#currentFindings();
    if (!fields || fields.length === 0) return findings;
    return Object.fromEntries(
      fields.filter((field) => field in findings).map((field) => [field, findings[field]] as const),
    ) as Partial<Findings>;
  }

  /**
   * Release the run's resources — for now the target adapter. The agent loop's
   * abort signal is wired in here later (PR6). Called by the manager on
   * `end_session`.
   */
  async close(): Promise<void> {
    await this.#adapter.close();
  }

  /** Latest verdict: persisted findings if present, else an empty run, status overlaid. */
  async #currentFindings(): Promise<Findings> {
    const persisted = await this.#findingsStore.tryReadFindings();
    return persisted
      ? { ...persisted, status: this.#status }
      : { status: this.#status, steps: [], bugs: [], visual: [] };
  }
}
