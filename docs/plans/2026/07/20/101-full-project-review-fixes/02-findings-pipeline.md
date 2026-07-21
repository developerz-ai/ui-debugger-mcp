# 02 — Findings pipeline (no data loss)

> Part of [`overview.md`](overview.md). Depends on: none. Do before 06.

## Files to change
- `src/agent/belt/report.ts:109-112` + `src/agent/loop.ts:182-194` — terminal `steps` overlay replaces ALL driver-reported steps with the act trail whenever the trail is non-empty, and `stepTrailFrom` hardcodes `ok: true` (a failed `act` throws → never enters trail). Every persisted verdict trail is all-green; driver's `ok:false` steps + notes (mandated by `debug-agent.ts:53-59`) are silently discarded. **HIGH.**
- `src/agent/loop.ts:202-208` — `progressForStep` always flushes `bugs: [], visual: []`; `look` issues and console/network bugs live only in model context until `report`. Crash/abort/step-cap loses every finding except the act trail; mid-run `get_findings` never streams findings (contradicts `docs/idea/agent-loop.md:19`). **HIGH.**
- `src/agent/loop.ts:203` — act + `report` in the same step drops that act from the trail (early return before lifting).
- `src/agent/loop.ts:238-275` — `describeStep` ERROR tail is dead code: AI SDK 6 puts tool errors in `tool-error` content parts, not `step.toolResults`, so `isErrorOutput` never matches.
- `src/session/session.ts:368` — `#surfaceAgentError` overwrites a partial driver `summary` with `Debug run failed: …`; append instead.

## Steps
1. Record failed acts: catch in the act execution path (or trail collector) and push a trail entry with `ok: false` + error text, then rethrow so the model still sees the failure.
2. Replace the wholesale overlay with a merge: driver-reported steps win where present; trail entries fill gaps / attach evidence frames. Keep ordering stable. Update `report.test.ts:73-87`, which currently enshrines the discard.
3. Stream findings mid-run: in `progressForStep`, lift `look` results' `issues[]` and error-level console observations into the running flush the same way act steps are lifted (dedupe by message so re-reads don't multiply).
4. Fix the same-step act+report drop: lift the act into the trail before the report early-return.
5. `describeStep`: read `tool-error` parts from `step.content` (or delete the branch); add a direct test.
6. `#surfaceAgentError`: append `Debug run failed: …` to an existing summary rather than replacing.

## Tests
- Pin the merge: driver reports `ok:false` step + non-empty trail → both survive in `findings.json`.
- Mid-run flush: run a fake loop where `look` returns issues then the run aborts → issues present in flushed findings; `get_findings` mid-run shows them.
- Same-step act+report keeps the act in the trail.
- `describeStep` with a `tool-error` content part logs it.
- Run: `bun test src/agent src/session`, then full suite.

## Done when
- A crashed/aborted/timed-out run's `findings.json` contains all issues surfaced up to that point, with truthful `ok` flags.
- `get_findings` polled mid-run shows accumulating findings, not empty arrays.
