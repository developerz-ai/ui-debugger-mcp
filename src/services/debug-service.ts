/**
 * Debug service — the business logic behind the five outer MCP tools.
 *
 * One conversational surface over one project (cwd): start a run, talk to it
 * mid-flight, poll its findings, list targets, end it. Holds the cwd-keyed
 * {@link SessionManager} (the one-run-per-project gate) and the resolved config,
 * and delegates the heavy session assembly to an injected {@link SessionBuilder}
 * seam — so the orchestration here unit-tests with no browser or network.
 *
 * One run per project holds *across processes* too: the manager only knows this
 * server's memory, so `start` also consults the `state.json` breadcrumb and
 * refuses when another live server already owns a run here (a dead owner's stale
 * breadcrumb never blocks). That read is the FRIENDLY early refusal; the
 * AUTHORITY is the workspace's exclusive ownership claim, taken atomically by
 * {@link FileStatePort.record} — two servers starting in the same window both
 * read "no foreign run", and only the claim admits one of them
 * ({@link SessionBusyError}, before a browser is launched).
 *
 * Sessions are keyed by cwd, but the tools speak `session_id`. Every id-bearing
 * call resolves the active session for the cwd and fails loud
 * ({@link SessionNotFoundError}) when the id does not match, so a stale id never
 * silently drives the wrong run.
 *
 * A run that ends *without* the caller asking (wall-clock timeout, SIGTERM, the
 * MCP client dying) leaves the manager, but its findings must not vanish with it:
 * the settled session is retained so `get_findings` keeps serving its terminal
 * snapshot. `end_session` is the explicit forget; the next `start_debug`
 * supersedes it. The snapshot holds no target resources and never gates a start.
 *
 * The pieces around this orchestration live in their own modules: the contract
 * types in `debug-api.ts` (re-exported here, so no importer changes), the catalog
 * projection in `catalog.ts`, the retained snapshot in `retained-snapshot.ts`
 * and the start-time refusals in `start-guards.ts`.
 */

import type { ResolvedConfig } from '../config/load.js';
import { SessionBusyError, SessionNotFoundError, SessionSettledError } from '../errors.js';
import { type Findings, FindingsSchema } from '../findings/schema.js';
import type { SessionManager } from '../session/manager.js';
import type { Session, SnapshotField } from '../session/session.js';
import { noopStatePort, type StatePort } from '../session/state-file.js';
import { generateSessionId, workspacePaths } from '../session/workspace.js';
import { selectTargets } from './catalog.js';
import type {
  Ack,
  DebugApi,
  DebugServiceDeps,
  DescribeInput,
  DescribeResult,
  EndInput,
  GetFindingsInput,
  RunInfo,
  SendInput,
  StartInput,
  StartResult,
} from './debug-api.js';
import { RetainedSnapshot } from './retained-snapshot.js';
import type { SessionBuilder } from './session-builder.js';
import { assertConfigFresh, assertNoForeignRun } from './start-guards.js';

// The contract types live in `debug-api.ts` — the service stays what callers import.
export type {
  Ack,
  DebugApi,
  DebugServiceDeps,
  DescribeInput,
  DescribeResult,
  EndInput,
  GetFindingsInput,
  RunInfo,
  SendInput,
  StartInput,
  StartResult,
  TargetInfo,
} from './debug-api.js';

/** Default wall-clock cap on a debug run before it auto-ends (overridable per run). */
export const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

/**
 * Narrow a findings object to the requested keys — the `fields` projection for a
 * snapshot read off disk (a live {@link Session} projects its own).
 */
function projectFindings(findings: Findings, fields: readonly SnapshotField[]): Partial<Findings> {
  const out: Partial<Findings> = {};
  for (const field of fields) {
    // Assigning key-by-key off a validated object; the index signature is what
    // makes this need the cast, not any doubt about the value's type.
    (out as Record<string, unknown>)[field] = findings[field];
  }
  return out;
}

export class DebugService implements DebugApi {
  readonly #manager: SessionManager<Session>;
  readonly #config: ResolvedConfig;
  readonly #cwd: string;
  readonly #build: SessionBuilder;
  readonly #state: StatePort;
  readonly #defaultTimeoutMs: number;
  readonly #now: () => number;
  readonly #platform: NodeJS.Platform;
  readonly #configChanged: () => boolean;
  /** Live wall-clock timer for the active run; cleared when the run ends. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The last run that auto-ended (timeout / SIGTERM / client death), kept settled
   * and closed so `get_findings` can still read its findings. Never a gate.
   */
  readonly #retained = new RetainedSnapshot();
  /**
   * The `start()` currently in flight (building/launching, slot not yet in the
   * manager), or `undefined`. Set synchronously before the first await so a
   * concurrent `start_debug` fails loud with {@link SessionBusyError} instead of
   * racing a second browser onto the same profile.
   *
   * `controller` cancels it at the next checkpoint and `settled` resolves once it
   * has torn down (it never rejects) — so {@link endActive} can abort a launch
   * *and wait for it*, instead of exiting with a half-launched Chrome on the lock.
   */
  #starting: { controller: AbortController; settled: Promise<void> } | undefined;

  constructor(deps: DebugServiceDeps) {
    this.#manager = deps.manager;
    this.#config = deps.config;
    this.#cwd = deps.cwd;
    this.#build = deps.build;
    this.#state = deps.state ?? noopStatePort;
    this.#defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.#now = deps.now ?? (() => Date.now());
    this.#platform = deps.platform ?? process.platform;
    this.#configChanged = deps.configChanged ?? (() => false);
  }

  /**
   * Open a run: assemble the session, take the profile lock, point the adapter at
   * the target, and kick the loop off in the background. Fails loud if a run is
   * already active for this cwd ({@link SessionBusyError}) — whether it belongs to
   * this server (the manager / in-flight guard) or to another live one (the
   * `state.json` breadcrumb read, and then the workspace's ownership claim);
   * never leaks a launched browser — a lost lock race or a failed `open` tears
   * the session back down.
   *
   * `timeout` is wall-clock from HERE: the deadline is fixed on entry and the
   * remaining budget is threaded into the build and the first navigation, so a slow
   * Chrome launch spends the caller's cap instead of sitting outside it.
   *
   * The refusal is the default; `replace: true` is the caller's explicit takeover.
   * Either way the caller has a way forward: the refusal names the active id and
   * the calls that read, close or replace it, and `describe` reports that id.
   */
  async start(input: StartInput): Promise<StartResult> {
    const cwd = this.#cwd;
    // Checked first, and synchronously (no await before `#starting` is set) — a
    // concurrent start must fail here, not launch a second browser on the same
    // profile. Ahead of `replace` on purpose: a run still opening owns no manager
    // slot to hand over, and racing its teardown orphans a half-launched Chrome.
    if (this.#starting !== undefined) {
      throw new SessionBusyError(
        `A debug session is already starting for '${cwd}' — one run per project at a time. ` +
          'Wait a moment for it to open, then describe() names it, ' +
          'get_findings({session_id}) reads it, and end_session({session_id}) closes it.',
      );
    }
    if (this.#manager.has(cwd) && input.replace !== true) {
      const active = this.#manager.get(cwd).id;
      throw new SessionBusyError(
        `A debug session ('${active}') is already active for '${cwd}' — one run per project at a ` +
          `time. Read what it is doing with get_findings({session_id:'${active}'}), close it with ` +
          `end_session({session_id:'${active}'}), or take the project over with ` +
          'start_debug({…, replace:true}), which ends that run first. describe() reports this id ' +
          'at any time, so a lost session id never wedges the project.',
      );
    }
    // The previous run's teardown is still in flight: the manager freed its slot,
    // but its close has not settled, so the profile/browser it held is mid-release.
    // Launching now would race the ending run for those resources — refuse until
    // the gate lifts, naming what the caller waits on.
    const closing = this.#manager.closingId(cwd);
    if (closing !== undefined) {
      throw new SessionBusyError(
        `The previous debug session ('${closing}') for '${cwd}' is still closing — its ` +
          'teardown is releasing the profile lock. Wait a moment, then retry.',
      );
    }
    // Before anything is launched: a run built from config the caller has already
    // replaced is worse than no run — it reproduces the very failure they just fixed.
    assertConfigFresh(this.#configChanged);
    const deadline = this.#now() + (input.timeoutMs ?? this.#defaultTimeoutMs);
    const controller = new AbortController();
    const attempt = this.#launch(input, deadline, controller.signal);
    // Registered before anyone awaits `attempt`, and swallowing its outcome: this
    // handle is a teardown *barrier* for `endActive`, never a second failure path.
    this.#starting = {
      controller,
      settled: attempt.then(
        () => undefined,
        () => undefined,
      ),
    };
    try {
      return await attempt;
    } finally {
      this.#starting = undefined;
    }
  }

  /**
   * The launch itself: breadcrumb, build, lock, open, arm. Every await is a
   * cancellation checkpoint — `signal` is the shutdown path asking this start to
   * stop — and every failure tears down whatever came up and drops the
   * breadcrumb, so nothing is left holding the project's profile lock.
   */
  async #launch(
    { target, goal, criteria, url, as, replace }: StartInput,
    deadline: number,
    signal: AbortSignal,
  ): Promise<StartResult> {
    const cwd = this.#cwd;
    /** Budget left on the caller's cap; never negative — a blown budget is simply spent. */
    const remaining = (): number => Math.max(0, deadline - this.#now());

    // The friendly early refusal: another live server's breadcrumb already names a
    // run here. It is a READ, so two servers in the same window can both see "no
    // foreign run" — the AUTHORITATIVE admission is the claim `state.record()` takes.
    await assertNoForeignRun(this.#state, cwd);
    // The caller asked to take the project over. Before the breadcrumb, so the
    // takeover's `clear()` cannot wipe the record of the run replacing it.
    if (replace === true) await this.#takeOverActive();
    const id = generateSessionId(this.#now());
    // The breadcrumb goes down BEFORE the launch: a cold Chrome start takes 5-20s,
    // and until `state.json` exists the run is invisible out-of-band — `status`
    // prints "no debug run recorded" and `stop` never signals, while a real browser
    // already holds the profile lock. It fails loud (a run the CLI cannot see is a
    // run nobody can stop) — and here that costs nothing: nothing is launched yet.
    //
    // Writing it also TAKES the workspace's ownership claim, the real gate: a live
    // foreign owner refuses this write with {@link SessionBusyError} (naming its
    // pid and session), so the loser never hides the winner's live run.
    await this.#state.record({ sessionId: id, target, goal });

    try {
      this.#assertStartNotAborted(signal, id);
      const built = await this.#build({
        id,
        target,
        goal,
        criteria,
        url,
        as,
        timeoutMs: remaining(),
      });

      try {
        this.#assertStartNotAborted(signal, id);
        this.#manager.start(cwd, built.session);
      } catch (err) {
        await built.session.close().catch(() => undefined);
        throw err;
      }
      // This run owns the slot now — the previous run's retained snapshot is
      // superseded (its findings.json stays on disk for the CLI / a human).
      this.#retained.clear();

      try {
        await built.open(remaining());
        this.#assertStartNotAborted(signal, id);
        built.session.start(built.run);
      } catch (err) {
        await this.#manager.end(cwd).catch(() => undefined);
        throw err;
      }

      // Armed last, on what is LEFT of the cap: the launch already spent part of
      // the budget, and nothing past this point can fail and strand the timer.
      this.#armTimeout(remaining());
      return { session_id: id };
    } catch (err) {
      // Nobody holds this id, so nothing could ever end the run — leave no
      // `running` breadcrumb pointing the CLI at a gone run. Scoped to THIS
      // attempt's id: a successor that recorded itself meanwhile keeps its own.
      await this.#state.clear(id).catch(() => undefined);
      throw err;
    }
  }

  /**
   * Stop a start that the shutdown path has cancelled (SIGTERM, a CLI `stop`, the
   * MCP client dying). The caller tears down whatever it had already built.
   */
  #assertStartNotAborted(signal: AbortSignal, id: string): void {
    if (!signal.aborted) return;
    throw new SessionSettledError(
      `Debug run '${id}' was torn down while it was still starting — this ui-debugger-mcp server ` +
        'is shutting down (SIGTERM, `ui-debugger-mcp stop`, or the MCP client disconnected). ' +
        'Nothing was left running; start again once the server is back.',
    );
  }

  /**
   * `replace: true` — end the run this server holds so the new one can have it.
   * No-op when nothing is active: replacing nothing is just a start.
   *
   * Deliberately routed through {@link end}, the very method `end_session` calls:
   * releasing a target correctly means the managed browser is STOPPED while an
   * attached one is only DISCONNECTED, the timer is cleared and the breadcrumb
   * dropped — a second implementation of that would drift, and the drift would
   * show up as a leaked Chrome on the profile lock.
   */
  async #takeOverActive(): Promise<void> {
    if (!this.#manager.has(this.#cwd)) return;
    await this.end({ session_id: this.#manager.get(this.#cwd).id });
  }

  /**
   * Arm the wall-clock cap on what is LEFT of the run's budget: auto-end the run
   * when it fires (replacing any prior timer). `0` — the launch outlived the whole
   * cap — ends the run on the next tick, not with a fresh one.
   */
  #armTimeout(ms: number): void {
    this.#clearTimeout();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.endActive().catch(() => undefined);
    }, ms);
  }

  /** Cancel the active run's wall-clock timer, if any. */
  #clearTimeout(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Queue a mid-run instruction for the active run's driver. Fails loud
   * ({@link SessionSettledError}) once the run has settled — the loop no longer
   * drains the inbox, so an ack then would drop the message.
   */
  send({ session_id, message }: SendInput): Ack {
    const session = this.#require(session_id);
    if (session.status !== 'running') {
      throw new SessionSettledError(
        `Debug run '${session_id}' has already settled ('${session.status}') — the driver is no ` +
          'longer listening. Read its results with get_findings, or start a new run with start_debug.',
      );
    }
    session.pushMessage(message);
    return { ok: true, session_id };
  }

  /**
   * Snapshot the run's findings — optionally long-poll (`wait`) and/or project a
   * subset (`fields`). Serves the retained terminal snapshot once the run has
   * auto-ended, so a timed-out run's findings stay reachable.
   */
  async getFindings({
    session_id,
    wait,
    fields,
  }: GetFindingsInput): Promise<Findings | Partial<Findings>> {
    let session: Session;
    try {
      session = this.#requireReadable(session_id);
    } catch (error) {
      // Our own memory has no such run — but another live server on this project
      // might, and `start_debug` has already named that session to this caller.
      // Answering "no such session" there is a contradiction; serve what it flushed.
      const foreign = await this.#foreignSnapshot(session_id);
      if (foreign) return fields ? projectFindings(foreign, fields) : foreign;
      throw error;
    }
    return fields ? session.snapshot(fields, wait) : session.snapshot(undefined, wait);
  }

  /**
   * A foreign run's findings as last flushed to disk, or `null` if this id names no
   * such run — we do not own that run, so there is nothing to long-poll.
   */
  async #foreignSnapshot(session_id: string): Promise<Findings | null> {
    const raw = await this.#state.foreignFindings(session_id);
    if (raw === null) return null;
    const parsed = FindingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** List configured targets (the whole catalog, or one when named) plus resolved models/workspace. */
  describe({ target }: DescribeInput): DescribeResult {
    const targets = selectTargets(this.#config.targets, target, this.#platform);
    const session = this.#currentRun();
    return {
      targets,
      models: this.#config.models,
      // The RESOLVED per-project root, not the raw config string (a directory short).
      workspace: workspacePaths(this.#cwd, this.#config.workspace).root,
      ...(session && { session }),
    };
  }

  /**
   * The run this server holds for the project — the active one, or the retained
   * snapshot of the last run that auto-ended (both readable, both `end_session`-able
   * by their id). `undefined` when there is none.
   *
   * The in-band answer to a lost `session_id`: without it a compacted caller could
   * neither read the run nor close it, and the only recovery left was the out-of-band
   * CLI. A start still in flight is not reported — it has no id yet.
   */
  #currentRun(): RunInfo | undefined {
    const session = this.#manager.has(this.#cwd)
      ? this.#manager.get(this.#cwd)
      : this.#retained.peek();
    if (session === undefined) return undefined;
    return { id: session.id, status: session.status, goal: session.story };
  }

  /**
   * End the active run: abort the loop, close the adapter, free the profile lock.
   * Ending a run that already auto-ended is not an error — it just forgets the
   * retained snapshot, so `end_session` stays the one explicit forget.
   */
  async end({ session_id }: EndInput): Promise<Ack> {
    if (this.#forgetRetained(session_id)) return { ok: true, session_id };
    this.#require(session_id);
    this.#clearTimeout();
    try {
      await this.#manager.end(this.#cwd);
    } finally {
      // Clear the breadcrumb even when the close throws: the manager frees the slot
      // before closing, so a stale `running` state.json would make a later CLI
      // `stop` SIGTERM a healthy server. The close error still propagates. Scoped
      // to `session_id` — `#require` verified it — so a successor that records
      // itself while this teardown is in flight is untouched.
      await this.#state.clear(session_id);
    }
    return { ok: true, session_id };
  }

  /**
   * End whatever run is active for this cwd, if any — the graceful-shutdown path
   * for a SIGTERM/SIGINT, a CLI `stop`, or the wall-clock timeout firing.
   */
  async endActive(): Promise<void> {
    this.#clearTimeout();
    // A start still in flight owns no manager slot yet, so the check below would
    // sail straight past a Chrome that is mid-launch: cancel it and WAIT for its
    // teardown, or the process exits with a browser on the profile lock.
    const starting = this.#starting;
    if (starting !== undefined) {
      starting.controller.abort();
      await starting.settled;
    }
    if (!this.#manager.has(this.#cwd)) return;
    // Nobody asked for this end, so nobody has read the results yet: retain the
    // session (settled + closed) so `get_findings` still serves them. Captured
    // before the close, so a failing teardown leaves them reachable anyway.
    const ending = this.#manager.get(this.#cwd);
    this.#retained.retain(ending);
    // Same contract as `end()`: the breadcrumb clears even when the close throws —
    // scoped to the run being ENDED, never a successor's.
    try {
      await this.#manager.end(this.#cwd);
    } finally {
      await this.#state.clear(ending.id);
    }
  }

  /**
   * Resolve the session a read names: the active run, or — once the manager is
   * empty — the retained snapshot of the last auto-ended run. A different id fails loud.
   */
  #requireReadable(session_id: string): Session {
    if (this.#manager.has(this.#cwd) || this.#retained.peek() === undefined) {
      return this.#require(session_id);
    }
    return this.#retained.requireRetained(session_id, this.#cwd);
  }

  /**
   * Forget the retained snapshot when the caller's `end_session` names it — the run
   * is already torn down. Returns whether the id was the retained one.
   */
  #forgetRetained(session_id: string): boolean {
    if (this.#manager.has(this.#cwd)) return false;
    return this.#retained.forget(session_id);
  }

  /** Resolve the active session for this cwd, asserting its id matches the caller's. */
  #require(session_id: string): Session {
    const session = this.#manager.get(this.#cwd);
    if (session.id !== session_id) {
      throw new SessionNotFoundError(
        `No active debug session '${session_id}' for '${this.#cwd}' (active session is '${session.id}').`,
      );
    }
    return session;
  }
}
