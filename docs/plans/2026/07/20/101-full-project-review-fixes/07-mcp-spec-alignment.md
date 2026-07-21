# 07 — MCP spec alignment + registry

> Part of [`overview.md`](overview.md). Depends on: 06 (same files). Source: ecosystem research (scratchpad `findings-00-mcp-ecosystem.md`).

Core design already matches Anthropic guidance + maps 1:1 onto experimental MCP Tasks — no redesign. This slice closes the concrete spec gaps.

## Files to change
- `src/mcp/tools/*.ts` + `src/mcp/tools/result.ts:17-23` — tools emit `structuredContent` but never declare `outputSchema`; typed channel is unvalidated for clients ("Zod at every boundary" fails at tool outputs).
- `src/mcp/tools/index.ts` (tool registrations) — no annotations.
- `src/services/debug-service.ts` / `result.ts` — evidence (screenshots, replay.mp4, logs) returned as inline text paths; spec-blessed form is `resource_link` content items.
- `package.json` — no `mcpName`; not in the official MCP Registry.
- New: `server.json` at repo root for `mcp-publisher`.

## Steps
1. `outputSchema`: findings/status shapes already exist as Zod (`src/findings/schema.ts`) — convert per-tool output to JSON Schema (SDK accepts Zod directly in 1.29) and declare on `get_findings`, `describe`, `start_debug`, `send_message`, `end_session`. Keep the serialized-text block for back-compat (spec requires both).
2. Annotations: `get_findings`/`describe` → `readOnlyHint: true`; `start_debug` → `destructiveHint: false, openWorldHint: true`; `end_session` → `idempotentHint: true`.
3. Error convention audit: run failures must return `isError: true` results (SDK already wraps handler throws — verify each tool path; protocol errors only for unknown tool/bad args).
4. Steering truncation: wherever findings/evidence lists are capped in `result.ts`, append what to do next ("call get_findings with fields=[…]", "full evidence at <path>").
5. `resource_link`: return screenshot/replay/log paths as `resource_link` content items (file:// URIs) alongside the text block.
6. Registry: add `"mcpName": "io.github.developerz-ai/ui-debugger-mcp"` to package.json NOW (must be in the next published tarball); write `server.json` ($schema 2025-12-11, `registryType: npm`, `transport: stdio`, env vars with `isSecret`); document the `mcp-publisher init/login/publish` step in the release checklist.
7. Skip (recorded decision, do not build): resources/prompts/sampling/elicitation primitives; MCP Tasks facade (experimental — session layer already shaped for it).

## Tests
- Per-tool: `structuredContent` validates against declared `outputSchema` (round-trip through the real transport in `server.test.ts`).
- Annotations present in `tools/list` response.
- A failing run returns `isError: true` result, not a protocol error.
- `server.json` validates against its `$schema` (fetch once, pin fixture).
- Run: `bun test src/mcp`, full suite.

## Done when
- `tools/list` shows outputSchema + annotations for all five tools; findings arrive typed.
- Evidence returned as resource links, not inline dumps.
- package.json carries `mcpName` before the next npm publish; release doc includes registry step.

## Docs (required by /planx rule — MCP surface changed)
- `README.md` + `docs/reference.md`: note structured output + annotations; registry install snippet.
