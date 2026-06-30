# Architecture

## Shape

```
 Smart agent (Claude / Cursor)              ← high-level: goals, feedback, fixes
        │  MCP (stdio)  — a conversation, not a remote control
        ▼
 ┌──────────────────────────────────────────────┐
 │  UI Debugger MCP server   (this repo)          │
 │                                                │
 │  MCP layer  — few fat tools                     │
 │  Session    — keyed by cwd, one at a time       │
 │  Debug agent — Vercel AI SDK loop               │  ← fast guy (text) + vision guy (image)
 │    OpenAI-compatible router (OpenRouter default) │
 │  Adapters                                       │
 │    browser (CDP) ── web                          │
 │    desktop (x11/wayland) ── desktop app           │
 │    android (ADB) ── mobile emulator / device     │
 │  Workspace  — ./tmp/ui-debugger-mcp/<project>/  │
 └──────────────────────────────────────────────┘
        │
        ▼
 The app under test  (web page / desktop app / mobile emulator)
```

## Components

| Component   | Job |
|-------------|-----|
| MCP layer   | Expose few tools. Carry the smart↔small conversation. |
| Session     | One per cwd. Holds the running debug agent + workspace. |
| Debug agent | Small model in a Vercel AI SDK loop. Owns the clicking. |
| Adapters    | Drive a target behind one shared contract. |
| Workspace   | Per-project scratch: profile, screenshots, logs, findings. |
| Config      | `.ui-debugger-mcp.json` (project) + `.mcp.json` (launch). |

## Why the brain is inside the server

The agent's models run **inside** this server (its own OpenAI-compatible key),
not in the caller. So:
- The smart agent sends **intent** ("log in, check checkout"), not keystrokes.
- The small agent burns its own (cheap) tokens on the clicking grind.
- The smart agent's context stays clean — it sees findings, not page dumps.

## Conversation, not one-shot

The smart agent and the small agent hold an **ongoing conversation** within a
session:
- Smart agent opens with a goal.
- Small agent works, streams progress + findings.
- Smart agent can **inject messages mid-run** — add work, redirect, ask a
  follow-up — while the small agent is still working.
- Either side can continue until the smart agent ends the session.

See [`agent-loop.md`](agent-loop.md).

## Three adapters, three targets

A large app exposes web + desktop + mobile. Browser adapter drives web (CDP).
Desktop adapter drives desktop apps (X11/Wayland, AT-SPI). Android adapter drives
mobile via ADB + uiautomator. See [`adapters.md`](adapters.md).

## Concurrency

One debug run per project at a time. The persistent Chrome profile locks itself,
and a single small agent keeps the loop simple. Parallel runs would need cloned
profiles — out of scope for now.

## Stack

- Bun + TypeScript, ships as npm (`npx`/`bunx`), stdio MCP.
- Vercel AI SDK for the agent loop (pattern from `../ai-task-master`).
- Any OpenAI-compatible router (OpenRouter default) so models are swappable.
  Defaults: deepseek (text) for driver/summary, glm (image) for vision.
- Zod at every boundary. Biome. Files ≤ 500 LOC. Custom errors.
