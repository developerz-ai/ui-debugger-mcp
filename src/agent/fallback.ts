/**
 * Paid fallback behind a (free) primary model.
 *
 * The default roles run on OpenRouter `:free` models. Those are rate-limited
 * per model (~20 req/min), capped per day, and upstream-throttled at random —
 * measured 2026-11-14: `google/gemma-4-31b-it:free` answered a run's very first
 * step with `429 … temporarily rate-limited upstream`, and the run failed after
 * the SDK's three retries. So every role carries ONE paid fallback: when the
 * primary fails with a transient/availability status, or answers with nothing
 * at all, the SAME call is re-issued on the fallback model.
 *
 * Gateway-agnostic on purpose (no OpenRouter `models: []` body field): it works
 * on any OpenAI-compatible router, and the fallback is observable — every
 * switch is reported through `onFallback` (boot wires it to stderr).
 */

import { APICallError, type LanguageModel, wrapLanguageModel } from 'ai';

/** The wrapped model type `wrapLanguageModel` takes and returns. */
type WrappableModel = Parameters<typeof wrapLanguageModel>[0]['model'];

/** Why a call left the primary: an HTTP status, a transport error, or an empty answer. */
export interface FallbackEvent {
  primary: string;
  fallback: string;
  reason: string;
}

export type OnFallback = (event: FallbackEvent) => void;

/**
 * Statuses that say "this model, right now, cannot serve you" — not "your
 * request is wrong": 404 (a `:free` variant retired / no endpoints), 408, 429
 * (per-model or daily free cap), every 5xx. A 400 is deliberately NOT here: it
 * is a bad request (e.g. an image at a text-only model, which `look` turns
 * into its vision latch), and re-sending it elsewhere would hide the defect.
 */
function isUnavailable(status: number | undefined): boolean {
  return (
    status === undefined || status === 404 || status === 408 || status === 429 || status >= 500
  );
}

/** The fallback-worthy reason for an error, or `null` when it must propagate. */
export function fallbackReason(error: unknown): string | null {
  if (!APICallError.isInstance(error)) return null; // abort, validation, our own bugs
  if (!isUnavailable(error.statusCode)) return null;
  return error.statusCode === undefined
    ? `transport error: ${error.message}`
    : `HTTP ${error.statusCode}`;
}

/** A generate result with no text and no tool call — the model said nothing usable. */
function isEmpty(content: ReadonlyArray<{ type: string; text?: string }>): boolean {
  return !content.some(
    (part) =>
      part.type === 'tool-call' || (part.type === 'text' && (part.text ?? '').trim() !== ''),
  );
}

/**
 * `primary` with `fallback` behind it. Same `modelId` as the primary, so
 * capability messages and logs keep naming the configured model.
 */
export function withFallback(
  primary: WrappableModel,
  fallback: WrappableModel,
  onFallback: OnFallback,
): LanguageModel {
  const ids = { primary: primary.modelId, fallback: fallback.modelId };
  const fellBack = (reason: string): void => onFallback({ ...ids, reason });
  // `wrapLanguageModel` normalises both to the same spec version; call the
  // fallback through a passthrough wrap so its `doGenerate` matches the primary's.
  const backup = wrapLanguageModel({ model: fallback, middleware: {} });
  return wrapLanguageModel({
    model: primary,
    middleware: {
      wrapGenerate: async ({ doGenerate, params }) => {
        try {
          const result = await doGenerate();
          if (!isEmpty(result.content)) return result;
          fellBack('empty response');
        } catch (error) {
          const reason = fallbackReason(error);
          if (reason === null) throw error;
          fellBack(reason);
        }
        return backup.doGenerate(params);
      },
      wrapStream: async ({ doStream, params }) => {
        try {
          return await doStream();
        } catch (error) {
          const reason = fallbackReason(error);
          if (reason === null) throw error;
          fellBack(reason);
          return backup.doStream(params);
        }
      },
    },
  });
}
