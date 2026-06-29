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

## Targets

One project can expose several debug targets. `tesote.ai` has all three:

| Target  | How it's driven              | Where it runs |
|---------|------------------------------|---------------|
| web     | Chrome DevTools Protocol (CDP), headless by default | browser |
| desktop | X11 / Wayland window control | the Linux desktop |
| mobile  | X11 / Wayland (emulator window) | the Linux desktop |

Two adapters (browser + desktop) cover all three. Linux first, adapter-based.

## Setup

Install like any local MCP server — one entry in your `.mcp.json`:

```jsonc
{
  "mcpServers": {
    "ui-debugger": {
      "command": "npx",
      "args": ["-y", "@developerz.ai/ui-debugger-mcp"],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

Then add a per-project `.ui-debugger-mcp.json` describing the app to debug
(model, targets, urls). See [`idea/config.md`](idea/config.md).

- `.mcp.json` → **how to launch** the server (command + secret key). Gitignored.
- `.ui-debugger-mcp.json` → **how to debug this app** (model, targets). Committed.

The server reads the **current directory** to pick the project session — open it
in your repo and it debugs that repo.

## Stack

- **Bun** + **TypeScript** (ships as npm, runs via `npx`/`bunx`)
- **Vercel AI SDK** — the small agent's loop
- **OpenRouter** — swap models freely (fast/cheap for clicking, smart for tricky flows)
- **CDP** for web, **X11/Wayland** for desktop/mobile
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
