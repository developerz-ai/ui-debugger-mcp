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

import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import {
  SessionBusyError,
  SessionNotFoundError,
  SessionSettledError,
  TargetNotFoundError,
} from '../errors.js';
import type { Findings } from '../findings/schema.js';
import type { SessionManager } from '../session/manager.js';
import type { Session, SnapshotField } from '../session/session.js';
import { noopStatePort, type StatePort } from '../session/state-file.js';
import { generateSessionId } from '../session/workspace.js';
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
  /** Wall-clock cap (ms) before the run auto-ends; defaults to {@link DEFAULT_SESSION_TIMEOUT_MS}. */
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
}

/** `describe` output — configured targets plus the resolved models + workspace. */
export interface DescribeResult {
  targets: TargetInfo[];
  models: { driver: string; vision: string; summary: string };
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
  /** Injected clock (epoch ms) for session ids; defaults to `Date.now`. */
  now?: () => number;
}

export class DebugService implements DebugApi {
  readonly #manager: SessionManager<Session>;
  readonly #config: ResolvedConfig;
  readonly #cwd: string;
  readonly #build: SessionBuilder;
  readonly #state: StatePort;
  readonly #defaultTimeoutMs: number;
  readonly #now: () => number;
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
   * A `start()` is in flight (building/launching, slot not yet in the manager).
   * Set synchronously before the first await so a concurrent `start_debug` fails
   * loud with {@link SessionBusyError} instead of racing a second browser onto
   * the same profile.
   */
  #starting = false;

  constructor(deps: DebugServiceDeps) {
    this.#manager = deps.manager;
    this.#config = deps.config;
    this.#cwd = deps.cwd;
    this.#build = deps.build;
    this.#state = deps.state ?? noopStatePort;
    this.#defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Open a run: assemble the session, take the profile lock, point the adapter at
   * the target, and kick the loop off in the background. Fails loud if a run is
   * already active for this cwd ({@link SessionBusyError}); never leaks a launched
   * browser — a lost lock race or a failed `open` tears the session back down.
   */
  async start({ target, goal, criteria, url, timeoutMs }: StartInput): Promise<StartResult> {
    const cwd = this.#cwd;
    if (this.#manager.has(cwd)) {
      throw new SessionBusyError(
        `A debug session ('${this.#manager.get(cwd).id}') is already active for '${cwd}'. ` +
          'End it before starting another — one run per project at a time.',
      );
    }
    // Taken synchronously (no await since the has() check) — a concurrent start
    // must fail here, not launch a second browser on the same profile.
    if (this.#starting) {
      throw new SessionBusyError(
        `A debug session is already starting for '${cwd}'. ` +
          'Wait for it to open (or end it) before starting another — one run per project at a time.',
      );
    }
    this.#starting = true;

    try {
      const id = generateSessionId(this.#now());
      const built = await this.#build({ id, target, goal, criteria, url });

      try {
        this.#manager.start(cwd, built.session);
      } catch (err) {
        await built.session.close().catch(() => undefined);
        throw err;
      }
      // This run owns the slot now — the previous run's retained snapshot is
      // superseded (its findings.json stays on disk for the CLI / a human).
      this.#retained = undefined;

      try {
        await built.open();
        built.session.start(built.run);
      } catch (err) {
        await this.#manager.end(cwd).catch(() => undefined);
        throw err;
      }

      await this.#state.record({ sessionId: id, target, goal });
      this.#armTimeout(timeoutMs ?? this.#defaultTimeoutMs);
      return { session_id: id };
    } finally {
      this.#starting = false;
    }
  }

  /** Arm the wall-clock cap: auto-end the run when it fires (replaces any prior timer). */
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
    const session = this.#requireReadable(session_id);
    return fields && fields.length > 0
      ? session.snapshot(fields, wait)
      : session.snapshot(undefined, wait);
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
      workspace: this.#config.workspace,
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
    return { ...base, url: target.url, headless: target.headless };
  }
  return base;
}
