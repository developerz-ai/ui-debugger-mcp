/**
 * Process-identity fingerprint — the guard that keeps `stop` from SIGTERM-ing a
 * recycled PID.
 *
 * `process.kill(pid, 0)` proves a PID is *alive*; it cannot prove it is still
 * *our* server. If the server died and the OS handed its PID to an unrelated
 * process, a bare liveness check would green-light a signal against that
 * innocent process. The OS process start time disambiguates: a recycled PID
 * belongs to a process that booted *later*, so its start time differs from the
 * one we recorded at boot. We capture that start time when the run opens (in the
 * `state.json` breadcrumb) and re-check it before signaling.
 *
 * Linux-only by design (this server targets Linux — see CLAUDE.md). The start
 * time comes from `/proc/<pid>/stat` field 22 (clock ticks since boot). On any
 * other platform the fingerprint is `null` (unverifiable) and callers fall back
 * to a bare liveness check — no protection, but no regression either.
 */

import { readFileSync } from 'node:fs';
import { z } from 'zod';

/** The fingerprint persisted in `state.json` and re-checked before signaling. */
export const ProcessIdentitySchema = z.object({
  /**
   * OS process start time — Linux `/proc/<pid>/stat` field 22 (clock ticks since
   * boot). `null` when `/proc` is unavailable (non-Linux): the PID is then
   * unverifiable and callers degrade to a bare liveness check.
   */
  startTicks: z.number().int().nonnegative().nullable(),
});

export type ProcessIdentity = z.infer<typeof ProcessIdentitySchema>;

/** Outcome of matching a recorded identity against the PID's live process. */
export type IdentityCheck =
  /** Live process start time matches — this PID is still our server. */
  | 'match'
  /** Live start time differs — the PID was recycled by an unrelated process. */
  | 'stale'
  /** No process owns the PID — the server is already gone (the benign race). */
  | 'gone'
  /** Can't read a start time (non-Linux, or none recorded) — fall back to liveness. */
  | 'unverifiable';

/** Linux start time, "no such process", or "couldn't read it". */
type LiveTicks = { kind: 'ticks'; ticks: number } | { kind: 'gone' } | { kind: 'unknown' };

/**
 * Parse the start time (field 22) out of a `/proc/<pid>/stat` line.
 *
 * Layout is `pid (comm) state ppid ...`; `comm` may itself contain spaces and
 * parentheses, so we anchor on the *last* `)` — field 3 (state) begins just
 * after it, making field 22 (starttime) the 20th whitespace token of the rest.
 */
export function parseStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const fields = stat
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  // starttime is field 22; the slice starts at field 3, so index 22 - 3 = 19.
  const raw = fields[19];
  if (raw === undefined) return null;
  const ticks = Number.parseInt(raw, 10);
  return Number.isNaN(ticks) ? null : ticks;
}

/** Read a live PID's start time, distinguishing "gone" from "can't tell". */
function readLiveTicks(pid: number): LiveTicks {
  if (process.platform !== 'linux') return { kind: 'unknown' };
  try {
    const ticks = parseStartTicks(readFileSync(`/proc/${pid}/stat`, 'utf8'));
    return ticks === null ? { kind: 'unknown' } : { kind: 'ticks', ticks };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT on Linux means the PID truly has no process — the benign race.
    return code === 'ENOENT' || code === 'ESRCH' ? { kind: 'gone' } : { kind: 'unknown' };
  }
}

/** Capture the fingerprint of a live process (defaults to this one) for `state.json`. */
export function captureIdentity(pid: number = process.pid): ProcessIdentity {
  const live = readLiveTicks(pid);
  return { startTicks: live.kind === 'ticks' ? live.ticks : null };
}

/** Match a recorded identity against whatever process currently owns `pid`. */
export function verifyIdentity(pid: number, recorded: ProcessIdentity): IdentityCheck {
  if (recorded.startTicks === null) return 'unverifiable';
  const live = readLiveTicks(pid);
  if (live.kind === 'gone') return 'gone';
  if (live.kind === 'unknown') return 'unverifiable';
  return live.ticks === recorded.startTicks ? 'match' : 'stale';
}
