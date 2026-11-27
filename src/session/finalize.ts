/**
 * Post-verdict finalisation — the best-effort steps a {@link Session} runs once
 * its loop has settled a verdict: fill an empty summary (summary actor, or the
 * deterministic "no verdict" facts) and stitch the replay video. Fail-soft by
 * contract: neither may delay teardown or overturn the verdict.
 */

import type { Findings, FindingsStatus } from '../findings/schema.js';
import type { FindingsStore } from './findings-store.js';
import type { ReplayStep, SummarizeStep } from './session.js';

/** The session seams finalisation writes through, bound at the settled status. */
export interface FinalizeContext {
  store: FindingsStore;
  /** The settled status every write-back carries — never a stale `running`. */
  status: FindingsStatus;
  /** The session's abort signal: threaded to the steps, and checked before any write-back. */
  signal: AbortSignal;
  summarize: SummarizeStep | undefined;
  replay: ReplayStep | undefined;
}

/**
 * Fill `findings.summary` with the summary actor's paragraph when the driver left
 * it empty (and a summarizer is wired). Best-effort and non-blocking: any failure
 * is swallowed so a missing summary never delays teardown — the verdict already
 * stands and `get_findings` falls back to the driver's own summary (if any). Writes
 * back under the settled terminal `status`, never a stale `running`.
 */
export async function ensureSummary(ctx: FinalizeContext): Promise<void> {
  try {
    const findings = await ctx.store.tryReadFindings();
    // Re-checked after every read: an abort during it means `close()` may have returned.
    if (ctx.signal.aborted || findings === null || hasText(findings.summary)) return;
    // The driver never called `report` — the persisted verdict is still
    // `running` even though the loop is over (step cap, or it simply stopped).
    // There is nothing to condense, and a summary model handed an empty
    // findings set will INVENT a cause: an observed run drove 30 clean steps
    // and got back "the run failed due to a non-functional crash". A fabricated
    // root cause is worse than none — it sends the caller hunting a bug that
    // does not exist. State the real outcome instead.
    if (findings.status === 'running') {
      await writeUnreportedSummary(ctx, findings);
      return;
    }
    if (ctx.summarize === undefined) return;
    // Summarize the terminal record: `Session#verdict()` may have settled `status` to a
    // value the persisted findings don't yet carry (e.g. `failed` over a stale
    // `running`), so the digest must reflect the final verdict, not the disk copy.
    const terminalFindings = { ...findings, status: ctx.status };
    // Threaded abort: `Session#raceAbort` stops WAITING on teardown, but only the signal
    // actually cancels the in-flight model call instead of leaving it dangling.
    const summary = await ctx.summarize(terminalFindings, ctx.signal);
    // Settled after `close()` returned (ignored the signal): teardown is final, drop it.
    if (ctx.signal.aborted || !hasText(summary)) return;
    await ctx.store.writeFindings({ ...terminalFindings, summary });
  } catch {
    // Fail soft: the verdict stands; the driver's own summary (if any) is the fallback.
  }
}

/**
 * Record, as the summary, the fact that the run produced no verdict — naming
 * what actually happened and what to do about it, with no invented cause and
 * never a model in the loop (deterministic counts and framing only). Two
 * branches, one terminal framing: when the loop streamed evidence before it
 * ended (the `progressForStep` running writes), the summary names those leads by
 * count as partial and unconfirmed — the arrays below carry them — and never
 * claims the run recorded nothing; a truly empty run keeps that claim. Both
 * branches lead with the no-verdict fact and close with the same cut-short
 * guidance, so an empty and a partial run read the same way.
 */
async function writeUnreportedSummary(ctx: FinalizeContext, findings: Findings): Promise<void> {
  const steps = findings.steps ?? [];
  const bugs = findings.bugs ?? [];
  const visual = findings.visual ?? [];
  const failed = steps.filter((step) => step.ok === false).length;
  // The session is loop-blind: it knows the loop resolved without a `report`, not
  // why. Aborts/timeouts and agent errors never reach here (they settle elsewhere),
  // so the usual cause is the step budget — named as likely, never asserted.
  const lead =
    'Run ended WITHOUT a verdict: the driver loop finished without calling `report` ' +
    '(most likely its step budget ran out)';
  const evidence =
    bugs.length + visual.length > 0
      ? `. ${plural(bugs.length, 'bug')} and ${plural(visual.length, 'visual issue')} streamed in ` +
        'before the loop ended as partial, unconfirmed leads and are preserved below — none was ' +
        'confirmed by a `report`. '
      : ', so no findings were recorded. ';
  const summary =
    lead +
    evidence +
    `${steps.length} step(s) ran (${failed} failed) — read the step trail and screenshots for ` +
    'what it actually did. This is NOT a clean pass and NOT evidence of a crash: the run was ' +
    'simply cut short. Re-run with a narrower goal, or raise `timeout`.';
  await ctx.store.writeFindings({ ...findings, status: ctx.status, summary });
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
 *
 * Skipped outright once the session has aborted: `Session#raceAbort` only stops the
 * *waiting*, and the step is evaluated before it — so without this check a
 * teardown would still spawn ffmpeg, `close()` would resolve, the process would
 * exit and orphan the encoder (whose write-back would land after the run ended).
 */
export async function ensureReplay(ctx: FinalizeContext): Promise<void> {
  if (ctx.replay === undefined || ctx.signal.aborted) return;
  try {
    const outcome = await ctx.replay(ctx.signal);
    // Settled after `close()` returned (ignored the signal): teardown is final, drop it.
    if (ctx.signal.aborted) return;
    if (outcome.kind === 'skipped') {
      if (outcome.note !== undefined) await noteReplaySkipped(ctx, outcome.note);
      return;
    }
    const findings = await ctx.store.tryReadFindings();
    if (ctx.signal.aborted || findings === null) return;
    await ctx.store.writeFindings({
      ...findings,
      status: ctx.status,
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
 * Best-effort — wrapped by `ensureReplay`'s catch.
 */
async function noteReplaySkipped(ctx: FinalizeContext, note: string): Promise<void> {
  const findings = await ctx.store.tryReadFindings();
  if (ctx.signal.aborted || findings === null) return;
  await ctx.store.writeFindings({
    ...findings,
    status: ctx.status,
    steps: [...findings.steps, { step: 'replay video', ok: true, skipped: true, note }],
  });
}

/** True when `value` is a non-blank string (a real summary, not absent or whitespace). */
export function hasText(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** `plural(1, 'bug')` → '1 bug'; `plural(2, 'bug')` → '2 bugs' — the summary's deterministic counts. */
function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
