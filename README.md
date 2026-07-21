# UI Debugger MCP

> An MCP server that debugs UIs **autonomously** — so the AI that wrote your app can also test it, without a human clicking through every flow.

## The problem

AI coding agents (Claude, etc.) are great at writing code. They're bad at
**knowing if the UI actually works**. For backend code there are unit and
integration tests. For UI, a human still has to open the app, log in, click
around, and report what's broken. That human-in-the-loop is slow, boring, and
the main bottleneck when an entire product is built by AI.

## The idea

Eliminate the human from the UI-debug loop with an MCP server.

- A **smart agent** (Claude Code, Cursor, …) finishes a PR and wants to verify the UI.
- It hands a **story** to this server: *"on web, log in and do X, Y, Z — tell me if it breaks."*
- A **small fast agent runs inside this server** (via the Vercel AI SDK). It drives
  the browser or desktop, watches console + network, takes screenshots.
- It reports **structured findings** back: pass/fail, what broke, evidence.
- The smart agent fixes the code and asks again. **Loop until the UI works.**

Unlike [playwright-mcp](https://github.com/microsoft/playwright-mcp) — where the
smart model issues every single click itself — here the smart model stays
high-level and delegates the whole clicking loop to the small agent.

## How it's different from playwright-mcp

| | playwright-mcp | UI Debugger MCP |
|---|---|---|
| Who clicks | smart model, one action per call | small agent, on its own |
| Tools exposed | many (click, type, snapshot…) | few (give a story, get findings) |
| Smart model cost | high (chatty) | low (high-level) |
| Output | raw page state | structured findings + evidence |

## Architecture — the three actors

Picture a **boss**, a **fast blind driver**, and a **describer with eyes**:

```
   ┌─────────────┐   MCP conversation    ┌──────────────────────────────────────┐
   │ smart agent │  start_debug ───────▶ │        UI Debugger MCP server         │
   │  (Claude)   │  send_message (live)  │                                       │
   │             │ ◀─────── get_findings │   ┌────────────┐     ┌────────────┐   │
   │ sets goals  │                       │   │  fast guy  │ look│ vision guy │   │
   │ fixes code  │                       │   │  (driver)  │────▶│  (eyes)    │   │
   │ loops       │                       │   │ deepseek   │◀────│  glm 5v    │   │
   └─────────────┘                       │   │ text·blind │ desc│ image      │   │
          ▲                              │   └─────┬──────┘     └────────────┘   │
          │ "works + looks nice"         │     observe / act (SQL-like)          │
          │ findings + screenshots       │         │ shared adapter contract     │
          └──────────────────────────────│─────────┼─────────────────────────────│
                                          └─────────┼─────────────────────────────┘
                                                    ▼
                              ┌──────────────┬──────────────┬──────────────┐
                              │  web (CDP)   │ desktop      │ android      │
                              │  browser     │ X11/Wayland  │ ADB          │
                              └──────────────┴──────────────┴──────────────┘
```

- **smart agent** — the boss (Claude/caller). Sends a goal, reads findings, **fixes
  the code**, loops. Stays high-level — never clicks.
- **fast guy** — the driver. Fast, cheap, **text-only and blind**. Runs the
  click loop on structure (DOM / a11y tree / view hierarchy). Default: deepseek.
- **vision guy** — the eyes. **Multimodal**. The driver calls `look` to ask
  *"does this look right? is the button centred?"* and gets a description back.
  Default: glm. Spent only when visual judgment is needed.

One goal: **the UI works *and* looks nice.** Full design in [`docs/idea/`](docs/idea/).

Every run keeps its screenshots and stitches them into a short **captioned
replay video** — Claude attaches it to the PR so a reviewer sees the flow working
in ~10 seconds ([`docs/idea/workspace.md`](docs/idea/workspace.md#pr-replay-video)).

## Targets

One project can expose several debug targets. A large app can have all three:

| Target  | Protocol / how it's driven                       | Reads |
|---------|--------------------------------------------------|-------|
| web     | **CDP** (Chrome DevTools Protocol), headless by default | DOM |
| desktop | **X11 / Wayland** input + AT-SPI                 | a11y tree / vision |
| mobile  | **ADB** (uiautomator + screencap), Android       | view hierarchy / vision |

Three adapters, one shared contract. Each runs **managed** (server launches the
target) or **attach** (connect to a running one via `cdpUrl` / `adbSerial`).
Linux first. iOS is out of scope on Linux (macOS-only tooling).

## Setup

Install like any local MCP server — one entry in your `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "ui-debugger": {
      "command": "npx",
      "args": ["-y", "@developerz.ai/ui-debugger-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1"
      }
    }
  }
}
```

It's also published in the official [MCP Registry](https://modelcontextprotocol.io/registry) as
`io.github.developerz-ai/ui-debugger-mcp` — any client that browses the registry (instead of a
hand-written `.mcp.json` entry) can find and install it by that name.

Then add a per-project `.ui-debugger-mcp.json` describing the app to debug
(models, targets, urls). The fastest way is the `init` command:

```bash
npx @developerz.ai/ui-debugger-mcp init   # in your project root
```

**`ui-debugger-mcp init`** scaffolds a project for debugging (described in
[`docs/idea/config.md`](docs/idea/config.md)):

- creates the workspace dir `./tmp/ui-debugger-mcp/`
- writes a starter `.ui-debugger-mcp.json` (default deepseek/glm models, a `web`
  target stub) if one doesn't already exist
- adds `tmp/` to `.gitignore`
- prints the `.mcp.json` snippet to paste (it never writes your API key)

Config files:

- `.mcp.json` → **how to launch** the server (command + secret key). Gitignored.
- `.ui-debugger-mcp.json` → **how to debug this app** (models, targets). Committed.

The server reads the **current directory** to pick the project session — open it
in your repo and it debugs that repo.

## Quickstart

```bash
# 1. Scaffold the project (run once in your app's root)
npx @developerz.ai/ui-debugger-mcp init
```

This creates `./tmp/ui-debugger-mcp/`, writes a starter `.ui-debugger-mcp.json`,
and prints the `.mcp.json` snippet to paste.

```jsonc
// 2. Paste into your project's .mcp.json (add your API key)
{
  "mcpServers": {
    "ui-debugger": {
      "command": "npx",
      "args": ["-y", "@developerz.ai/ui-debugger-mcp"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "OPENAI_BASE_URL": "https://openrouter.ai/api/v1"
      }
    }
  }
}
```

```jsonc
// 3. Edit .ui-debugger-mcp.json — set your app's URL
{
  "targets": {
    "web": { "adapter": "browser", "url": "http://localhost:3000" }
  }
}
```

```text
// 4. In Claude Code (or any MCP client):
start_debug { target: "web", goal: "log in and add item 3 to the cart", url: "http://localhost:3000" }

// 5. Poll until done:
get_findings { session_id: "...", wait: 30000 }

// 6. Read bugs[] + visual[] + summary. Fix code, repeat.
```

## Using it

It's a **conversation**, not a remote control — five fat tools, not one-per-click:

| Tool | What it does |
|------|--------------|
| `start_debug` | Open a run: `{ target, goal, url?, criteria?, timeout? }`. `url` is required when the target has no configured url. The small agent drives autonomously. Returns `{ session_id }`. |
| `get_findings` | Poll status + structured findings (functional bugs + visual issues) + evidence. Long-poll with `wait`. |
| `send_message` | Talk to the running agent mid-flight — add work, redirect, or answer a question. |
| `describe` | List the configured targets + models for this project. |
| `end_session` | Close the run, free the browser/profile. |

A run is **always time-capped**: `start_debug`'s `timeout` (seconds) overrides the
default 300s, so a session can never hang forever — it auto-ends and frees the
profile lock when the cap fires.

Every tool result carries **both** a pretty-printed text block and a typed
`structuredContent` payload validated against a declared `outputSchema` — parse
the structured half, don't scrape the text. Tools also declare MCP annotations
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) so clients
can render/gate them correctly, and evidence paths (screenshots, `replay.mp4`,
logs) ride as `resource_link` content items, not inline strings. Full shapes in
[`docs/reference.md`](docs/reference.md).

Typical loop from a smart agent:

```text
start_debug { target: "web", goal: "log in and add item 3 to the cart" }
→ poll get_findings (wait) until status is passed | failed
→ read bugs[] + visual[] + summary, fix the code, start_debug again
```

You can also drive it **headless** from a script with `claude -p` — see
[`docs/claude/SKILL.md`](docs/claude/SKILL.md) for the CLI recipe (MCP config,
allowed tools, output formats).

### CLI — check or stop a run

The `ui-debugger-mcp` binary doubles as a control CLI for the active run
(reads `state.json`, no API key needed):

```bash
ui-debugger-mcp status   # which run is active, server pid, verdict, finding counts
ui-debugger-mcp stop     # gracefully end the run (frees the browser + profile)
```

## Troubleshooting

**Chrome not found**
The web adapter launches Chrome via the system PATH. Install Chrome/Chromium, or
set `executablePath` in `.ui-debugger-mcp.json`:
```jsonc
"web": { "adapter": "browser", "url": "...", "executablePath": "/usr/bin/chromium-browser" }
```

**Session locked — "another run is active"**
One Chrome profile = one run. If a previous run crashed without cleaning up:
```bash
npx @developerz.ai/ui-debugger-mcp stop   # graceful teardown
```
Or delete `./tmp/ui-debugger-mcp/<project>/state.json` and restart the MCP server.

**Run times out with no findings**
Default cap is 300 s. Raise it per-call:
```text
start_debug { target: "web", goal: "...", timeout: 600 }
```
If the agent is stuck at login, add `?debug-ai=true` to your app's login route
(gated by `ALLOW_AI_DEBUG_LOGIN`) to skip captchas — see `CLAUDE.md` for the
pattern.

**`get_findings` returns empty `bugs[]` / `visual[]`**
The run may still be in progress — use `wait` (ms) to long-poll:
```text
get_findings { session_id: "...", wait: 30000 }
```
Check `./tmp/ui-debugger-mcp/<project>/sessions/<id>/logs/agent.log` for the agent's trace.

**`replay.mp4` not generated**
ffmpeg is optional. Install it and retry, or ignore — findings and screenshots
still land without it.

## Stack

- **Bun** + **TypeScript** (ships as npm, runs via `npx`/`bunx`)
- **Vercel AI SDK** — the agent loop (fast driver + vision describer)
- **Any OpenAI-compatible router** (OpenRouter default) — swap models per role.
  Defaults: **deepseek** (text) drives, **glm** (image) sees.
- **CDP** for web, **X11/Wayland** for desktop, **ADB** for Android
- stdio MCP transport

## Status

All three adapters ship in v1:

| Target  | State |
|---------|-------|
| web     | ✅ shipped (CDP, headless + attach) |
| desktop | ✅ shipped (X11/Wayland, AT-SPI + xdotool) |
| android | ✅ shipped (ADB, uiautomator) |

Replay video (`replay.mp4`, captioned stills → mp4 via ffmpeg) ships with the web adapter.
ffmpeg is optional — absent gracefully, findings still land.

See [`docs/idea/`](docs/idea/) for design notes.

## Docs

- [`docs/idea/overview.md`](docs/idea/overview.md) — problem + idea
- [`docs/idea/architecture.md`](docs/idea/architecture.md) — system design
- [`docs/idea/adapters.md`](docs/idea/adapters.md) — adapter contract + targets
- [`docs/idea/desktop-control.md`](docs/idea/desktop-control.md) — Linux control tooling (X11/Wayland/mobile)
- [`docs/idea/agent-loop.md`](docs/idea/agent-loop.md) — the story → findings loop
- [`docs/idea/mcp-tools.md`](docs/idea/mcp-tools.md) — two tool layers, SQL-like params, in-repo prompts
- [`docs/idea/models.md`](docs/idea/models.md) — the three actors (smart agent / fast guy / vision guy)
- [`docs/idea/config.md`](docs/idea/config.md) — config files
- [`docs/idea/workspace.md`](docs/idea/workspace.md) — per-project space + logs
- [`docs/claude/SKILL.md`](docs/claude/SKILL.md) — driving `claude` as a headless CLI tool (generic)
- [`CLAUDE.md`](CLAUDE.md) — instructions for AI agents working on this repo

## Credits / influences

- `ai-task-master` — build template (orchestrator + subagents), reference repo, not published
- `gold-standards-in-ai` — MCP & code conventions, reference repo, not published
- `claude-code-bible` — agent-first patterns ([sebyx07/claude-code-bible](https://github.com/sebyx07/claude-code-bible))
- [Model Context Protocol](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
