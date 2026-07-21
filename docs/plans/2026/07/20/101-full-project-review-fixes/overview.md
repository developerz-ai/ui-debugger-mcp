# Full project review — fixes

## Goal
Fix everything a 6-agent parallel review + MCP-ecosystem research found in v1.1.0: 4 high-severity bugs, ~20 mediums, docs drift, and test gaps. Ship a hardened v1.2.0.

## Context
- Bun + TS stdio MCP server; agent brain inside the server (Vercel AI SDK). Three adapters (browser/CDP, desktop/X11, android/ADB) behind one contract (`src/adapters/contract.ts`).
- Review verified as SOLID (don't re-litigate): concurrent `start_debug` gate, pid-reuse guard, findings.json atomic write, abort propagation, vision-unavailable latch, mid-run injection, CI (645 pass / typecheck / lint clean), packaging (node-compatible dist, LICENSE, gitignore, example configs valid).
- Actors touched: mostly the **fast guy** (driver belt + prompts) and server plumbing; smart-agent surface only in 06/07.
- Raw findings (full detail, keep until plan lands): scratchpad `findings-0*.md` — content is inlined into slices below, slices are self-sufficient.
- House rules apply to every slice: no `any`, Zod at boundaries, custom errors only (`src/errors.ts`), fail fast, files ≤500 LOC, surgical changes.

## Plan files (execute in order; 01+02 are the high-severity ones)
1. [`01-android-security.md`](01-android-security.md) — HIGH: shell injection via typed text; managed mode drives/kills foreign emulators. Plus android robustness.
2. [`02-findings-pipeline.md`](02-findings-pipeline.md) — HIGH: verdict trail discards failed/driver steps; mid-run findings never flushed (lost on crash).
3. [`03-belt-prompts.md`](03-belt-prompts.md) — belt schema/prompt contradictions (hover, frames, bare wait, within-node schema, console/network flood, self-look prompt).
4. [`04-browser-adapter.md`](04-browser-adapter.md) — lifecycle cleanup (zombie Chrome), AdapterError wrapping, contract promises (`fields`, readonly), 775-LOC split.
5. [`05-desktop-adapter.md`](05-desktop-adapter.md) — launch failure surfacing, zero-bounds misclicks, exec timeouts, Wayland honesty.
6. [`06-mcp-lifecycle.md`](06-mcp-lifecycle.md) — timed-out run findings unreachable; deadline start point; transport-close teardown; cross-process gate.
7. [`07-mcp-spec-alignment.md`](07-mcp-spec-alignment.md) — outputSchema + structuredContent, tool annotations, resource_link evidence, MCP Registry publish.
8. [`08-session-config-cli.md`](08-session-config-cli.md) — version drift, dead `profile` key, state.json atomicity + stop race, headless default, story.md, CLI fallthrough.
9. [`09-docs-sync.md`](09-docs-sync.md) — README/reference/idea-docs drift (wait:true, missing url param, wrong paths).
10. [`10-test-hardening.md`](10-test-hardening.md) — cross-cutting coverage: factory, AdbCli, errors, prompt-vs-schema drift guard, attach-mode.

Slices 03–05 and 08–10 are independent of each other; 02 before 06 (both touch findings flow); 07 after 06 (same files).

## Done when
- `bun test`, `bun run typecheck`, `bun run lint`, `bun run build` all clean.
- Android: control chars in `type` text cannot reach the device shell; managed runs bind to the spawned emulator's serial; attach never starts/stops.
- A crashed/aborted/timed-out run leaves its findings readable via `get_findings` AND on disk, with real `ok:false` steps.
- Every README/reference example is copy-paste valid against the Zod schemas.
- `--version`, MCP serverInfo, and package.json agree (pinned by a test).
- Tools declare `outputSchema` + annotations; package.json carries `mcpName` (before next publish).

## Risks / open questions
- 01 serial-binding needs a fixed `-port` or `adb devices` diff — pick one, test both emulator-present and clean-machine paths.
- 06 "keep settled session readable" changes manager lifecycle — don't break the one-run gate or `end_session` idempotence.
- 07 registry publish (`mcpName`) must land in package.json BEFORE the next npm release or verification fails.
- Wayland (05): decision needed — implement ydotool/portal or downgrade the docs claim. Plan assumes docs downgrade (cheap, honest); implementing is a separate feature.
- MCP Tasks (2025-11-25) is experimental — track, do not build. Session layer already maps 1:1.
