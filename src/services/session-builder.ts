/**
 * Session builder — assemble one debug run from the resolved config.
 *
 * The heavy wiring behind `start_debug`, in one focused place: resolve the
 * target adapter (CDP browser today), build the inner belt
 * (`observe`/`act`/`look`/`report`) over it, compose the system prompt, and
 * bundle the loop runner the {@link Session} drives in the background. All of it
 * binds to a single per-run {@link FindingsStore} so the running progress trail
 * and the terminal `report` write to the same `findings.json`.
 *
 * Returns an *un-registered* session plus the `open`/`run` seams the service
 * fires only AFTER it has taken the project's profile lock — so a busy race never
 * leaks a launched browser. The builder stays adapter- and model-blind past this
 * seam; swapping the driver model or the target never touches the service.
 */

import type { LanguageModel, Tool } from 'ai';
import type { CaptureSink } from '../adapters/browser/cdp.js';
import { createAdapter } from '../adapters/factory.js';
import { createActTool } from '../agent/belt/act.js';
import { createLookTool } from '../agent/belt/look.js';
import { createObserveTool } from '../agent/belt/observe.js';
import { createReportTool } from '../agent/belt/report.js';
import { createDebugAgent, runDebugLoop } from '../agent/loop.js';
import { composeSystemPrompt, type TargetName } from '../agent/prompts/compose.js';
import type { ResolvedConfig } from '../config/load.js';
import type { Target } from '../config/schema.js';
import { AdapterError, TargetNotFoundError } from '../errors.js';
import { FindingsStore } from '../session/findings-store.js';
import { type LoopRunner, Session, type SessionAdapter } from '../session/session.js';
import { ensureSession, sessionPaths, type WorkspacePaths } from '../session/workspace.js';
import { createReplayStep } from './replay.js';
import { createSummarize } from './summarize.js';

/** The three actors the belt + loop + post-verdict step bind to, resolved once and shared across runs. */
export interface BuilderModels {
  /** fast guy — the blind text driver running the click loop. */
  driver: LanguageModel;
  /** vision guy — the multimodal eyes `look` calls through. */
  vision: LanguageModel;
  /** summary guy — condenses the terminal findings into one paragraph for the smart agent. */
  summary: LanguageModel;
}

/** What the builder needs that does not change between runs. */
export interface SessionBuilderDeps {
  config: ResolvedConfig;
  models: BuilderModels;
  workspace: WorkspacePaths;
}

/** The per-run inputs `start_debug` hands over. */
export interface BuildSessionParams {
  /** Stable session id (from `generateSessionId`). */
  id: string;
  /** Target name — a key in `config.targets` (e.g. `web`). */
  target: string;
  /** The story the smart agent wants done. */
  goal: string;
  /** Optional pass/fail criteria, one rule per line. */
  criteria?: string;
}

/** A built-but-unregistered session plus the seams the service fires post-lock. */
export interface BuiltSession {
  /** Ready to register with the manager; not yet opened or started. */
  session: Session;
  /** Navigate the adapter to the target (launches/attaches the browser page). */
  open(): Promise<void>;
  /** The background loop runner handed to `session.start()`. */
  run: LoopRunner;
}

/** The builder seam the service calls through; the default binds {@link buildSession}. */
export type SessionBuilder = (params: BuildSessionParams) => Promise<BuiltSession>;

/** Bind {@link buildSession} to its shared deps, yielding the per-run {@link SessionBuilder}. */
export function makeSessionBuilder(deps: SessionBuilderDeps): SessionBuilder {
  return (params) => buildSession(deps, params);
}

/** Compact one-line JSON of a tool input for the agent log (truncated, never throws). */
function compactInput(input: unknown): string {
  try {
    const s = JSON.stringify(input);
    return s.length > 200 ? `${s.slice(0, 199)}…` : s;
  } catch {
    return String(input);
  }
}

/**
 * Wrap a belt tool so every call records its input to `logs/agent.log`, and any
 * thrown error is logged before it propagates — otherwise a belt failure (e.g. a
 * selector that resolves nothing) is invisible: the SDK feeds it back to the model
 * as a tool-error and the run just churns. The wrapper is transparent: same
 * input/output, it only observes.
 */
function withToolLog(name: string, t: Tool, log: (line: string) => void): Tool {
  const original = t.execute;
  if (!original) return t;
  return {
    ...t,
    execute: async (input, options) => {
      log(`${name} ${compactInput(input)}`);
      try {
        return await original(input, options);
      } catch (err) {
        log(`${name} ERROR ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    },
  };
}

/** Map a config adapter kind to its prompt addendum target. Only browser/web ships today. */
function addendumTarget(adapter: Target['adapter']): TargetName {
  if (adapter === 'browser') return 'web';
  throw new AdapterError(`no prompt addendum for adapter '${adapter}' (desktop/android not wired)`);
}

/** The address `open()` navigates to — the URL for a web target. */
function openAddress(target: Target): string {
  if (target.adapter === 'browser') return target.url;
  throw new AdapterError(`adapter '${target.adapter}' has no open target (not wired)`);
}

/** Split a free-text criteria blob into per-line rules; `undefined` when empty/absent. */
function splitCriteria(criteria: string | undefined): string[] | undefined {
  if (criteria === undefined) return undefined;
  const lines = criteria
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines : undefined;
}

/**
 * Assemble a debug run: adapter + belt + composed prompt + loop runner, all bound
 * to a fresh {@link FindingsStore}. Throws {@link TargetNotFoundError} if `target`
 * is not configured and {@link AdapterError} for an unimplemented adapter — both
 * BEFORE any browser launches, so a bad request never leaks a process.
 */
export async function buildSession(
  deps: SessionBuilderDeps,
  params: BuildSessionParams,
): Promise<BuiltSession> {
  const { config, models, workspace } = deps;
  const { id, target, goal, criteria } = params;

  const targetConfig = config.targets[target];
  if (!targetConfig) {
    throw new TargetNotFoundError(`target '${target}' not found in config.targets`);
  }
  const addendum = addendumTarget(targetConfig.adapter);

  const paths = sessionPaths(workspace, id);
  await ensureSession(paths);
  const store = new FindingsStore(paths);
  const onLog: CaptureSink = (channel, line) => {
    void store.appendLog(channel, line).catch(() => undefined);
  };

  const adapter = await createAdapter(target, config, workspace.chromeUserData, onLog);
  const instructions = composeSystemPrompt({
    target: addendum,
    story: goal,
    criteria: splitCriteria(criteria),
  });

  const appendAgentLog = (line: string): Promise<string> =>
    store.appendLog('agent', `${new Date().toISOString()} ${line}`);
  // High-frequency, fire-and-forget: the agent's own log sink + per-step tool logs.
  const logAgent = (line: string) => {
    void appendAgentLog(line).catch(() => undefined);
  };
  // Run-lifecycle breadcrumbs (start/end/error) are AWAITED: on the crash path the
  // process can exit before a fire-and-forget write flushes, losing the very failure
  // we're trying to diagnose. A logging error here is swallowed, never masking the run.
  const flushAgentLog = async (line: string): Promise<void> => {
    try {
      await appendAgentLog(line);
    } catch {
      // best-effort: logging must never break or mask the run
    }
  };

  const run: LoopRunner = async ({ inbox, progress, signal }) => {
    const agent = createDebugAgent({
      model: models.driver,
      tools: {
        observe: withToolLog('observe', createObserveTool(adapter), logAgent),
        act: withToolLog('act', createActTool(adapter, store), logAgent),
        look: withToolLog('look', createLookTool(adapter, models.vision, store), logAgent),
        report: withToolLog('report', createReportTool(store), logAgent),
      },
      instructions,
      inbox,
      progress,
      log: logAgent,
    });
    await flushAgentLog(`run start: target=${target} goal=${JSON.stringify(goal)}`);
    try {
      const result = await runDebugLoop({ agent, abortSignal: signal });
      await flushAgentLog('run end: loop resolved (driver reported or step cap reached)');
      return result;
    } catch (err) {
      // Surface the real failure to disk BEFORE the session folds it into `failed` —
      // awaited, so a crash that exits the process can't race past the flush and leave
      // agent.log empty (the exact case this trace is here to diagnose).
      await flushAgentLog(
        `run error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      );
      if (err instanceof Error && err.stack) {
        await flushAgentLog(err.stack.split('\n').slice(0, 8).join('\n'));
      }
      throw err;
    }
  };

  const session = new Session<SessionAdapter>({
    id,
    story: goal,
    criteria,
    adapter,
    findingsStore: store,
    // Post-verdict seam: fills `findings.summary` over the summary model when the
    // driver left it empty (best-effort; the session wraps it fail-soft).
    summarize: createSummarize(models.summary),
    // Post-verdict seam: stitches the ordered screenshots into a captioned
    // `replay.mp4` (ffmpeg) and records its path in `findings.evidence` for the PR.
    replay: createReplayStep({ screenshots: store, output: paths.replayMp4 }),
  });

  return {
    session,
    open: () => adapter.open(openAddress(targetConfig)),
    run,
  };
}
