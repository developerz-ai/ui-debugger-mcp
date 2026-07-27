# UI Debugger MCP

Bun · TypeScript · Vercel AI SDK · OpenAI-compatible router (OpenRouter default).
MCP server that debugs UIs autonomously.

Smart agent hands a goal (a "story") to a small fast agent inside this server. The
small agent drives the target, gathers evidence, reports findings. Smart agent fixes
code, asks again. Loop until the UI works. No human clicking.

**Goal: stuff WORKS + LOOKS NICE.** Three actors (`docs/idea/models.md`):
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
  - `prompts/` — OUR system prompts: in-repo, versioned, tested, provider-agnostic.
    NEVER rely on a 3rd-party model's defaults. Written compressed — they are
    resent every step (`../../sebyx07/claude-code-bible/docs/11-compressed-config.md`).
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

**managed** = server launches + owns the target; **attach** = connects to a running
one (`cdpUrl` for web, `adbSerial` for android) and NEVER starts/stops it. Managed
picks the binary via `executablePath`/`emulatorPath`.

## MCP tools (few, fat — not playwright-mcp)
A **conversation**, not a remote control. Small agent owns the clicking loop.
- `start_debug` — open a session with a goal `{ target, goal, criteria?, as?, replace?, timeout? }`
  (`timeout` seconds; always capped — default 300s — so a run never hangs forever).
  `as` names a configured auth persona; the run signs in before the first step.
  `replace:true` takes the project over from an already-open run (opt-in only).
- `send_message` — talk to the small agent **mid-run** (add work, redirect, answer).
- `get_findings` — poll status + structured findings (functional + visual) + evidence.
- `describe` — list targets/config for this project (lazy schema) + the run it holds.
- `end_session` — close it.

NEVER ship click/type/screenshot as separate tools — that floods context.
Findings carry BOTH functional bugs AND visual/UX feedback ("how it looks").

Two layers (`docs/idea/mcp-tools.md`): outer = few conversational MCP tools (smart
Claude); inner = the debug agent's belt (`observe`/`act`/`look`/`report`), SQL-like,
heavily parameterized (`query`/`fields`/`filters`), one `act` not six. `look` = the
eyes: sends a screenshot to the **vision guy**.

`observe({kind})` reads `tree | screenshot | console | network | tabs`.
`act({action})` does `click | type | key | scroll | navigate | wait | switch_tab`,
and returns the tab list whenever more than one is open — a click that opens a tab
otherwise reads to a blind driver as "nothing happened".

A default `network` read hides *successful* static assets and reports `hidden` + how
to see them. Measured on a Vite dev server: 45 script loads to 3 API calls, so an
unfiltered tail of 50 returned zero API traffic. Failed requests are never hidden.

## CLI (bin: `ui-debugger-mcp`)
- no args → run the stdio MCP server (default).
- `init` → scaffold: create `./tmp/ui-debugger-mcp/`, write a starter
  `.ui-debugger-mcp.json` (deepseek/glm defaults + `web` stub) if absent, add `tmp/`
  to `.gitignore`, print the `.mcp.json` snippet. NEVER writes the API key.
- `status` → the active run for this cwd: session id, target, goal, server pid
  (+ alive?), verdict, finding counts. Reads `state.json` + `findings.json`. No API key.
- `stop` → SIGTERM the recorded server pid (graceful — the server ends the run,
  closes the browser, frees the profile), mark `stopped`.

The server drops `<workspace>/state.json` (pid + active session) on start so these
work from a separate process; SIGTERM/SIGINT also end the run cleanly. One run per
project (cwd) → no run selector needed.

## Config split
- `.mcp.json` — how to LAUNCH server (command, model API key + base url). Gitignored. Secret.
- `.ui-debugger-mcp.json` — how to DEBUG this app (models, targets, urls). Committed.

`.ui-debugger-mcp.json` shape:
```
models:  { driver, vision, summary? }   per-role; defaults: deepseek (text), glm (image)
targets:
  web:     { adapter: "browser", url, headless, notes, debugLogin, auth, executablePath, profile, cdpUrl }
  desktop: { adapter: "desktop", launch, notes }
  mobile:  { adapter: "android", adbSerial, notes }      attach — a real device
  mobile:  { adapter: "android", avd, emulatorPath? }   managed — `avd` only here
workspace: "./tmp/ui-debugger-mcp"
```
managed vs attach: `cdpUrl` (web) / `adbSerial` (android) → attach, never start/stop.

## Per-project workspace
`./tmp/ui-debugger-mcp/<project>/`
- `chrome-user-data/` — persistent profile (login, cookies, storage).
- `sessions/<id>/` — `story.md`, `screenshots/`, `findings.json`, `logs/`.
- `logs/` — `console.log`, `network.log`, `agent.log`.
- `state.json` — session keyed by cwd.

Session id **is** a local timestamp: `YYYY-MM-DD_HH-MM-SS-NNNN`
(`2026-07-27_14-30-05-0001`). Fixed-width, so byte order == time order.

A starting run **prunes** `sessions/` to the newest 5 (itself included) before the
browser launches — evidence is heavy and nothing else ever removed it. Fails loud
(`WorkspaceError`); `chrome-user-data/` is never touched.

Everything that could collide across concurrently-debugged projects is keyed by
cwd — workspace root, profile, `sessions/`, `state.json`, the session registry,
the prune. Two editor windows on two apps never see each other
(`src/session/isolation.test.ts`).

## Login bypass (captcha)
`?debug-ai=true` escape hatch in the app under test. Skips **captcha only**, not
auth. Gate behind `ALLOW_AI_DEBUG_LOGIN` so it's off in prod. Captchas are the #1
blocker for headless agents.

## Auth — named personas (`start_debug({as})`)
`targets.<t>.auth.<name> = { path, fields, submit, expect? }` (web only). The
recipe lives in config, not in every `goal` string.

**Out-of-band, not in-trail.** The login runs between `adapter.open()` and the
loop's first step (`services/login.ts`) — the driver never performs it. Steps are
the scarce resource, and the prompt is resent every step, so a recipe in it would
ship the password to the provider on each one. The prompt gets a NAME-only
"already signed in as X" section; the trail gets the login's steps, marked as the
pre-run sign-in, with lengths where the values were.

Fail loud, always before the run: unknown `as` (ConfigError listing valid names),
unresolvable field/submit, or a submit that left the run still on `path`
(AuthError). NEVER a silently signed-out run — that reports every screen behind
the login as an empty page.

**Redaction.** `createSecretRedactor` (`browser/log-format.ts`) is bound per run to
the persona's values and wraps every `logs/*.log` sink — plain, percent-encoded,
`+`-for-space and JSON-escaped spellings. `describe` exposes names only.

## Target `notes` — preconditions, not a goal
`targets.<t>.notes` (any adapter) = what is EXPECTED of this app: "needs seeded
data — empty tables are expected on /new", "onboarding modal on first load".

Per-target config, NOT the per-run `goal`. Composed once into the prompt as
`## Known about this app`, ahead of the goal: treat as expected, never `report`
one as a bug; a screen CONTRADICTING one still is a finding. Capped at
`TARGET_NOTES_MAX_CHARS` (1000) — fails loud at config validation, never
truncated. The section rides every step; that is what the cap is for. `describe`
returns it verbatim.

## One run per cwd — never a wedged project
A forgotten `end_session` must not need the out-of-band CLI to recover:
- `describe` reports `session { id, status, goal }` — the run this server holds
  (active OR the retained auto-ended snapshot). The way back to a lost id.
- `start_debug({replace:true})` — opt-in takeover: ends the active run via
  `DebugService.end` (the `end_session` path — NEVER hand-rolled teardown), then
  starts. Only a run THIS server owns; a foreign one still refuses (its browser is
  not ours to close), and neither is a start still in flight.

Refuse-and-explain stays the DEFAULT: a silent takeover kills a healthy run its
caller is watching. The refusal names the id + `get_findings`/`end_session`/
`replace:true`.

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
One interface so the agent loop is adapter-blind:
`open · find · click · type · readState · screenshot · waitFor · console · network`,
plus optional `tabs · selectTab` (web only — the belt says "unsupported" elsewhere).
Web → DOM. Desktop/mobile → a11y tree, fall back to vision/screenshots.

**Web reads cross document boundaries.** `readState` extracts from every frame,
translating child-frame bounds into page coordinates and tagging nodes with `frame`;
selector actions fall through to whichever frame holds the element. Iframe content is
otherwise invisible to page-level locators.

**Network entries are whole exchanges**, not status lines: `durationMs`, plus
`requestBody`/`responseBody`/`requestHeaders`/`responseHeaders` for `fetch`/`xhr`.
A failing request without its response body is a dead end — that is why this exists.
Credential header values are redacted to `<redacted, N chars>`: presence is
diagnostic, the secret must NEVER enter the model's context or the logs.

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

NEVER use git worktrees — work directly in this checkout. Task big enough for
subagents → run them in this same checkout, split into disjoint pieces so no two
agents touch the same files.
