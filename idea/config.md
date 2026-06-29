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
  "model": "openrouter/anthropic/claude-...",   // small-agent model, swappable
  "workspace": "./tmp/ui-debugger-mcp",
  "targets": {
    "web": {
      "adapter": "browser",
      "url": "http://localhost:3000",
      "headless": true,
      "debugLogin": { "param": "debug-ai" }       // skip captcha, not auth
    },
    "desktop": {
      "adapter": "desktop",
      "launch": "tesote-desktop"
    },
    "mobile": {
      "adapter": "desktop",
      "launch": "emulator @tesote",
      "window": "Tesote"
    }
  }
}
```

## Resolution order

1. message from the smart agent (overrides per session)
2. `.ui-debugger-mcp.json` (project)
3. env (`OPENROUTER_API_KEY`, base url)
4. built-in defaults (headless web, OpenRouter base url)

All Zod-validated. Bad config fails fast and loud.

## Why split

- Secrets (`.mcp.json`) stay out of the repo.
- Debug settings (`.ui-debugger-mcp.json`) stay in the repo, so every dev / agent
  that opens the project debugs it the same way.
- Matches the gold-standards rule: write project knowledge down, per project.

## OpenRouter

One key, any model. Use a cheap/fast model for the clicking grind; point at a
stronger one for a tricky flow by editing `model`. No code change.
