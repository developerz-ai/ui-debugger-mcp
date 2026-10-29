/**
 * The debug service's public contract — the types the outer MCP tools speak.
 *
 * Split out of `debug-service.ts` to keep that file under the 500-LOC cap: this
 * is a dozen TYPE declarations with no runtime behaviour of their own. The
 * service re-exports every name it exports today, so no importer changes.
 */

import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import type { Findings } from '../findings/schema.js';
import type { SessionManager } from '../session/manager.js';
import type { Session, SessionStatus, SnapshotField } from '../session/session.js';
import type { StatePort } from '../session/state-file.js';
import type { SessionBuilder } from './session-builder.js';

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
   * Take the project over instead of being refused when a run is already active
   * here: end that run first (through the `end_session` path), then start.
   *
   * OFF by default, and it must stay off by default — a silent takeover kills a
   * healthy run its own caller is still watching. Opt in when the active run is
   * yours and you lost its id (a compacted context, a crashed client) or it is
   * stuck. Only ever replaces a run THIS server owns; one held by another live
   * server is still refused ({@link SessionBusyError}), since its browser is not
   * ours to close.
   */
  replace?: boolean;
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
  /**
   * Whether this adapter kind is available HERE: wired in this build AND
   * supported on the host platform. It is NOT a launch promise — the target may
   * be down, or its browser/emulator/device missing or disconnected; that fails
   * loud at launch.
   */
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
  /**
   * The target's standing `notes` — what is EXPECTED of this app (seeded data,
   * onboarding modals, dark mode), verbatim from config. Also composed into the
   * driver's prompt; surfaced here so a caller can see what the run was told.
   */
  notes?: string;
}

/**
 * The run this server holds for the project, as `describe` reports it — the way
 * back in-band for a caller that lost its `session_id` (a compacted context, a
 * client restart). Without it the only recovery was the out-of-band CLI.
 */
export interface RunInfo {
  /** Pass to `get_findings` / `send_message` / `end_session`. */
  id: string;
  /** `running`, or the verdict it settled on (still readable, still holding the slot). */
  status: SessionStatus;
  /** The goal this run was started with — enough to tell whose run it is. */
  goal: string;
}

/** `describe` output — configured targets plus the resolved models + workspace. */
export interface DescribeResult {
  targets: TargetInfo[];
  models: { driver: string; vision: string; summary: string };
  /** Resolved per-project workspace root (`<base>/<project>`) — where evidence lands. */
  workspace: string;
  /**
   * The active run for this project (or the retained snapshot of the last one that
   * auto-ended). Absent when this server holds no run. A run another live server
   * owns is NOT reported here — `start_debug` names that one in its refusal.
   */
  session?: RunInfo;
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
   * The host platform the adapter-availability rule is evaluated against;
   * defaults to `process.platform`. Injected so `describe` reports the same
   * fact on every host (the tests pin it).
   */
  platform?: NodeJS.Platform;
  /**
   * Has `.ui-debugger-mcp.json` changed since boot? Config is resolved once and
   * wired into long-lived objects, so a changed file means every later run would
   * silently use the OLD settings — see `config/fingerprint.ts`. Defaults to
   * "never changed" (unit tests hold no file).
   */
  configChanged?: () => boolean;
}
