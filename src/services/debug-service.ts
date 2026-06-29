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
 */

import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import { SessionBusyError, SessionNotFoundError, TargetNotFoundError } from '../errors.js';
import type { Findings } from '../findings/schema.js';
import type { SessionManager } from '../session/manager.js';
import type { Session, SnapshotField } from '../session/session.js';
import { generateSessionId } from '../session/workspace.js';
import type { SessionBuilder } from './session-builder.js';

/** `start_debug` input — open a run for a configured target. */
export interface StartInput {
  target: string;
  goal: string;
  criteria?: string;
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
  /** Whether this adapter is wired yet (only `browser` today). */
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
  /** Injected clock (epoch ms) for session ids; defaults to `Date.now`. */
  now?: () => number;
}

export class DebugService implements DebugApi {
  readonly #manager: SessionManager<Session>;
  readonly #config: ResolvedConfig;
  readonly #cwd: string;
  readonly #build: SessionBuilder;
  readonly #now: () => number;

  constructor(deps: DebugServiceDeps) {
    this.#manager = deps.manager;
    this.#config = deps.config;
    this.#cwd = deps.cwd;
    this.#build = deps.build;
    this.#now = deps.now ?? (() => Date.now());
  }

  /**
   * Open a run: assemble the session, take the profile lock, point the adapter at
   * the target, and kick the loop off in the background. Fails loud if a run is
   * already active for this cwd ({@link SessionBusyError}); never leaks a launched
   * browser — a lost lock race or a failed `open` tears the session back down.
   */
  async start({ target, goal, criteria }: StartInput): Promise<StartResult> {
    const cwd = this.#cwd;
    if (this.#manager.has(cwd)) {
      throw new SessionBusyError(
        `A debug session ('${this.#manager.get(cwd).id}') is already active for '${cwd}'. ` +
          'End it before starting another — one run per project at a time.',
      );
    }

    const id = generateSessionId(this.#now());
    const built = await this.#build({ id, target, goal, criteria });

    try {
      this.#manager.start(cwd, built.session);
    } catch (err) {
      await built.session.close().catch(() => undefined);
      throw err;
    }

    try {
      await built.open();
      built.session.start(built.run);
    } catch (err) {
      await this.#manager.end(cwd).catch(() => undefined);
      throw err;
    }

    return { session_id: id };
  }

  /** Queue a mid-run instruction for the active run's driver. */
  send({ session_id, message }: SendInput): Ack {
    this.#require(session_id).pushMessage(message);
    return { ok: true, session_id };
  }

  /** Snapshot the run's findings — optionally long-poll (`wait`) and/or project a subset (`fields`). */
  async getFindings({
    session_id,
    wait,
    fields,
  }: GetFindingsInput): Promise<Findings | Partial<Findings>> {
    const session = this.#require(session_id);
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

  /** End the active run: abort the loop, close the adapter, free the profile lock. */
  async end({ session_id }: EndInput): Promise<Ack> {
    this.#require(session_id);
    await this.#manager.end(this.#cwd);
    return { ok: true, session_id };
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
    operational: target.adapter === 'browser',
  };
  if (target.adapter === 'browser') {
    return { ...base, url: target.url, headless: target.headless };
  }
  return base;
}
