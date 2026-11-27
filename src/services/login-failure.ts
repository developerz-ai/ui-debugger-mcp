/**
 * Redacting the pre-run login's failure — split out of `login.ts` (500-LOC cap).
 */

import { AuthError, UiDebuggerError } from '../errors.js';
import type { Redactor } from '../redact.js';

/**
 * A login failure with the run's secrets masked out of its message — it IS the
 * `start_debug` result, past every log sink. Keeps the class and `name` of the
 * error it replaces; the original is never chained as `cause` (it holds the secret).
 */
export function redactFailure(error: unknown, redact: Redactor): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const clean = redact(message);
  if (clean === message) return error;
  if (!(error instanceof UiDebuggerError)) {
    const replaced = new AuthError(clean);
    if (error instanceof Error) replaced.name = error.name;
    return replaced;
  }
  // Every `UiDebuggerError` subclass takes `(message, options?)` and names itself.
  return new (error.constructor as new (message: string) => UiDebuggerError)(clean);
}
