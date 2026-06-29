# UI Debugger MCP

> An MCP server that debugs UIs **autonomously** — so the AI that wrote your app can also test it, without a human clicking through every flow.

## The problem

AI coding agents (Claude, etc.) are great at writing code. They're bad at
**knowing if the UI actually works**. For backend code there are unit and
integration tests. For UI, a human still has to open the app, log in, click
around, and report what's broken. That human-in-the-loop is slow, boring, and
the main bottleneck when an entire product (like `tesote.ai`) is built by AI.

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
   │  smart-ass  │  start_debug ───────▶ │        UI Debugger MCP server         │
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

- **smart-ass** — the boss (Claude/caller). Sends a goal, reads findings, **fixes
  the code**, loops. Stays high-level — never clicks.
- **fast guy** — the driver. Fast, cheap, **text-only and blind**. Runs the
  click loop on structure (DOM / a11y tree / view hierarchy). Default: deepseek.
- **vision guy** — the eyes. **Multimodal**. The driver calls `look` to ask
  *"does this look right? is the button centred?"* and gets a description back.
  Default: glm. Spent only when visual judgment is needed.

One goal: **the UI works *and* looks nice.** Full design in [`idea/`](idea/).

## Targets

One project can expose several debug targets. `tesote.ai` has all three:

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

Then add a per-project `.ui-debugger-mcp.json` describing the app to debug
(models, targets, urls). The fastest way is the `init` command:

```bash
npx @developerz.ai/ui-debugger-mcp init   # in your project root
```

**`ui-debugger init`** scaffolds a project for debugging (described in
[`idea/config.md`](idea/config.md)):

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

## Stack

- **Bun** + **TypeScript** (ships as npm, runs via `npx`/`bunx`)
- **Vercel AI SDK** — the agent loop (fast driver + vision describer)
- **Any OpenAI-compatible router** (OpenRouter default) — swap models per role.
  Defaults: **deepseek** (text) drives, **glm** (image) sees.
- **CDP** for web, **X11/Wayland** for desktop, **ADB** for Android
- stdio MCP transport

## Status

Early. This repo currently holds the design only — see [`idea/`](idea/).

## Docs

- [`idea/overview.md`](idea/overview.md) — problem + idea
- [`idea/architecture.md`](idea/architecture.md) — system design
- [`idea/adapters.md`](idea/adapters.md) — adapter contract + targets
- [`idea/desktop-control.md`](idea/desktop-control.md) — Linux control tooling (X11/Wayland/mobile)
- [`idea/agent-loop.md`](idea/agent-loop.md) — the story → findings loop
- [`idea/mcp-tools.md`](idea/mcp-tools.md) — two tool layers, SQL-like params, in-repo prompts
- [`idea/models.md`](idea/models.md) — the three actors (smart-ass / fast guy / vision guy)
- [`idea/config.md`](idea/config.md) — config files
- [`idea/workspace.md`](idea/workspace.md) — per-project space + logs
- [`CLAUDE.md`](CLAUDE.md) — instructions for AI agents working on this repo

## Credits / influences

- [`ai-task-master`](../ai-task-master) — build template (orchestrator + subagents)
- [`gold-standards-in-ai`](../gold-standards-in-ai) — MCP & code conventions
- [`claude-code-bible`](../../sebyx07/claude-code-bible) — agent-first patterns
- [Model Context Protocol](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
