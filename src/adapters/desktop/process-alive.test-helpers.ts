/**
 * Test helper: is a process still running? Zombie-aware.
 *
 * `kill(pid, 0)` succeeds for a zombie (dead, not yet reaped). In a container whose
 * PID 1 does not reap orphans, a killed grandchild stays a zombie forever, so a bare
 * `kill -0` check reports it alive and a correct teardown looks like a failure.
 */

import { readFileSync } from 'node:fs';

/** True while `pid` is running; false once it is gone or a zombie (`/proc/<pid>/stat` state `Z`). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // `pid (comm) S ...` — comm may hold spaces/parens, so the state follows the LAST `)`.
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) !== 'Z';
  } catch {
    return true; // no /proc (or it vanished): the kill -0 answer stands
  }
}
