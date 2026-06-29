# Config

Two files. Clean split: secrets vs project settings.

## `.mcp.json` — how to launch (gitignored, secret)

Standard local MCP server entry. The smart agent's host (Claude Code, Cursor, …)
reads it and spawns this server over stdio.

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

- Holds the **model API key + base URL** (the agent's brains run in-server).
- Any **OpenAI-compatible router** — `OPENAI_BASE_URL` + `OPENAI_API_KEY`.
  Default base URL: OpenRouter. Also works: z.ai, DeepSeek, or any
  OpenAI-compatible endpoint. See *Providers* below.
- Gitignored — never commit the key.
- `bunx` works too.

## Bootstrapping — `ui-debugger init`

The `ui-debugger-mcp` bin has two modes: no args runs the stdio server; `init`
scaffolds a project so you don't write config by hand.

```bash
npx @developerz.ai/ui-debugger-mcp init   # run in the project root
```

`init` (idempotent — won't clobber existing files):
1. creates the workspace dir `./tmp/ui-debugger-mcp/`
2. writes a starter `.ui-debugger-mcp.json` — deepseek/glm model defaults + a
   `web` target stub (`http://localhost:3000`) — only if absent
3. adds `tmp/` to `.gitignore`
4. prints the `.mcp.json` snippet to paste (never writes your API key)

Then edit targets/urls to match the app. The dir + config are all the server
needs to start a session for that project.

## `.ui-debugger-mcp.json` — how to debug this app (committed)

Per-project. Lives in the repo, travels with it. Describes the app + targets.

```jsonc
{
  "models": {                                    // per-role, swappable — see models.md
    "driver": "deepseek/deepseek-v4-flash#uptime",  // fast guy — controls (blind, text)
    "vision": "z-ai/glm-5v-turbo",                  // vision guy — describes screenshots
    "summary": "deepseek/deepseek-v4-flash"         // optional — compress findings
  },
  "workspace": "./tmp/ui-debugger-mcp",
  "targets": {
    "web": {
      "adapter": "browser",
      "url": "http://localhost:3000",
      "headless": true,
      "debugLogin": { "param": "debug-ai" },      // skip captcha, not auth
      // --- managed mode (default): server launches + owns Chrome ---
      "executablePath": null,                      // null = auto-detect Chrome/Chromium
      "profile": "chrome-user-data",               // persistent profile dir under the workspace
      // --- attach mode: connect to an already-running browser ---
      "cdpUrl": null                               // set → attach over CDP, server does NOT start/stop it
    },
    "desktop": {
      "adapter": "desktop",
      "launch": "my-desktop-app",                  // command the server runs (managed)
      "window": { "title": "My Desktop App" },     // which window to drive (WM_NAME/WM_CLASS); omit → launched window
      "display": null                              // X11 DISPLAY, e.g. ":99" for Xvfb; null = inherit env
    },
    "mobile": {
      "adapter": "android",                        // ADB-driven (uiautomator + screencap)
      // --- managed mode (default): server boots the emulator ---
      "avd": "my-avd",                             // emulator @my-avd
      "emulatorPath": null,                        // null = auto-detect from SDK
      // --- attach mode: talk to an already-running device/emulator ---
      "adbSerial": null                            // e.g. "emulator-5554" or "host:5555" → attach, no start/stop
    }
  }
}
```

## Browser session: managed vs attach

The server runs the web target one of two ways, picked by `cdpUrl`:

| | **Managed** (default, `cdpUrl` unset) | **Attach** (`cdpUrl` set) |
|---|---|---|
| Who owns Chrome | the server launches it | already running, someone else's |
| Start / stop | server's job | **never** — not its process |
| Profile | persistent dir under the workspace | whatever that browser already uses |
| Binary | `executablePath` or auto-detected | n/a |
| Use case | normal local debugging | a live/staging browser, a container, a remote CDP endpoint |

Rules:
- **Only launch/stop Chrome in managed mode.** If a `cdpUrl` is given, attach and
  drive it; do not touch its lifecycle or its profile.
- `executablePath` lets the user point at a specific Chrome/Chromium binary
  (channel, flatpak, custom build). Null → auto-detect. Managed mode only.
- Persistent profile (login, cookies) is a **managed-mode** feature — see
  [`workspace.md`](workspace.md). In attach mode the browser keeps its own state.

## Resolution order

1. message from the smart agent (overrides per session)
2. `.ui-debugger-mcp.json` (project)
3. env (`OPENAI_API_KEY`, `OPENAI_BASE_URL`)
4. built-in defaults — managed + headless web, OpenRouter base url, and:
   - `driver` → `deepseek/deepseek-v4-flash#uptime` (text)
   - `vision` → `z-ai/glm-5v-turbo` (image)
   - `summary` → `deepseek/deepseek-v4-flash` (text)

All Zod-validated. Bad config fails fast and loud.

## Why split

- Secrets (`.mcp.json`) stay out of the repo.
- Debug settings (`.ui-debugger-mcp.json`) stay in the repo, so every dev / agent
  that opens the project debugs it the same way.
- Matches the gold-standards rule: write project knowledge down, per project.

## Providers — OpenAI-compatible routers

We talk to **any OpenAI-compatible endpoint**: one `OPENAI_BASE_URL` +
`OPENAI_API_KEY`. No vendor lock-in (same posture as `../ai-task-master`).

- **OpenRouter** (default base url) — one key reaches every provider; model
  strings are `provider/model`, with optional routing suffixes
  (e.g. `deepseek/deepseek-v4-flash#uptime` — `#uptime` is OpenRouter routing,
  passed through verbatim).
- **z.ai, DeepSeek, OpenAI, local (vLLM/Ollama), …** — point `OPENAI_BASE_URL`
  at their OpenAI-compatible URL and use that provider's model names.

### Defaults (deepseek for text, glm for image)

| Role | Default | Why |
|------|---------|-----|
| `driver`  | `deepseek/deepseek-v4-flash#uptime` | fast, cheap, text — the high-frequency click loop |
| `vision`  | `z-ai/glm-5v-turbo` | multimodal — describes screenshots, judges looks |
| `summary` | `deepseek/deepseek-v4-flash` | compress findings for the smart agent |

Override any role in `.ui-debugger-mcp.json`. Cheap fast model drives; the
vision model is spent only when eyes are needed. No code change to swap.
