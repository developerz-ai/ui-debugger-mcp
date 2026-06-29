/**
 * Prompt composition — base + target addendum + session story + criteria.
 *
 * The debug agent's system prompt is never monolithic. It is assembled fresh
 * per session from well-typed, versioned parts so each piece can be tested
 * independently, diffed in review, and swapped without touching the others.
 *
 * Composition order:
 *   1. Base debug-agent prompt   (loop rules, tools, finding shape, verdict)
 *   2. Target addendum           (web/desktop/android specifics)
 *   3. Session story             (what the smart agent wants done)
 *   4. Criteria (optional)       (pass/fail rules for this run)
 */

import { DEBUG_AGENT_BASE_PROMPT } from './debug-agent.js';
import { DESKTOP_ADDENDUM_PROMPT } from './desktop-addendum.js';
import { WEB_ADDENDUM_PROMPT } from './web-addendum.js';

/** Supported target names. Extend when the android adapter lands. */
export type TargetName = 'web' | 'desktop';

/** Resolved per-target addendum string. */
const TARGET_ADDENDA: Record<TargetName, string> = {
  web: WEB_ADDENDUM_PROMPT,
  desktop: DESKTOP_ADDENDUM_PROMPT,
};

export interface ComposeOptions {
  /** Target being debugged — selects the right addendum. */
  target: TargetName;
  /** The goal the smart agent provided (the "story"). */
  story: string;
  /** Optional pass/fail criteria. When omitted, agent uses built-in judgment. */
  criteria?: string[];
}

/**
 * Compose the full system prompt for a debug-agent session.
 *
 * Joins base + addendum + story + criteria with clear section headers so any
 * model can orient itself without relying on positional context.
 */
export function composeSystemPrompt(options: ComposeOptions): string {
  const { target, story, criteria } = options;

  const addendum = TARGET_ADDENDA[target];

  const storySection = `\
## Your goal for this session

${story.trim()}
`;

  const criteriaSection =
    criteria && criteria.length > 0
      ? `\
## Pass / fail criteria

The smart agent considers this run PASSED only when ALL of the following are true.
Evaluate each one explicitly in your \`report\`:

${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
`
      : '';

  return [DEBUG_AGENT_BASE_PROMPT, addendum, storySection, criteriaSection]
    .filter((section) => section.length > 0)
    .join('\n---\n\n');
}
