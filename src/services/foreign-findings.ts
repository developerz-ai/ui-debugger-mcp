/**
 * Findings of a run ANOTHER live server holds on this project, read off disk.
 *
 * `start_debug` names that run in its refusal, so `get_findings` answering "no
 * such session" for the same id would be a contradiction — it serves what the
 * owner last flushed instead. Split out of `debug-service.ts` (500-LOC cap).
 */

import { SessionNotFoundError } from '../errors.js';
import { type Findings, FindingsSchema } from '../findings/schema.js';
import type { SnapshotField } from '../session/session.js';
import type { StatePort } from '../session/state-file.js';

/** The `fields` projection for a snapshot read off disk (a live `Session` projects its own). */
export function projectFindings(
  findings: Findings,
  fields: readonly SnapshotField[],
): Partial<Findings> {
  return Object.fromEntries(
    fields.filter((field) => field in findings).map((field) => [field, findings[field]] as const),
  ) as Partial<Findings>;
}

/**
 * A foreign run's findings as last flushed to disk, or `null` if `sessionId` names
 * no such run — we do not own it, so there is nothing to long-poll.
 *
 * `notFound` is the miss this lookup is the fallback for. A lookup that itself
 * FAILS must not replace it: the caller asked about a session, and "EACCES on
 * state.json" alone does not say theirs was not found. Both are surfaced — the
 * original message, the lookup failure appended and chained as `cause`.
 */
export async function foreignSnapshot(
  state: StatePort,
  sessionId: string,
  notFound: unknown,
): Promise<Findings | null> {
  let raw: unknown;
  try {
    raw = await state.foreignFindings(sessionId);
  } catch (lookup) {
    const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));
    throw new SessionNotFoundError(
      `${reason(notFound)} Checking whether another ui-debugger-mcp server holds it failed too: ` +
        `${reason(lookup)}`,
      { cause: lookup },
    );
  }
  if (raw === null) return null;
  const parsed = FindingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}
