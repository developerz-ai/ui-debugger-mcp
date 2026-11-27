/**
 * Output redaction for belt tools whose results are free text end to end.
 *
 * `observe` redacts field by field (it must keep node `name`s intact for the
 * selectors built on them). `act` and the vision `look` have no such constraint:
 * everything they return — a step label, tab urls/titles, reloaded urls, the
 * vision guy's description of a screen that may SHOW a credential — is prose the
 * driver reads and the SDK re-sends every step. {@link withRedactedOutput} masks
 * the run's secrets in all of it, and in the message of anything the tool throws
 * (the SDK feeds a tool error back to the model verbatim).
 *
 * NOT for self-look: its result carries the frame as base64, where a short
 * secret can match by chance and corrupt the image.
 */

import type { Tool } from 'ai';
import { AgentError } from '../../errors.js';
import type { Redactor } from '../../redact.js';

/** Deep copy of plain JSON-shaped data with every string run through `redact`. */
export function redactStrings(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactStrings(item, redact));
  if (typeof value !== 'object' || value === null) return value;
  // Only plain objects: bytes, dates and class instances pass through untouched.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, redactStrings(item, redact)]),
  );
}

/**
 * `error` with its message (and stack, which repeats it) redacted — SAME class and
 * `name`, because callers key off both: the vision latch (`VisionUnavailableError`),
 * an abort (`AbortError`). A fresh object rather than a wrapper: the original must
 * never ride along as `cause`, since it carries the secret. Other own fields
 * (a provider error's response body) are deliberately not copied for the same reason.
 */
function redactedError(error: Error, redact: Redactor): Error {
  const copy: Error = Object.create(Object.getPrototypeOf(error));
  const field = (value: string) => ({ value, writable: true, configurable: true });
  // Own properties: `name` is a prototype getter on DOMException and needs a real instance.
  Object.defineProperties(copy, {
    name: field(error.name),
    message: field(redact(error.message)),
    stack: field(redact(error.stack ?? '')),
  });
  return copy;
}

/** Wrap a belt tool so its result and its thrown error message carry no run secret. */
export function withRedactedOutput<T extends Tool>(tool: T, redact: Redactor): T {
  const original = tool.execute;
  if (!original) return tool;
  return {
    ...tool,
    execute: async (input: unknown, options: Parameters<typeof original>[1]) => {
      try {
        return redactStrings(await original(input, options), redact);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // Untouched errors pass through as the same object.
        if (redact(message) === message) throw error;
        throw error instanceof Error
          ? redactedError(error, redact)
          : new AgentError(redact(message));
      }
    },
  } as T;
}
