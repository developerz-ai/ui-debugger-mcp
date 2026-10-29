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
- `src/main.ts` — CLI entry (help/version/init/status/stop).
- `src/boot.ts` — server boot: owner-lock gate → config → workspace → provider/models → stdio MCP server.
- `src/mcp/` — MCP server, tool defs (few fat tools, NOT one-per-action).
- `src/agent/` — debug agent (Vercel AI SDK loop). The **fast guy** (driver) +
  the **vision guy** (eyes via `look`). Models per role via OpenAI-compatible
  router (OpenRouter default). Defaults: deepseek (text), qwen (image).
  - `prompts/` — OUR system prompts: in-repo, versioned, tested, provider-agnostic.
    NEVER rely on a 3rd-party model's defaults. Written compressed — they are
    resent every step (`../../sebyx07/claude-code-bible/docs/11-compressed-config.md`).
- `src/adapters/` — target control behind one shared contract.
  - `browser/` — web via CDP (headless default). ✅ shipped.
  - `desktop/` — X11/Wayland windows. Covers desktop app AND mobile emulator. ✅ shipped.
  - `android/` — ADB + uiautomator. ✅ shipped.
- `src/session/` — cwd-keyed session, per-project workspace, state.
- `src/config/` — load the project config (`.dz/ui-debugger/ui-debugger-mcp.json`
  first, root `.ui-debugger-mcp.json` fallback), resolve model/targets.
- `src/services/` — business logic. Thin handlers, logic here.
- `src/errors.ts` — custom error classes (base `UiDebuggerError` + `ConfigError` /
  `AdapterError` / `AuthError` / `AgentError` / `WorkspaceError` / `ProviderError` /
  etc.). No generic `Error`.

## Targets (one project, many)
| Target  | Adapter        | Protocol            | Reads              |
|---------|----------------|---------------------|--------------------|
| web     | browser        | CDP                 | DOM                |
| desktop | desktop        | X11/Xvfb; Wayland: wlroots capture (`grim`) only, no native input | a11y tree         |
| mobile  | android        | ADB (uiautomator)   | view hierarchy     |

Three adapters, one shared contract. Story names the target. iOS out of scope on Linux.

**managed** = server launches + owns the target; **attach** = connects to a running
one (`cdpUrl` for web, `adbSerial` for android) and NEVER starts/stops it. Managed
picks the binary via `executablePath`/`emulatorPath`.

## MCP tools (few, fat — not playwright-mcp)
A **conversation**, not a remote control. Small agent owns the clicking loop.
- `start_debug` — open a session with a goal `{ target, goal, criteria?, url?, as?, replace?, timeout? }`
  (`timeout` seconds; always capped — default 300s, max 2_147_483s (Node timer
  ceiling) — so a run never hangs forever).
  `url` (web targets only) overrides the target's configured url for this run;
  required when the target has none.
  `as` names a configured auth persona; the run signs in before the first step.
  `replace:true` takes the project over from an already-open run (opt-in only).
- `send_message` — talk to the small agent **mid-run** (add work, redirect, answer).
- `get_findings` — poll status + structured findings (functional + visual) + evidence.
  `wait` (int ms, 0..120_000) long-polls for a terminal verdict before reading;
  omit/0 reads now. `fields` projects a subset of findings keys
  (`status|steps|bugs|visual|summary|evidence`, min 1) and is never truncated.
  A whole-object read caps top-level lists at 20 items, attaching
  `truncated: { <field>: {returned,total} }` per capped field plus a steering
  note pointing at `fields=[...]`.
- `describe` — list targets/config for this project (lazy schema) + the run it holds.
  `target` narrows the catalog to a single entry; an unknown name fails loud
  (`TargetNotFoundError`).
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
- `init` → scaffold: create `./tmp/ui-debugger-mcp/`, write a starter config
  (deepseek/qwen defaults + `web` stub) if absent — at `.dz/ui-debugger/ui-debugger-mcp.json`
  when a `.dz/` dir exists, else root `.ui-debugger-mcp.json` — add `tmp/`
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
- Project config — how to DEBUG this app (models, targets, urls). Committed.
  Two candidate locations, one shape: `.dz/ui-debugger/ui-debugger-mcp.json`
  (checked FIRST; wins when both exist, with a one-line notice naming the ignored
  root file) or root `.ui-debugger-mcp.json` (legacy). A bad `.dz/` copy errors
  without reading root.

Project config shape:
```
models:  { driver, vision, summary? }   per-role; defaults: deepseek (text), qwen (image)
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
- `state.json` — session keyed by cwd.

The three log trails live in the SESSION, never at the project level:
`sessions/<id>/logs/{console,network,agent}.log` — `console` is the browser/app
console, `network` the request/response trail, `agent` the small agent's step
trail. Path pinned by `sessionPaths().logs` (`src/session/workspace.ts:150`),
written by `appendLog` (`src/session/findings-store.ts:157`).

Which files exist depends on the run: `console`/`network` come from the run's
capture sink — `CaptureSink` declared in `src/adapters/contract.ts` (re-exported
by `src/adapters/browser/cdp.ts`), written by `createCaptureSink`
(`src/services/session-builder.ts`) — threaded to the browser adapter (CDP
console + network) AND to the android adapter (logcat rows,
`src/adapters/factory.ts`). The web half is PUSH-based: the page's console
streams as it happens. The android half is READ-driven —
`AndroidAdapter.console()` streams the logcat rows it parses
(`src/adapters/android/android-adapter.ts:553`) — so a mobile run writes
`logs/console.log` only when the driver observes the console, and never writes
`logs/network.log` (ADB has no network channel). A desktop run writes neither.
`agent` is the agent sink (`src/services/session-builder.ts`).

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

**Redaction.** `createSecretRedactor` (`src/redact.ts` — the neutral home, a
sibling of `errors.ts`) is bound per run to the persona's values and wraps every
`logs/*.log` sink — plain, percent-encoded, `+`-for-space and JSON-escaped
spellings. Its signature is the named `Redactor` type, `(text: string) => string`,
which every redactor parameter is annotated with. `describe` exposes names only.

## Target `notes` — preconditions, not a goal
`targets.<t>.notes` (any adapter) = what is EXPECTED of this app: "needs seeded
data — empty tables are expected on /new", "onboarding modal on first load".

Per-target config, NOT the per-run `goal`. Composed once into the prompt as
`## Known about this app`, ahead of the goal: treat as expected, never `report`
one as a bug; a screen CONTRADICTING one still is a finding. Capped at
`TARGET_NOTES_MAX_CHARS` (1000) — fails loud at config validation, never
truncated. The section rides every step; that is what the cap is for. `describe`
returns it verbatim.

**Both consumers.** The same preconditions reach the SEPARATE vision model too —
the provider behind `look` — so a configured expected state (an empty table) is
not filed as a visual defect; a screen CONTRADICTING one is still reported.
Self-look (control == vision) needs nothing: the driver carries them already.

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

`bin/setup` prepares a fresh checkout: `bun install` (root) + builds the
dummy/web e2e fixture, downloads the pinned Chromium, then verifies the
headless-shell binary's shared libraries all resolve (`bun src/cli/chromium-libs.ts`)
— apt remediation only when libraries are actually missing and noninteractive
elevation is available, otherwise a loud failure naming every missing one, then
a real launch check. That library check runs inside `bin/setup` only; it is NOT
a public CLI subcommand (`main.ts` dispatches only init/status/stop).

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
One interface so the agent loop is adapter-blind (`src/adapters/contract.ts`):
required — `selectorDialect · open · find · click · type · pressKey · scroll ·
readState · screenshot · waitFor · console · network · close`;
optional — `tabs · selectTab · takeUnrequestedLoads` (web only: the belt says
"unsupported" for `tabs`/`switch_tab` off web, and skips the load queue
silently). `selectorDialect` is a readonly PROPERTY (`'web' | 'native'`), never
a method. `close()` stops a managed target; for attach it disconnects only.
Web → DOM. Desktop/mobile → a11y tree / view hierarchy — there is
no automatic vision/OCR fallback: the adapter never switches to pixels. The
only vision is the agent-level `look` (the vision model on a captured frame).

A custom-drawn surface (canvas, game, custom widget) exposes no a11y node, so
the adapter finds nothing there; Chromium/Electron need
`--force-renderer-accessibility`.

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
- `docs/idea/config.md` — `.mcp.json` + the project config (`.dz/…` or root).
- `docs/idea/workspace.md` — per-project space + logs.

## Note

NEVER use git worktrees — work directly in this checkout. Task big enough for
subagents → run them in this same checkout, split into disjoint pieces so no two
agents touch the same files.
