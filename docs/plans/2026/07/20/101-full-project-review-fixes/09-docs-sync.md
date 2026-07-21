# 09 — Docs sync

> Part of [`overview.md`](overview.md). Depends on: 05 (Wayland wording), 07 (registry snippet), 08 (cdp.log decision). Pure docs — no src changes except two stale comments.

## Files to change
| File | Fix |
|---|---|
| `README.md:173,244` | `get_findings { wait: true }` → `wait: 30000` (schema is int ms 0–120000, `get-findings.ts:34-41`) |
| `README.md:184` + `docs/reference.md:25-31` | add `url` param to start_debug docs (`start-debug.ts:40-47`: web-only override, required when target has no url) |
| `README.md:246` + CLAUDE.md workspace section | logs are per-session: `<project>/sessions/<id>/logs/agent.log` (`workspace.ts:84-94`); no project-level `logs/` |
| `README.md:230` | state file is `./tmp/ui-debugger-mcp/<project>/state.json` |
| `README.md:292-294` | Credits: repo-external relative links 404 on GitHub/npm → absolute GitHub URLs or de-link |
| `docs/reference.md:86,136` | `evidence` = absolute replay.mp4 path when stitched (`session.ts:300-304`), not a directory |
| `docs/reference.md:98-107` | add `skipped` row to Step table (`findings/schema.ts:9`) |
| `docs/idea/mcp-tools.md:34` | start_debug shape add `url`, `timeout` |
| `docs/idea/mcp-tools.md:14` | contract list 7 → 12 methods (`contract.ts:167-200`: + pressKey, scroll, console, network, close) |
| `docs/idea/mcp-tools.md:77,163` | act is deliberately flat, not a discriminated union (`act.ts:41-47` rationale) |
| `docs/idea/workspace.md:20` + CLAUDE.md | `cdp.log` per 08 decision (strike) |
| `src/config/schema.ts:42,58` | stale comments: desktop/android are shipped (`factory.ts:44-51`) |
| CLAUDE.md target table + `docs/idea/adapters.md` | Wayland wording per slice 05 |

## Steps
1. Apply table row by row; verify each cited line against code while editing (lines may shift after slices 01–08 — sync docs LAST).
2. Grep README + docs/reference.md for every tool-param example; validate each against the Zod schemas in `src/mcp/tools/`.

## Tests
- None automated beyond existing suites; consider a doc-lint test extracting fenced JSON examples from README and parsing with the tool schemas (cheap, kills the `wait: true` class) — add if <50 LOC.
- `bun test` stays green.

## Done when
- Every copy-pasteable example in README/reference validates against the shipped schemas.
- No doc references a path, field, or method the code doesn't have.
