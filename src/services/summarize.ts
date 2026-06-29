/**
 * `summarize` — the summary actor: condense a run's findings into one actionable
 * paragraph for the smart agent.
 *
 * The driver may finish a run without writing its own `summary` — it hit the step
 * cap, or just emitted the structured verdict and left the prose out. This service
 * fills that gap: it takes the terminal findings (the verdict plus every functional
 * `bug` and `visual` issue) and asks the summary model — the cheap text role, see
 * `idea/models.md` — for a single paragraph the smart agent can act on: what broke,
 * where, what to fix.
 *
 * The model call hides behind a small {@link SummaryGenerate} seam so the core
 * {@link summarize} unit-tests against a fake with no network — the same shape as
 * `look`'s vision seam. {@link createSummarize} binds the real
 * `generateText({ model: summary, … })` into the {@link SummarizeStep} the session
 * invokes once the verdict settles.
 *
 * Fails loud: an empty model reply throws an {@link AgentError} — we never pass a
 * blank string off as a summary. The session wraps the call in its own fail-soft
 * policy (a missing summary must never block teardown), so loud here, soft there.
 */

import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import { AgentError } from '../errors.js';
import type { Findings } from '../findings/schema.js';
import type { SummarizeStep } from '../session/session.js';

/** What `summarize` asks the summary model: our system prompt + the findings digest. */
export interface SummaryRequest {
  system: string;
  prompt: string;
}

/**
 * The model seam `summarize` calls through. {@link createSummarize} binds it to the
 * real `generateText({ model: summary, … })`; tests pass a fake returning canned text.
 */
export type SummaryGenerate = (req: SummaryRequest) => Promise<{ text: string }>;

/**
 * Our system prompt for the summary guy — provider-agnostic, owned in-repo. Pins the
 * reply to one tight, actionable paragraph so any competent text model behaves the
 * same (never relies on a 3rd-party default).
 */
export const SUMMARY_SYSTEM_PROMPT = `\
You are the summary guy — you condense a UI debug run into one paragraph for the
smart agent that will fix the code.
You are given the run's verdict plus every functional bug and visual issue it found.
Write ONE plain-text paragraph (no markdown, no lists, no headings, no preamble) that
states the verdict, then what broke, where, and what to fix — concrete and ordered by
severity. If nothing broke, say so plainly. Output only the paragraph.`;

/** One functional bug, rendered for the digest. */
function bugLine(bug: Findings['bugs'][number]): string {
  const evidence = bug.evidence ? ` (evidence: ${bug.evidence})` : '';
  return `- [${bug.kind}] ${bug.detail}${evidence}`;
}

/** One visual issue, rendered for the digest. */
function visualLine(issue: Findings['visual'][number]): string {
  return `- [${issue.severity}] ${issue.issue} @ ${issue.where}`;
}

/**
 * Render the findings into the compact, plain-text digest the summary model reasons
 * over: the verdict, then the functional bugs and visual issues (or "none").
 */
export function findingsDigest(findings: Findings): string {
  const lines: string[] = [`Verdict: ${findings.status}.`];

  if (findings.bugs.length > 0) {
    lines.push(`Functional bugs (${findings.bugs.length}):`, ...findings.bugs.map(bugLine));
  } else {
    lines.push('Functional bugs: none.');
  }

  if (findings.visual.length > 0) {
    lines.push(`Visual issues (${findings.visual.length}):`, ...findings.visual.map(visualLine));
  } else {
    lines.push('Visual issues: none.');
  }

  return lines.join('\n');
}

/**
 * Condense findings into one actionable paragraph. Pure over the
 * {@link SummaryGenerate} seam, so it unit-tests against a fake with no network.
 * @throws {AgentError} if the summary model returns a blank reply.
 */
export async function summarize(generate: SummaryGenerate, findings: Findings): Promise<string> {
  const { text } = await generate({
    system: SUMMARY_SYSTEM_PROMPT,
    prompt: findingsDigest(findings),
  });
  const paragraph = text.trim();
  if (paragraph.length === 0) {
    throw new AgentError('summarize: summary model returned an empty reply');
  }
  return paragraph;
}

/**
 * Bind {@link summarize} to the summary model, yielding the {@link SummarizeStep} the
 * session calls after the verdict settles. The model is the only thing that varies
 * between deployments; everything else (prompt, digest) is owned in-repo.
 */
export function createSummarize(model: LanguageModel): SummarizeStep {
  const generate: SummaryGenerate = async ({ system, prompt }) => {
    const { text } = await generateText({ model, system, prompt });
    return { text };
  };
  return (findings) => summarize(generate, findings);
}
