/**
 * Debug service — the business logic behind the five outer MCP tools.
 *
 * One conversational surface over one project (cwd): start a run, talk to it
 * mid-flight, poll its findings, list targets, end it. Holds the cwd-keyed
 * {@link SessionManager} (the one-run-per-project gate) and the resolved config,
 * and delegates the heavy session assembly to an injected {@link SessionBuilder}
 * seam — so the orchestration here unit-tests with no browser or network. The MCP
 * handlers stay thin: validate input, call straight through to a method here.
 *
 * One run per project holds *across processes* too: the manager only knows this
 * server's memory, so `start` also consults the `state.json` breadcrumb and
 * refuses when another live server already owns a run here (a dead owner's stale
 * breadcrumb never blocks).
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
 * supersedes it. The retained snapshot holds no target resources (the adapter is
 * already closed) and never participates in the one-run gate.
 */

import { CONFIG_FILENAME, type ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import {
  ConfigError,
  SessionBusyError,
  SessionNotFoundError,
  SessionSettledError,
  TargetNotFoundError,
} from '../errors.js';
import { type Findings, FindingsSchema } from '../findings/schema.js';
import type { SessionManager } from '../session/manager.js';
import type { Session, SnapshotField } from '../session/session.js';
import { noopStatePort, type StatePort } from '../session/state-file.js';
import { generateSessionId, workspacePaths } from '../session/workspace.js';
import type { SessionBuilder } from './session-builder.js';

/** Default wall-clock cap on a debug run before it auto-ends (overridable per run). */
export const DEFAULT_SESSION_TIMEOUT_MS = 300_000;

/** `start_debug` input — open a run for a configured target. */
export interface StartInput {
  target: string;
  goal: string;
  criteria?: string;
  /** Per-run URL the caller points the driver at (web); overrides the target's configured url. */
  url?: string;
  /**
   * Named auth persona to open the run as — a key in the target's `auth` map. The
   * run signs in out-of-band before the driver's first step; an unknown key fails
   * loud rather than running the goal signed out.
   */
  as?: string;
  /**
   * Wall-clock cap (ms) before the run auto-ends, counted from THIS call — assembly,
   * launch and the first navigation spend it too. Defaults to
   * {@link DEFAULT_SESSION_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}

/** `start_debug` output — the id to poll/redirect/end the run by. */
export interface StartResult {
  session_id: string;
}

/** `send_message` input — inject a mid-run instruction. */
export interface SendInput {
  session_id: string;
  message: string;
}

/** `send_message` / `end_session` acknowledgement. */
export interface Ack {
  ok: true;
  session_id: string;
}

/** `get_findings` input — snapshot (optionally long-poll / project a subset). */
export interface GetFindingsInput {
  session_id: string;
  wait?: number;
  fields?: SnapshotField[];
}

/** `describe` input — the whole catalog, or one target when named. */
export interface DescribeInput {
  target?: string;
}

/** One target's public shape in the catalog (secrets stay out). */
export interface TargetInfo {
  name: string;
  adapter: Target['adapter'];
  /** `managed` = the server launches/owns it; `attach` = it connects to a running one. */
  mode: 'managed' | 'attach';
  /** Whether this adapter is wired. All three (browser/desktop/android) are shipped. */
  operational: boolean;
  /** Web target entry url, when applicable. */
  url?: string;
  /** Web headless flag, when applicable. */
  headless?: boolean;
  /**
   * Named auth personas configured for this target — the valid `start_debug({as})`
   * values. NAMES ONLY; the credentials never leave `.ui-debugger-mcp.json`.
   * Absent when the target has no `auth` block.
   */
  personas?: string[];
}

/** `describe` output — configured targets plus the resolved models + workspace. */
export interface DescribeResult {
  targets: TargetInfo[];
  models: { driver: string; vision: string; summary: string };
  /** Resolved per-project workspace root (`<base>/<project>`) — where evidence lands. */
  workspace: string;
}

/** The surface the outer MCP tools call. Implemented by {@link DebugService}. */
export interface DebugApi {
  start(input: StartInput): Promise<StartResult>;
  send(input: SendInput): Ack;
  getFindings(input: GetFindingsInput): Promise<Findings | Partial<Findings>>;
  describe(input: DescribeInput): DescribeResult;
  end(input: EndInput): Promise<Ack>;
}

/** `end_session` input. */
export interface EndInput {
  session_id: string;
}

/** Everything the service needs, wired at boot. */
export interface DebugServiceDeps {
  /** The cwd-keyed registry (one run per project). */
  manager: SessionManager<Session>;
  /** Resolved project config — backs `describe` + target validation. */
  config: ResolvedConfig;
  /** This project's session key (one project = one cwd = one session). */
  cwd: string;
  /** Seam to the heavy session assembly; injected so `start` stays testable. */
  build: SessionBuilder;
  /** Cross-process run breadcrumb (`state.json`) for the CLI; defaults to a no-op. */
  state?: StatePort;
  /** Default wall-clock cap (ms) for a run; defaults to {@link DEFAULT_SESSION_TIMEOUT_MS}. */
  defaultTimeoutMs?: number;
  /** Injected clock (epoch ms) for session ids + the run deadline; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Has `.ui-debugger-mcp.json` changed since boot? Config is resolved once and
   * wired into long-lived objects, so a changed file means every later run would
   * silently use the OLD settings — see `config/fingerprint.ts`. Defaults to
   * "never changed" (unit tests hold no file).
   */
  configChanged?: () => boolean;
}

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
  readonly #configChanged: () => boolean;
  /** Live wall-clock timer for the active run; cleared when the run ends. */
  #timer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The last run that auto-ended (timeout / SIGTERM / client death), kept settled
   * and closed so `get_findings` can still read its partial findings + evidence.
   * Dropped by `end_session` (the explicit forget) and superseded by the next run.
   * Never consulted by the one-run gate — a retained snapshot cannot block a start.
   */
  #retained: Session | undefined;
  /**
   * The `start()` currently in flight (building/launching, slot not yet in the
   * manager), or `undefined`. Set synchronously before the first await so a
   * concurrent `start_debug` fails loud with {@link SessionBusyError} instead of
   * racing a second browser onto the same profile.
   *
   * `controller` cancels it at the next checkpoint and `settled` resolves once it
   * has finished tearing down (it never rejects) — so {@link endActive} can abort a
   * launch *and wait for it*, instead of finding an empty manager and letting the
   * process exit with a half-launched Chrome still holding the profile lock.
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
    this.#configChanged = deps.configChanged ?? (() => false);
  }

  /**
   * Open a run: assemble the session, take the profile lock, point the adapter at
   * the target, and kick the loop off in the background. Fails loud if a run is
   * already active for this cwd ({@link SessionBusyError}) — whether it belongs to
   * this server (the manager / in-flight guard) or to another live one (the
   * `state.json` breadcrumb); never leaks a launched browser — a lost lock race or
   * a failed `open` tears the session back down.
   *
   * `timeout` is wall-clock from HERE: the deadline is fixed on entry and the
   * remaining budget is threaded into the build and the first navigation, so a slow
   * Chrome launch spends the caller's cap instead of sitting outside it.
   */
  async start(input: StartInput): Promise<StartResult> {
    const cwd = this.#cwd;
    if (this.#manager.has(cwd)) {
      throw new SessionBusyError(
        `A debug session ('${this.#manager.get(cwd).id}') is already active for '${cwd}'. ` +
          'End it before starting another — one run per project at a time.',
      );
    }
    // Taken synchronously (no await since the has() check) — a concurrent start
    // must fail here, not launch a second browser on the same profile.
    if (this.#starting !== undefined) {
      throw new SessionBusyError(
        `A debug session is already starting for '${cwd}'. ` +
          'Wait for it to open (or end it) before starting another — one run per project at a time.',
      );
    }
    // Before anything is launched: a run built from config the caller has already
    // replaced is worse than no run — it reproduces the very failure they just fixed.
    this.#assertConfigFresh();
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
   * stop — and every failure (including a cancellation) tears down whatever
   * already came up and drops the breadcrumb, so nothing is left holding the
   * project's profile lock.
   */
  async #launch(
    { target, goal, criteria, url, as }: StartInput,
    deadline: number,
    signal: AbortSignal,
  ): Promise<StartResult> {
    const cwd = this.#cwd;
    /** Budget left on the caller's cap; never negative — a blown budget is simply spent. */
    const remaining = (): number => Math.max(0, deadline - this.#now());

    await this.#assertNoForeignRun(cwd);
    const id = generateSessionId(this.#now());
    // The breadcrumb goes down BEFORE the launch, not after it: a cold Chrome start
    // takes 5-20s, and until `state.json` exists the run is invisible out-of-band —
    // `status` prints "no debug run recorded" and `stop` never signals, while a real
    // browser already holds the profile lock. It fails loud (a run the CLI cannot
    // see is a run nobody can stop) — and here that costs nothing, since not one
    // process has been launched yet.
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
      this.#retained = undefined;

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
      // `running` breadcrumb pointing the CLI at a run that is already gone.
      await this.#state.clear().catch(() => undefined);
      throw err;
    }
  }

  /**
   * Stop a start that the shutdown path has cancelled (SIGTERM, a CLI `stop`, the
   * MCP client dying). The caller tears down whatever it had already built —
   * teardown is exactly what the abort is for.
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
   * Refuse to start on config this server can no longer honour.
   *
   * The message names the one action that works. Without it the caller edits the
   * file, sees the identical failure, and has no way to tell a bad fix from an
   * unread one — which is exactly how a real session burned two runs.
   */
  #assertConfigFresh(): void {
    if (!this.#configChanged()) return;
    throw new ConfigError(
      `${CONFIG_FILENAME} changed on disk after this ui-debugger-mcp server started, so a run now ` +
        'would still use the OLD settings (models, targets, urls are read once at boot). ' +
        'Restart the MCP server to pick the new config up — in Claude Code, /mcp → reconnect ' +
        'ui-debugger, or restart the session.',
    );
  }

  /**
   * The other half of the one-run gate: another *live* server process holding a
   * run on this project. The manager only sees this process's memory, so without
   * this a second MCP client on the same cwd would launch a second run onto the
   * same profile/emulator and overwrite the live breadcrumb (leaving the CLI
   * pointing at the wrong pid). A dead or PID-recycled owner does not count — a
   * crashed server's stale `running` file must never wedge the project shut.
   */
  async #assertNoForeignRun(cwd: string): Promise<void> {
    const foreign = await this.#state.foreignRun();
    if (foreign === null) return;
    throw new SessionBusyError(
      `Another ui-debugger-mcp server (pid ${foreign.pid}) already has a debug session ` +
        `('${foreign.sessionId}') active for '${cwd}'. One run per project at a time. ` +
        `Read what it is doing with get_findings({session_id:'${foreign.sessionId}'}) — a run ` +
        'that has already settled is just waiting to be closed by its own client. To take the ' +
        "project over, run 'ui-debugger-mcp stop' in this directory, then start again.",
    );
  }

  /**
   * Arm the wall-clock cap on what is LEFT of the run's budget: auto-end the run when
   * it fires (replaces any prior timer). `0` — the launch outlived the whole cap —
   * ends the run on the next tick rather than granting it a fresh one.
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
   * drains the inbox, so an ack then would silently drop the message.
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
   * auto-ended, so a timed-out run's partial findings stay reachable (the
   * long-poll returns at once: a settled run has nothing left to wait for).
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
      // Answering "no such session" there is a contradiction that sends the
      // caller into a retry loop; serve what that run has flushed instead.
      const foreign = await this.#foreignSnapshot(session_id);
      if (foreign) return fields ? projectFindings(foreign, fields) : foreign;
      throw error;
    }
    return fields ? session.snapshot(fields, wait) : session.snapshot(undefined, wait);
  }

  /**
   * A foreign run's findings as last flushed to disk, or `null` if this id names
   * no such run. Read-only and point-in-time: we do not own that run, so there is
   * nothing to long-poll — the owning server is the one advancing it.
   */
  async #foreignSnapshot(session_id: string): Promise<Findings | null> {
    const raw = await this.#state.foreignFindings(session_id);
    if (raw === null) return null;
    const parsed = FindingsSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /** List configured targets (the whole catalog, or one when named) plus resolved models/workspace. */
  describe({ target }: DescribeInput): DescribeResult {
    const entries = Object.entries(this.#config.targets);
    const selected = target === undefined ? entries : entries.filter(([name]) => name === target);
    if (target !== undefined && selected.length === 0) {
      throw new TargetNotFoundError(`target '${target}' not found in config.targets`);
    }
    return {
      targets: selected.map(([name, config]) => describeTarget(name, config)),
      models: this.#config.models,
      // The RESOLVED per-project root, not the raw config string: the caller joins
      // this to the relative evidence paths it gets back, and `./tmp/ui-debugger-mcp`
      // would send it looking one directory short of where anything lands.
      workspace: workspacePaths(this.#cwd, this.#config.workspace).root,
    };
  }

  /**
   * End the active run: abort the loop, close the adapter, free the profile lock.
   * Ending a run that already auto-ended (timeout / client death) is not an error
   * — it just forgets the retained snapshot, so `end_session` reads the same
   * either way and stays the one explicit forget.
   */
  async end({ session_id }: EndInput): Promise<Ack> {
    if (this.#forgetRetained(session_id)) return { ok: true, session_id };
    this.#require(session_id);
    this.#clearTimeout();
    // Clear the breadcrumb even when the close throws: the manager frees the slot
    // before closing, so a stale `running` state.json would make a later CLI
    // `stop` SIGTERM a healthy server. The close error still propagates.
    try {
      await this.#manager.end(this.#cwd);
    } finally {
      await this.#state.clear();
    }
    return { ok: true, session_id };
  }

  /**
   * End whatever run is active for this cwd, if any — the graceful-shutdown path
   * for a SIGTERM/SIGINT, a CLI `stop`, or the wall-clock timeout firing. No-op
   * when nothing is running.
   */
  async endActive(): Promise<void> {
    this.#clearTimeout();
    // A start still in flight owns no manager slot yet, so the check below would
    // sail straight past a Chrome that is mid-launch: cancel it and WAIT for its
    // teardown, or the process exits with a browser still holding the profile lock
    // and every later run fails with "Chrome profile ... is locked".
    const starting = this.#starting;
    if (starting !== undefined) {
      starting.controller.abort();
      await starting.settled;
    }
    if (!this.#manager.has(this.#cwd)) return;
    // Nobody asked for this end, so nobody has read the results yet: retain the
    // session (settled + closed) so `get_findings` still serves them. Captured
    // before the close, so even a failing teardown leaves the findings reachable.
    this.#retained = this.#manager.get(this.#cwd);
    // Same contract as `end()`: the breadcrumb clears even when the close throws.
    try {
      await this.#manager.end(this.#cwd);
    } finally {
      await this.#state.clear();
    }
  }

  /**
   * Resolve the session a read names: the active run, or — once the manager is
   * empty — the retained snapshot of the last auto-ended run, so a timed-out run's
   * partial findings stay readable by their id until `end_session` or the next
   * `start_debug`. A different id still fails loud.
   */
  #requireReadable(session_id: string): Session {
    const retained = this.#retained;
    if (retained === undefined || this.#manager.has(this.#cwd)) {
      return this.#require(session_id);
    }
    if (retained.id !== session_id) {
      throw new SessionNotFoundError(
        `No active debug session '${session_id}' for '${this.#cwd}' (the last run '${retained.id}' ` +
          'has ended; its findings are still readable under that id).',
      );
    }
    return retained;
  }

  /**
   * Forget the retained snapshot when the caller's `end_session` names it — the
   * run is already torn down, so there is nothing left to close. Returns whether
   * the id was the retained one (and it is now forgotten).
   */
  #forgetRetained(session_id: string): boolean {
    if (this.#manager.has(this.#cwd)) return false;
    if (this.#retained?.id !== session_id) return false;
    this.#retained = undefined;
    return true;
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

/** Whether a target is in attach mode (connects to a running instance, never start/stop). */
function isAttach(target: Target): boolean {
  if (target.adapter === 'browser') return target.cdpUrl != null;
  if (target.adapter === 'android') return target.adbSerial != null;
  return false;
}

/** Project one configured target onto its public {@link TargetInfo} (no secrets). */
function describeTarget(name: string, target: Target): TargetInfo {
  const base: TargetInfo = {
    name,
    adapter: target.adapter,
    mode: isAttach(target) ? 'attach' : 'managed',
    operational: true,
  };
  if (target.adapter === 'browser') {
    // Persona NAMES are the discoverable half — a caller can pick a valid `as`
    // without opening the config file, and never sees the values.
    const personas = Object.keys(target.auth ?? {});
    return {
      ...base,
      url: target.url,
      headless: target.headless,
      ...(personas.length > 0 && { personas }),
    };
  }
  return base;
}
