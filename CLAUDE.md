# UI Debugger MCP

Bun · TypeScript · Vercel AI SDK · OpenAI-compatible router (OpenRouter default).
MCP server that debugs UIs autonomously.

A smart agent hands a goal (a "story") to a small fast agent inside this server.
The small agent drives browser/desktop, gathers evidence, reports findings.
Smart agent fixes code, asks again. Loop until the UI works. No human clicking.

**Goal: stuff WORKS + LOOKS NICE.** Three actors cooperate (`docs/idea/models.md`):
- **smart agent** — the boss (Claude/caller): sets goals, fixes code, loops.
- **fast guy** — the driver (fast, text-only, blind): controls the target.
- **vision guy** — the eyes (multimodal): describes screenshots, judges looks.

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
- `src/agent/` — debug agent (Vercel AI SDK loop). The **fast guy** (driver) +
  the **vision guy** (eyes via `look`). Models per role via OpenAI-compatible
  router (OpenRouter default). Defaults: deepseek (text), glm (image).
  - `prompts/` — OUR system prompts (in-repo, versioned, tested). Provider-agnostic. Never rely on a 3rd-party model's defaults. Teaches the bits + why CDP.
- `src/adapters/` — target control behind one shared contract.
  - `browser/` — web via CDP (headless default). ✅ shipped.
  - `desktop/` — X11/Wayland windows. Covers desktop app AND mobile emulator. ✅ shipped.
  - `android/` — ADB + uiautomator. ✅ shipped.
- `src/session/` — cwd-keyed session, per-project workspace, state.
- `src/config/` — load `.ui-debugger-mcp.json`, resolve model/targets.
- `src/services/` — business logic. Thin handlers, logic here.

## Targets (one project, many)
| Target  | Adapter        | Protocol            | Reads              |
|---------|----------------|---------------------|--------------------|
| web     | browser        | CDP                 | DOM                |
| desktop | desktop        | X11/Xvfb; Wayland: wlroots capture (`grim`) only, no native input | a11y tree / vision |
| mobile  | android        | ADB (uiautomator)   | view hierarchy / vision |

Three adapters, one shared contract. Story names the target. iOS out of scope on Linux.

Each adapter runs **managed** (server launches + owns the target) or **attach**
(connect to a running one — `cdpUrl` for web, `adbSerial` for android — never
start/stop it). Managed picks the binary via `executablePath`/`emulatorPath`.

## MCP tools (few, fat — not playwright-mcp)
A **conversation**, not a remote control. Small agent owns the clicking loop.
- `start_debug` — open a session with a goal `{ target, goal, criteria?, timeout? }`
  (`timeout` seconds; always capped — default 300s — so a run never hangs forever).
- `send_message` — talk to the small agent **mid-run** (add work, redirect, answer).
- `get_findings` — poll status + structured findings (functional + visual) + evidence.
- `describe` — list targets/config for this project (lazy schema).
- `end_session` — close it.

Never ship click/type/screenshot as separate tools. That floods context.
Findings carry BOTH functional bugs AND visual/UX feedback ("how it looks").

Two tool layers (see `docs/idea/mcp-tools.md`): outer = few conversational MCP tools
(smart Claude). Inner = the debug agent's belt (`observe`/`act`/`look`/`report`),
SQL-like, heavily parameterized (`query`/`fields`/`filters`), one `act` not six.
`look` = the eyes: sends a screenshot to the **vision guy** for visual judgment.

## CLI (bin: `ui-debugger-mcp`)
- no args → run the stdio MCP server (default).
- `init` → scaffold a project: create `./tmp/ui-debugger-mcp/`, write a starter
  `.ui-debugger-mcp.json` (deepseek/glm defaults + `web` stub) if absent, add
  `tmp/` to `.gitignore`, print the `.mcp.json` snippet. Never writes the API key.
- `status` → print the active run for this cwd: session id, target, goal, server
  pid (+ alive?), verdict, finding counts. Reads `state.json` + the session's
  `findings.json`; no API key needed.
- `stop` → tear the active run down: SIGTERM the recorded server pid (graceful —
  the server ends the run, closes the browser, frees the profile), mark `stopped`.

The server drops `<workspace>/state.json` (pid + active session) on start so these
out-of-band commands work from a separate process; SIGTERM/SIGINT also end the run
cleanly. One run per project (cwd), so no run selector is needed.

## Config split
- `.mcp.json` — how to LAUNCH server (command, model API key + base url). Gitignored. Secret.
- `.ui-debugger-mcp.json` — how to DEBUG this app (models, targets, urls). Committed.

`.ui-debugger-mcp.json` shape:
```
models:  { driver, vision, summary? }   per-role; defaults: deepseek (text), glm (image)
targets:
  web:     { adapter: "browser", url, headless, debugLogin, executablePath, profile, cdpUrl }
  desktop: { adapter: "desktop", launch }
  mobile:  { adapter: "android", avd, emulatorPath, adbSerial }
workspace: "./tmp/ui-debugger-mcp"
```
managed vs attach: `cdpUrl` (web) / `adbSerial` (android) → attach, never start/stop.

## Per-project workspace
`./tmp/ui-debugger-mcp/<project>/`
- `chrome-user-data/` — persistent profile (login, cookies, storage).
- `sessions/<id>/` — `story.md`, `screenshots/`, `findings.json`, `logs/`.
- `logs/` — `console.log`, `network.log`, `agent.log`, `cdp.log`.
- `state.json` — session keyed by cwd.

## Login bypass (captcha)
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
- `docs/idea/overview.md` — the problem + the idea.
- `docs/idea/architecture.md` — full system design.
- `docs/idea/adapters.md` — adapter contract + targets.
- `docs/idea/desktop-control.md` — Linux tooling: X11/Wayland input, screenshots, AT-SPI, mobile.
- `docs/idea/agent-loop.md` — story → findings loop.
- `docs/idea/mcp-tools.md` — two tool layers, SQL-like params, in-repo system prompts.
- `docs/idea/models.md` — the three actors (smart agent / fast guy / vision guy), `look`, why CDP.
- `docs/idea/config.md` — `.mcp.json` + `.ui-debugger-mcp.json`.
- `docs/idea/workspace.md` — per-project space + logs.

## Note

Do not use git worktrees — work directly in this checkout. If a task is big enough to need subagents, run them as a team in this same checkout: split the work into disjoint pieces so no two agents touch the same files.
