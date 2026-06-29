# UI Debugger MCP

Bun · TypeScript · Vercel AI SDK · OpenRouter. MCP server that debugs UIs autonomously.

A smart agent hands a goal (a "story") to a small fast agent inside this server.
The small agent drives browser/desktop, gathers evidence, reports findings.
Smart agent fixes code, asks again. Loop until the UI works. No human clicking.

## Response Rules
- Execute. No preamble.
- Lead with action or answer.
- Terse. Fragments OK.

## What this is
- MCP **server** (stdio). Ships as npm package, run via `npx`/`bunx`.
- The agent brain runs **inside** the server (Vercel AI SDK). Not the caller's.
- Session keyed by **current dir** (cwd). One project = one session.
- One debug run at a time (persistent Chrome profile locks the profile).

## Reference repos (read for patterns, don't copy blind)
- `../ai-task-master` — build template: Bun + TS + Vercel AI SDK, subagent-as-tool, MCP, Zod, Biome.
- `../gold-standards-in-ai/docs` — house rules: few fat tools, SRP, custom errors, compressed config.
- `../../sebyx07/claude-code-bible/docs` — deeper handbook. `?debug-ai=true` login bypass pattern.

## Architecture
- `src/main.ts` — boot stdio MCP server.
- `src/mcp/` — MCP server, tool defs (few fat tools, NOT one-per-action).
- `src/agent/` — small debug agent (Vercel AI SDK loop, OpenRouter model).
- `src/adapters/` — target control behind one shared contract.
  - `browser/` — web via CDP (headless default).
  - `desktop/` — X11/Wayland windows. Covers desktop app AND mobile emulator.
- `src/session/` — cwd-keyed session, per-project workspace, state.
- `src/config/` — load `.ui-debugger-mcp.json`, resolve model/targets.
- `src/services/` — business logic. Thin handlers, logic here.

## Targets (one project, many)
| Target  | Adapter            | Reads          |
|---------|--------------------|----------------|
| web     | browser (CDP)      | DOM            |
| desktop | x11/wayland window | a11y tree / vision |
| mobile  | x11/wayland (emulator window) | a11y tree / vision |

Two adapters cover three targets. Story names the target.

## MCP tools (few, fat — not playwright-mcp)
A **conversation**, not a remote control. Small agent owns the clicking loop.
- `start_debug` — open a session with a goal `{ target, goal, criteria? }`.
- `send_message` — talk to the small agent **mid-run** (add work, redirect, answer).
- `get_findings` — poll status + structured findings (functional + visual) + evidence.
- `describe` — list targets/config for this project (lazy schema).
- `end_session` — close it.

Never ship click/type/screenshot as separate tools. That floods context.
Findings carry BOTH functional bugs AND visual/UX feedback ("how it looks").

## Config split
- `.mcp.json` — how to LAUNCH server (command, model API key). Gitignored. Secret.
- `.ui-debugger-mcp.json` — how to DEBUG this app (model, targets, urls). Committed.

`.ui-debugger-mcp.json` shape:
```
model:   "openrouter/..."         small-agent model
targets:
  web:     { adapter: "browser", url, headless, debugLogin }
  desktop: { adapter: "x11", launch }
  mobile:  { adapter: "x11", launch, window }
workspace: "./tmp/ui-debugger-mcp"
```

## Per-project workspace
`./tmp/ui-debugger-mcp/<project>/`
- `chrome-user-data/` — persistent profile (login, cookies, storage).
- `sessions/<id>/` — `story.md`, `screenshots/`, `findings.json`, `logs/`.
- `logs/` — `console.log`, `network.log`, `agent.log`, `cdp.log`.
- `state.json` — session keyed by cwd.

## Login bypass (for tesote.ai et al)
Add `?debug-ai=true` escape hatch in the app under test. Skips **captcha only**,
not auth. Gate behind `ALLOW_AI_DEBUG_LOGIN` env so it's off in prod.
Captchas are the #1 blocker for headless agents.

## Commands
```
bun install
bun run dev            # boot server, watch
bun test               # unit tests < 10s
bun run lint:fix       # biome auto-fix
```

## Coding Rules
### Think before coding
- State assumptions. Uncertain → ask.
- Multiple readings → present them, don't pick.

### Simplicity first
- Minimum code. No speculative abstractions.
- 200 lines that could be 50 → write 50.

### Surgical changes
- Touch only what the task needs. No drive-by refactors.

### Quality
- Files ≤ 500 LOC. One responsibility per file.
- Zod at every boundary (config, MCP input, findings).
- Custom error classes. Never generic `Error`.
- Strict TS, no `any`. Biome gates.
- Fail fast. Surface errors loud. No silent fallback.

## Adapter contract (the one real seam)
Browser and desktop behind one interface so the agent loop is adapter-blind:
`open · find · click · type · readState · screenshot · waitFor`.
Web → DOM. Desktop/mobile → a11y tree, fall back to vision/screenshots.

## See also
- `idea/overview.md` — the problem + the idea.
- `idea/architecture.md` — full system design.
- `idea/adapters.md` — adapter contract + targets.
- `idea/desktop-control.md` — Linux tooling: X11/Wayland input, screenshots, AT-SPI, mobile.
- `idea/agent-loop.md` — story → findings loop.
- `idea/config.md` — `.mcp.json` + `.ui-debugger-mcp.json`.
- `idea/workspace.md` — per-project space + logs.
