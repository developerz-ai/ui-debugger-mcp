/**
 * `look` — the driver's eyes (inner belt; the vision seam).
 *
 * The driver is a fast, **blind** text model: it acts on structure, never pixels.
 * When it needs visual judgment ("is the button centred?", "does this match the
 * design?") it calls `look`, which:
 *   1. captures the current frame via the shared {@link Adapter} (`screenshot`),
 *   2. sends that frame + the driver's question/expectation to the **vision guy**
 *      (the multimodal model bound to the `vision` role — see `idea/models.md`),
 *   3. returns the vision guy's structured judgment `{ description, matches?,
 *      issues[] }`, with the screenshot saved and its path attached as evidence.
 *
 * Adapter-blind like the rest of the belt — it only reaches the contract's
 * `screenshot`. The model call is hidden behind a small {@link VisionGenerate}
 * seam so {@link runLook} unit-tests against a fake (no network); `createLookTool`
 * wires the real `generateText({ model: vision, … })`.
 *
 * Fails loud: a vision reply that is not JSON, or that breaks the schema, throws
 * an {@link AgentError} — we never silently fall back to half-parsed prose.
 */

import type { LanguageModel, ModelMessage } from 'ai';
import { generateText, tool } from 'ai';
import { z } from 'zod';
import type { Adapter } from '../../adapters/contract.js';
import { AgentError } from '../../errors.js';

/** `look` input — both optional: ask a `question`, and/or state the `expect`ed look. */
export const LookInputSchema = z.object({
  question: z
    .string()
    .optional()
    .describe('what to judge, e.g. "is the Checkout button centred?" | "where is the error?"'),
  expect: z
    .string()
    .optional()
    .describe('the intended look to compare against, e.g. "a centred blue primary button"'),
});

export type LookInput = z.infer<typeof LookInputSchema>;

/** Severity of a visual issue — mirrors the findings `VisualIssue` scale. */
const SEVERITIES = ['low', 'medium', 'high'] as const;

/** One visual issue the vision guy flags: what, where, and how bad. */
const LookIssueSchema = z.object({
  what: z.string().describe('the visual problem, e.g. "text is cut off"'),
  where: z.string().describe('where on screen, e.g. "top-right card header"'),
  severity: z.enum(SEVERITIES).describe('low (polish) | medium (off) | high (broken)'),
});

export type LookIssue = z.infer<typeof LookIssueSchema>;

/** The vision guy's reply, parsed from its JSON output (before evidence is attached). */
const VisionReplySchema = z.object({
  description: z.string().describe('what the vision guy sees / its answer'),
  matches: z.boolean().optional().describe('did it match `expect`? present only when expected'),
  issues: z.array(LookIssueSchema).default([]).describe('visual problems; [] when none'),
});

type VisionReply = z.infer<typeof VisionReplySchema>;

/** Structured `look` result — the vision judgment plus the saved evidence frame. */
export type LookResult = VisionReply & {
  /** Path to the screenshot saved as evidence for the visual finding. */
  screenshot: string;
};

/** What `look` asks the vision model: our system prompt + the user frame/question. */
export interface VisionRequest {
  system: string;
  messages: ModelMessage[];
}

/**
 * The model seam `look` calls through. `createLookTool` binds it to the real
 * `generateText({ model: vision, … })`; tests pass a fake returning canned text.
 */
export type VisionGenerate = (req: VisionRequest) => Promise<{ text: string }>;

/**
 * The slice of the findings store `look` records evidence through.
 * {@link FindingsStore} satisfies it structurally; tests pass a fake.
 */
export interface EvidenceRecorder {
  /** Save a PNG frame as `screenshots/NNN-<label>.png`; returns its path. */
  saveScreenshot(label: string, data: Uint8Array): Promise<string>;
}

/**
 * Our system prompt for the vision guy — provider-agnostic, owned in-repo.
 * Pins the reply to the exact JSON `look` parses, so any competent multimodal
 * model behaves the same (never relies on a 3rd-party default).
 */
export const VISION_SYSTEM_PROMPT = `\
You are the vision guy — the eyes of a blind UI-testing driver.
You are given a screenshot of the target UI plus a question and/or an expected look.
Describe what you see and judge how it looks: layout, alignment, spacing, colour,
overlap, cut-off or unreadable text — anything that looks broken or off.

Reply with ONLY a JSON object (no prose, no markdown fences) of this exact shape:

{
  "description": "what you see, answering the question if one was asked",
  "matches": true,            // include ONLY when an expected look was given: does it match it?
  "issues": [                 // visual problems found; [] when there are none
    { "what": "the problem", "where": "where on screen", "severity": "low" | "medium" | "high" }
  ]
}

Severity: high = broken layout / overlap / invisible interactive element;
medium = misalignment / bad spacing / contrast issue; low = minor polish.
Be concrete about "where" (e.g. "top-right header", "primary submit button").
Output the JSON object and nothing else.`;

/** Compose the driver's question + expectation into the vision guy's user prompt. */
function buildPrompt({ question, expect }: LookInput): string {
  const parts: string[] = [];
  if (question) parts.push(`Question: ${question}`);
  if (expect) parts.push(`Expected look: ${expect}`);
  if (parts.length === 0) parts.push('Describe what you see and flag any visual issues.');
  return parts.join('\n');
}

/** Short label for the evidence frame's filename — the question, then the expectation. */
function lookLabel({ question, expect }: LookInput): string {
  return question ?? expect ?? 'look';
}

/** Trim a model reply for an error message so we never dump a wall of text. */
function truncate(text: string, max = 200): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** Pull the JSON object out of a reply — tolerant of ```json fences and stray prose. */
function extractJson(text: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)\s*```/i.exec(text);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new AgentError(`look: no JSON object in vision reply: ${truncate(text)}`);
  }
  return body.slice(start, end + 1);
}

/** Parse + validate the vision guy's reply; fail loud on non-JSON or a bad shape. */
function parseVisionReply(text: string): VisionReply {
  let data: unknown;
  try {
    data = JSON.parse(extractJson(text));
  } catch (e) {
    if (e instanceof AgentError) throw e;
    throw new AgentError(
      `look: vision reply was not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const result = VisionReplySchema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new AgentError(`look: vision reply failed validation: ${issues}`);
  }
  return result.data;
}

/**
 * Capture the frame, ask the vision guy, attach the evidence. Pure over the
 * {@link Adapter}, {@link VisionGenerate} and {@link EvidenceRecorder} seams, so
 * it unit-tests against fakes with no network.
 */
export async function runLook(
  adapter: Adapter,
  generate: VisionGenerate,
  recorder: EvidenceRecorder,
  input: LookInput,
): Promise<LookResult> {
  const png = await adapter.screenshot();
  const { text } = await generate({
    system: VISION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: buildPrompt(input) },
          { type: 'image', image: png, mediaType: 'image/png' },
        ],
      },
    ],
  });
  const reply = parseVisionReply(text);
  const screenshot = await recorder.saveScreenshot(lookLabel(input), png);
  return { ...reply, screenshot };
}

/** Build the `look` tool bound to one adapter + vision model + recorder, for the belt. */
export function createLookTool(
  adapter: Adapter,
  vision: LanguageModel,
  recorder: EvidenceRecorder,
) {
  const generate: VisionGenerate = async ({ system, messages }) => {
    const { text } = await generateText({ model: vision, system, messages });
    return { text };
  };
  return tool({
    description:
      'Ask the vision model to look at the current screen. Captures a screenshot and sends it with your question/expect to the multimodal "eyes", which judges how it looks (layout, alignment, colour, overlap, cut-off text). Returns { description, matches?, issues[] } with the screenshot saved as evidence. Use only when structure (observe) cannot answer — vision is slow and costly.',
    inputSchema: LookInputSchema,
    execute: (input) => runLook(adapter, generate, recorder, input),
  });
}
