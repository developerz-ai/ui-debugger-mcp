# 06 — MCP lifecycle (findings stay reachable)

> Part of [`overview.md`](overview.md). Depends on: 02 (findings flush).

## Files to change
- `src/services/debug-service.ts:210-213,299-307` — wall-clock timeout fires → `endActive()` drops the session from the manager → every later `get_findings` throws `SessionNotFoundError`; a timed-out run's partial findings/evidence are unreachable via MCP (disk only). Breaks the poll-until-settled contract. **The medium that matters.**
- `src/services/debug-service.ts:200` + `session-builder.ts:211` — timeout armed only after build + Chrome launch + `open()`; launch/nav time (Playwright 30 s defaults) sits outside the caller's cap → run can exceed it by ~1 min.
- `src/services/debug-service.ts:199-200` — `#state.record` awaited after session registered/started; a throwing StatePort would leave a live run with no timeout armed (latent).
- `src/main.ts:96-107` — stdio transport close (MCP client dies) never ends the active run; browser lives until the cap.
- `src/services/debug-service.ts:164-178` + `state-file.ts:96-109` — one-run gate is in-process only; second server on same cwd overwrites the live breadcrumb; attach/desktop/android have no cross-process guard at all.
- `src/services/debug-service.ts:248-250` — `fields: []` silently returns the full findings object.

## Steps
1. Keep settled sessions readable: on auto-end (timeout) settle + close adapter but retain a terminal snapshot; `getFindings` serves it (simplest: `getFindings` falls back to reading the last session's `findings.json` from disk via the state breadcrumb when the manager is empty). `end_session` stays the explicit forget. Don't break the one-run gate: a retained terminal snapshot must not block a new `start_debug`.
2. Compute the run deadline at `start()` entry; pass remaining time down so build+open consume the same budget.
3. Arm the timeout before `#state.record`; on record failure, tear the run down and rethrow.
4. `main.ts`: hook transport/server `onclose` → `service.endActive()` (idempotent, same path as SIGTERM).
5. Cross-process gate: before starting, read `state.json`; if it records a `running` session whose pid passes the existing `process-identity` check, throw `SessionBusyError` naming the pid. (Machinery already exists — wire it.)
6. `get-findings.ts:44`: `.min(1)` on `fields`.

## Tests
- get_findings after timeout auto-end returns the terminal snapshot (regression for the medium).
- Deadline includes launch time (fake slow builder → run ends at cap).
- Transport close ends the run.
- Second service start with a live foreign state.json → `SessionBusyError`; with a stale/dead pid → proceeds.
- `fields: []` rejected by schema.
- Run: `bun test src/services src/mcp`, full suite.

## Done when
- Findings from every terminal state (done, failed, timed out, client-died) are reachable via `get_findings` until `end_session` or the next run.
- The caller's `timeout` is a true wall-clock cap from `start_debug` receipt.
