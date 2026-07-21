# 10 — Test hardening (cross-cutting)

> Part of [`overview.md`](overview.md). Depends on: 01–08 landed (their regression tests ship with them; this slice is the remainder).

Baseline: 645 pass / 10 skip / 0 fail; CI runs e2e (only `SKIP_BROWSER_INTEGRATION` gated suite skipped). These are the gaps no fix-slice claims.

## Gaps to close
- `src/adapters/factory.ts` — zero tests: unknown target → `TargetNotFoundError`; per-kind dispatch (may already land in 04 — check first).
- `src/errors.test.ts` — add `McpServerError`, `ReplayError`, `AdbError`, `VisionUnavailableError` (name + instanceof chain).
- `src/mcp/server.test.ts` — Zod failure through the real transport: bad `url`, `wait` > 120000, `timeout` > max, missing `goal`.
- `src/mcp/tools/start-debug.ts:65-71` — timeout s→ms conversion, untested anywhere.
- `debug-service.test.ts` — per-run `url` pass-through to builder; `wait` pass-through in `getFindings`; `describe` of browser attach target (`cdpUrl` → `isAttach` branch only tested for android).
- `session-builder.test.ts` — build the WEB target (per-run-url `effectiveConfig`/`openAddress` wiring untested); fix `/tmp/ui-dbg-builder-test` leak → scratchpad/tmpdir + cleanup.
- Android attach/managed lifecycle — attach `open` never spawns; managed `close` kill path with a real recorded pid (if not fully covered by 01).
- Browser attach mode — `cdpUrl` path, close-disconnects-never-kills (if not covered by 04).
- `withToolLog` preserves `toModelOutput` (load-bearing for self-look frame pruning).
- `budgetNudge` + inbox-fold ordering through `prepareStep` at run level; `pruneStaleFrames` with two self-look calls.
- NODE_EXTRACTOR direct tests: accessible-name precedence chain, `implicitRole` table, `testid`, contrast/style path (extractor is its own module after 04).
- Split oversized test files while touching them: `session.test.ts` (797), `loop.test.ts` (508).

## Steps
1. Diff this list against what 01–08 actually shipped; drop duplicates.
2. Group remaining by file; land as one PR of pure test additions (no src changes except test-only helpers).

## Tests
- That's the slice. Run: `bun test` (expect count well above 645), `typecheck`, `lint`.

## Done when
- Every bullet either has a test or a one-line note in the PR why not.
- No test file > 500 LOC; no test writes outside tmpdirs it cleans.
