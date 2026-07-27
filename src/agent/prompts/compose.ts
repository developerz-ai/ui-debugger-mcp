/**
 * Prompt composition — base + target addendum + session story + criteria.
 *
 * The debug agent's system prompt is never monolithic. It is assembled fresh
 * per session from well-typed, versioned parts so each piece can be tested
 * independently, diffed in review, and swapped without touching the others.
 *
 * Composition order:
 *   1. Base debug-agent prompt   (loop rules, tools, finding shape, verdict),
 *      in the eye mode (`selfLook`) the belt's `look` tool actually runs in
 *   2. Target addendum           (web/desktop/android specifics)
 *   3. Address (optional)        (which app — and only that app — is under test)
 *   4. Signed in (optional)      (which auth persona the run opened as)
 *   5. Known about this app (optional) (the target's standing `notes` — what is expected)
 *   6. Session story             (what the smart agent wants done)
 *   7. Criteria (optional)       (pass/fail rules for this run)
 */

import { ANDROID_ADDENDUM_PROMPT } from './android-addendum.js';
import { debugAgentPrompt } from './debug-agent.js';
import { DESKTOP_ADDENDUM_PROMPT } from './desktop-addendum.js';
import { WEB_ADDENDUM_PROMPT } from './web-addendum.js';

/** Supported target names — one per shipped adapter (web · desktop · android). */
export type TargetName = 'web' | 'desktop' | 'android';

/** Resolved per-target addendum string. */
const TARGET_ADDENDA: Record<TargetName, string> = {
  web: WEB_ADDENDUM_PROMPT,
  desktop: DESKTOP_ADDENDUM_PROMPT,
  android: ANDROID_ADDENDUM_PROMPT,
};

export interface ComposeOptions {
  /** Target being debugged — selects the right addendum. */
  target: TargetName;
  /** The goal the smart agent provided (the "story"). */
  story: string;
  /** Optional pass/fail criteria. When omitted, agent uses built-in judgment. */
  criteria?: string[];
  /**
   * Where the app under test lives — the run's URL (web). Observed: with no
   * address in its context, a driver given the goal "debug the Nimbus Store home
   * page" opened `https://nimbus-store.vercel.app` as its FIRST action and spent
   * the whole run reporting bugs in a stranger's production site. Stating the
   * address is half the fix; `act` enforcing it is the other half.
   */
  address?: string;
  /**
   * Which `look` the belt is wired to — self-look (the driver is multimodal and
   * judges the frame itself) or the separate vision guy. Required, not defaulted:
   * a wrong prompt here tells the driver it cannot see what it can, or to ask a
   * vision model that this run never calls.
   */
  selfLook: boolean;
  /**
   * The persona `start_debug({as})` named, when the run signed in for the driver.
   *
   * NAME AND PATH ONLY. The credentials are typed out-of-band before the first
   * step and never enter this prompt — the system prompt is resent to the
   * provider on EVERY step, and the repo's standing rule for a secret is that it
   * never reaches the model's context (see `adapters/browser/log-format.ts`).
   * What the driver needs is not the recipe, it is knowing it is already inside.
   */
  auth?: { persona: string; loginPath: string };
  /**
   * The target's standing `notes`, one fact per line — what is EXPECTED of this
   * app, so the driver stops filing it as a defect.
   *
   * Observed: a freshly-migrated app with no seed data renders empty states
   * everywhere, and the driver correctly-but-uselessly reports "the table is
   * empty" as the run's headline bug. Config-level, so it is stated once instead
   * of pasted into every `goal`; capped at the config boundary
   * (`TARGET_NOTES_MAX_CHARS`) because this section is resent every step.
   */
  notes?: string[];
}

/**
 * Compose the full system prompt for a debug-agent session.
 *
 * Joins base + addendum + story + criteria with clear section headers so any
 * model can orient itself without relying on positional context.
 */
export function composeSystemPrompt(options: ComposeOptions): string {
  const { target, story, criteria, selfLook, address, auth, notes } = options;

  const addendum = TARGET_ADDENDA[target];

  const addressSection = address
    ? `\
## The app under test

${address}

You are ALREADY on it — the run opened it before your first step. This is the ONLY
app you debug. NEVER navigate to another host, however plausible its name looks next
to the goal: a bug found elsewhere is worthless, because the smart agent cannot fix
code it does not own. Links and paths within this app are fine; a different host is
not, and \`act\` will refuse it.
`
    : '';

  const authSection = auth
    ? `\
## Signed in

Already signed in as \`${auth.persona}\` — the run submitted \`${auth.loginPath}\` before your
first step. Start on the goal.

You do NOT have the credentials and CANNOT log in again. Back on \`${auth.loginPath}\` mid-run
means the session dropped: that is a bug — \`report\` it, never retry the form.
`
    : '';

  const notesSection =
    notes && notes.length > 0
      ? `\
## Known about this app

Stated by the project, not observed by you. Treat each as TRUE and EXPECTED — NEVER
\`report\` one as a bug (an empty table you were told to expect is not a defect). A
screen that CONTRADICTS one IS worth reporting.

${notes.map((note) => `- ${note}`).join('\n')}
`
      : '';

  const storySection = `\
## Your goal for this session

${story.trim()}
`;

  const criteriaSection =
    criteria && criteria.length > 0
      ? `\
## Pass / fail criteria

PASSED only when ALL of these are true. Evaluate each explicitly in your \`report\`:

${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}
`
      : '';

  return [
    debugAgentPrompt(selfLook),
    addendum,
    addressSection,
    authSection,
    notesSection,
    storySection,
    criteriaSection,
  ]
    .filter((section) => section.length > 0)
    .join('\n---\n\n');
}
