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
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```

- Holds the **model API key** (the small agent's brain runs in-server).
- Gitignored — never commit the key.
- `bunx` works too.

## `.ui-debugger-mcp.json` — how to debug this app (committed)

Per-project. Lives in the repo, travels with it. Describes the app + targets.

```jsonc
{
  "models": {                                    // per-role, swappable — see models.md
    "driver": "openrouter/...",                  // fast text — controls (blind)
    "vision": "openrouter/...",                  // multimodal — describes screenshots
    "summary": "openrouter/..."                  // optional — compress findings
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
      "launch": "tesote-desktop"
    },
    "mobile": {
      "adapter": "android",                        // ADB-driven (uiautomator + screencap)
      // --- managed mode (default): server boots the emulator ---
      "avd": "tesote",                             // emulator @tesote
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
3. env (`OPENROUTER_API_KEY`, base url)
4. built-in defaults (managed + headless web, OpenRouter base url)

All Zod-validated. Bad config fails fast and loud.

## Why split

- Secrets (`.mcp.json`) stay out of the repo.
- Debug settings (`.ui-debugger-mcp.json`) stay in the repo, so every dev / agent
  that opens the project debugs it the same way.
- Matches the gold-standards rule: write project knowledge down, per project.

## OpenRouter

One key, any model. Use a cheap/fast model for the clicking grind; point at a
stronger one for a tricky flow by editing `model`. No code change.
