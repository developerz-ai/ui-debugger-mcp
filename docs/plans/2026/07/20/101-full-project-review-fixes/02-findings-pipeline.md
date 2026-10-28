# 02 — Findings pipeline (no data loss)

> Part of [`overview.md`](overview.md). Depends on: none. Do before 06.

## Disposition — SHIPPED, no open work

All five findings below were already fixed in the tree when this slice was reconciled; there is no remaining implementation work for 02. Each entry cites where the fix lives today and the tests that pin it. Verify with `bun test src/agent src/session`.

### F1 · failed acts recorded; driver steps merged, not discarded (HIGH) — SHIPPED
The terminal write no longer overlays the act trail over driver-reported steps (`stepTrailFrom` is gone): `mergeSteps` keeps the trail as the spine, a restated step fuses with driver fields winning and the trail attaching its evidence frame, and reported steps the trail never saw are appended (`src/agent/belt/report.ts:144`, `fuseStep` at `:117`). Failed acts land on the trail at act time — `ok: false` + note, then rethrown so the driver still sees the failure (`src/agent/belt/act.ts:397`; success records at `:376`) — so the prompt's `ok: false` step mandate (`src/agent/prompts/debug-agent.ts:167`) survives persistence.
Tests: `src/agent/belt/report.test.ts:114` (driver `ok:false` + note survive), `:136` (restatement fuses, driver wins + frame attached), `:173` (failed trail entry the driver never mentioned is kept), `:191` (no trail → reported steps kept).

### F2 · mid-run findings flush (HIGH) — SHIPPED
`progressForStep` flushes a snapshot COPY of steps+bugs+visual whenever any stream grew past the last flush (`src/agent/loop.ts:262`), wired into `onStepFinish` (`src/agent/loop.ts:430`). The belt records at tool time: `look` → `trail.recordVisual` (`src/agent/belt/look.ts:462`), error-level console rows → `trail.recordBug` (`src/agent/belt/observe.ts:574`; the only `recordBug` call site — failed network requests are not recorded). An aborted run carries the streamed evidence over via `#persistAbortedVerdict` (`src/session/session.ts:268`); a step-capped run's leads survive via `#writeUnreportedSummary` (`src/session/session.ts:339`) writing back the loop's flushed run — so mid-run `get_findings` shows accumulating findings instead of empty arrays.
Tests: `src/agent/loop.test.ts:176` (bugs/visual-only growth), `:275` (failed act still flushed), `:294` (snapshots are copies); `src/session/session.findings.test.ts:412` (step-capped run keeps streamed leads).

### F3 · same-step act+report keeps the act — SHIPPED
The trail gates its reads: `begin()` / `settled()` (`src/agent/belt/trail.ts:90`, `:122`). `act` enters the gate at enqueue, before its turn on the queue (`src/agent/belt/act.ts:482`); `report` reads `() => trail.settled()` before writing (`src/services/session-builder.ts:369`, `createReportTool` at `src/agent/belt/report.ts:311`), so a verdict written in the same step as an act still merges that act.
Tests: `src/agent/belt/report.test.ts:471` (awaits an async trail read before writing), `src/agent/loop.test.ts:227` (report step steps aside but the act is on the trail).

### F4 · `describeStep` surfaces tool errors — SHIPPED
Errors are read from `tool-error` content parts of `step.content` — AI SDK 6 never puts a rejected call in `toolResults` (`src/agent/loop.ts:324`; shape documented at `src/agent/loop.ts:74`). The dead `step.toolResults` branch is gone.
Tests: `src/agent/loop.test.ts:354` (`tool-error` part surfaced as `— ERROR act: …`), `:369` (no content / no errors → clean line).

### F5 · `#surfaceAgentError` appends — SHIPPED
A crash appends `Debug run failed: …` to a prior driver summary instead of overwriting it, with prior evidence and fields layered (`src/session/session.ts:451`, the append at `:462`).
Test: `src/session/session.test.ts:381` ("preserves prior evidence and appends to the prior summary").
