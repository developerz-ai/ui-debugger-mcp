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
      "args": ["-y", "@developerz.ai/ui-debugger-mcp@latest"],
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
npx @developerz.ai/ui-debugger-mcp@latest init   # run in the project root
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
    "driver": "deepseek/deepseek-v4-flash",        // fast guy — controls (blind, text)
    "vision": "qwen/qwen3-vl-32b-instruct",        // vision guy — describes screenshots
    "summary": "deepseek/deepseek-v4-flash"         // optional — compress findings
  },
  "workspace": "./tmp/ui-debugger-mcp",
  "targets": {
    "web": {
      "adapter": "browser",
      "url": "http://localhost:3000",
      "headless": true,                            // optional — defaults to true
      "notes": "needs seeded data — empty tables are expected on /new",  // preconditions — see below
      "debugLogin": { "param": "debug-ai" },      // skip captcha, not auth
      "auth": {                                    // named login personas — see below
        "admin": {
          "path": "/login",
          "fields": { "email": "admin@dev.local", "password": "admin" },
          "submit": "Sign in"
        }
      },
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

## `notes` — what is EXPECTED of this app (any adapter)

A freshly-migrated app with no seed data renders empty states everywhere, and the
driver correctly-but-uselessly reports *"the table is empty"* as the run's
headline defect. `notes` is where the preconditions live, so the driver is told
once instead of finding out the expensive way.

```jsonc
"web": {
  "adapter": "browser",
  "url": "http://localhost:3000",
  "notes": "needs seeded data — empty tables are expected on /new\nfirst load shows an onboarding modal; dismiss it\ndark mode is the default theme"
}
```

| | `notes` (this) | `goal` (`start_debug`) |
|---|---|---|
| Scope | the target — **every** run against this app | one run |
| Lives in | `.ui-debugger-mcp.json`, committed | the call |
| Says | what is always true | what to do this time |

One fact per line. They become a `## Known about this app` section of the composed
system prompt (`agent/prompts/compose.ts`), ahead of the goal: *stated by the
project, treat as expected, never `report` one as a bug — and a screen that
CONTRADICTS one IS worth reporting*. A note is context, not a gag order.

**Bounded, and loud about it.** Max 1000 characters (`TARGET_NOTES_MAX_CHARS`),
enforced at config validation — over it, the config fails to load naming the cap.
This section is part of the system prompt, which is resent to the provider on
EVERY step, so an essay here is paid for per step for the whole run. It is never
silently truncated: a caller has to know exactly what the driver was told.

`describe` returns each target's `notes` verbatim, so the caller can see what the
run was told without opening the file.

## `auth` — named login personas (web)

`debugLogin` skips a **captcha**, never auth. `auth` is where "how to sign into
this app" lives, so it is written once instead of re-typed into every `goal`.

```jsonc
"auth": {
  "admin": { "path": "/login", "fields": {…}, "submit": "Sign in" },
  "user":  { "path": "/login", "fields": {…}, "submit": "Sign in", "expect": "text=Sign out" }
}
```

Then `start_debug({ target: "dashboard", as: "admin", goal: "open Audit and …" })`.

| Key | Meaning |
|-----|---------|
| `path` | login page — relative to the target `url`, or absolute |
| `fields` | hint → value. The KEY locates the control, the VALUE is typed |
| `submit` | the control that submits — a button/link label, or a selector |
| `expect` | optional proof of success: something only a signed-in page renders |

**Field keys** are tried most-specific first: `name`, then `id`/`type`, then
`data-testid`, then `aria-label`, then `placeholder`, then the accessible name.
A key that already looks like a selector (`#user`, `[data-testid='email']`,
`input[name=u]`, `css=…`) is used verbatim.

**The login runs out-of-band**, between the first navigation and the driver's
first step — the driver never performs it and never receives the values. Two
reasons: a recipe in the system prompt would be resent to the provider on *every*
step (the repo's rule is that a secret never enters the model's context), and an
in-trail login spends 4-8 of the run's steps on work with one correct answer. The
trail stays honest — the login's actions are recorded as steps, marked as the
pre-run sign-in, with lengths where the values were.

**Everything fails loud, before the run:**

| Situation | What happens |
|-----------|--------------|
| `as` names no configured persona | `ConfigError` listing the valid names |
| `as` on a non-web target | `ConfigError` |
| a field / the submit control does not resolve | `AuthError` naming it and the URL |
| submitting left the run on `path` | `AuthError` — never a signed-out run |
| `expect` set but never appears | `AuthError` |

The last two matter most: a run that silently continues logged out reports every
screen behind the login as an empty page, which reads to the caller exactly like
a real UI bug.

**Redaction.** Persona values never reach the system prompt, and every line this
run writes to `logs/agent.log`, `logs/network.log` and `logs/console.log` is
passed through a value-keyed redactor first (`<redacted, N chars>`), including the
percent-encoded, `+`-for-space and JSON-escaped spellings a form POST produces.
`describe` reports persona **names** only.

**These are dev credentials in a committed file.** Point `auth` at a local/seeded
environment, never at production secrets — same posture as any seed fixture.

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
- `profile` resolves against the workspace root (`chrome-user-data` →
  `<workspace>/<project>/chrome-user-data`); an absolute path is used as-is. Unset
  → the default `chrome-user-data/`. The dir is created if missing.
- `headless` is optional and defaults to `true`.

## Resolution order

1. message from the smart agent (overrides per session)
2. `.ui-debugger-mcp.json` (project)
3. env (`OPENAI_API_KEY`, `OPENAI_BASE_URL`)
4. built-in defaults — managed + headless web, OpenRouter base url, and:
   - `driver` → `deepseek/deepseek-v4-flash` (text)
   - `vision` → `qwen/qwen3-vl-32b-instruct` (image)
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
  strings are `provider/model`, with optional routing suffixes passed through
  verbatim (`:floor` cheapest, `:nitro` fastest). Suffixes are NOT free-form: a
  `#…` suffix is rejected outright (`… is not a valid model ID`, HTTP 400), so
  the shipped defaults are plain catalog ids. If a run dies at step zero with
  that message, the model string in your config is the thing to fix.
- **z.ai, DeepSeek, OpenAI, local (vLLM/Ollama), …** — point `OPENAI_BASE_URL`
  at their OpenAI-compatible URL and use that provider's model names.

### Defaults (deepseek for text, glm for image)

| Role | Default | Why |
|------|---------|-----|
| `driver`  | `deepseek/deepseek-v4-flash` | fast, cheap, text — the high-frequency click loop |
| `vision`  | `qwen/qwen3-vl-32b-instruct` | multimodal — describes screenshots, judges looks |
| `summary` | `deepseek/deepseek-v4-flash` | compress findings for the smart agent |

Override any role in `.ui-debugger-mcp.json`. Cheap fast model drives; the
vision model is spent only when eyes are needed. No code change to swap.
