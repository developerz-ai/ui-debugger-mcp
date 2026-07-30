# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **A managed android run is headless by default.** The adapter used to spawn
  `emulator @avd -port <p>` and nothing else, which opens a window on a desktop
  and *fails to boot at all* on a box with no display — `-no-window` on its own
  is not enough either, since the emulator still asks for a host GL context.
  Managed boot now passes `-no-window -gpu swiftshader_indirect -no-audio
  -no-boot-anim`, matching the web adapter's headless-by-default posture.

  Watching a run in a window is `"headless": false` on the target.

### Added

- `headless` (boolean, default `true`) and `emulatorArgs` (string[], appended
  verbatim) on android targets. Both are managed-only — attach binds to a
  serial and never launches anything.

## [1.7.0] - 2026-07-27

Two ways a run went wrong before it started: the project was still held by a run
nobody could name any more, or the driver had never been told that this app's
empty tables are the point.

### Added

- **`describe` reports the run the project holds, and `start_debug({replace:true})`
  takes it over.** One run per cwd, so a caller that crashed, was compacted, or
  simply forgot `end_session` was locked out — the next `start_debug` refused and
  the only way back was the out-of-band `ui-debugger-mcp stop`, in a shell an MCP
  client may not have. Now `describe` returns `session: { id, status, goal }` (the
  active run, or the retained snapshot of one that auto-ended), so the lost
  `session_id` is one read-only call away — adopt it with `get_findings`, close it
  with `end_session`. And `replace: true` ends the active run and starts yours.

  **Refusing stays the default**, and the refusal now names the id plus each of
  those calls verbatim. A silent takeover is the wrong default: it kills a healthy
  run whose own caller is still watching it. The takeover goes through the very
  method `end_session` calls — managed Chrome stopped, an attached browser only
  disconnected, timer cleared, profile lock freed — because a second teardown
  implementation would drift, and the drift would be a leaked browser sitting on
  the lock. It only ever replaces a run *this* server owns: one held by another
  live server is still refused (that browser is not ours to close), and so is a
  start still in flight (it owns no slot to hand over yet).

- **`notes` on a target — what is EXPECTED of this app.** A freshly-migrated app
  with no seed data renders empty states everywhere, and the driver reports "the
  table is empty" as the run's headline defect. It is right, and it is useless.

  ```jsonc
  "web": {
    "adapter": "browser",
    "url": "http://localhost:3000",
    "notes": "needs seeded data — empty tables are expected on /new\nfirst load shows an onboarding modal; dismiss it"
  }
  ```

  One fact per line, on any adapter. Unlike the per-run `goal`, this is config: it
  is composed into the system prompt once, as its own `## Known about this app`
  section ahead of the goal — *treat as expected, never `report` one as a bug; a
  screen that CONTRADICTS one still is a finding*. Notes are context, not a gag
  order.

  Bounded at 1000 characters and enforced when the config loads, naming the cap:
  that section rides along on every step (the prompt is resent each time), so an
  essay is paid for per step for the whole run. Never silently truncated — a
  caller has to know exactly what the driver was told. `describe` returns each
  target's `notes` verbatim.

## [1.6.0] - 2026-07-27

Almost every interesting screen is behind a login, so "how to log into this app"
was being retyped into every `goal` string — burning driver steps before the real
goal started and putting credentials into a free-text field that gets logged.
Now it lives in config and costs nothing.

### Added

- **Named auth personas.** A web target takes an `auth` map:

  ```jsonc
  "auth": {
    "admin": { "path": "/login", "fields": { "email": "admin@dev.local", "password": "admin" }, "submit": "Sign in" }
  }
  ```

  and `start_debug({ target: "dashboard", as: "admin", goal: "open Audit and …" })`
  opens the run already signed in. Field keys are matched most-specific first
  (`name` → `id`/`type` → `data-testid` → `aria-label` → `placeholder` → accessible
  name), and a key that already looks like a selector is used verbatim. Optional
  `expect` pins an explicit proof of success.

  **The login runs out-of-band**, between the first navigation and the driver's
  first step — the driver never performs it and never receives the values. A recipe
  in the system prompt would be resent to the provider on *every* step (the standing
  rule here is that a secret never enters the model's context), and an in-trail
  login spends 4-8 steps on work with one correct answer. The trail stays honest:
  the login's actions are recorded as steps, marked as the pre-run sign-in, with
  lengths where the values were.

  Everything fails loud and before the run: an unknown `as` is a `ConfigError`
  listing the valid names, and an unresolvable field/submit — or a submit that left
  the run still on the login page — is an `AuthError`. There is no path to a
  silently signed-out run, which would report every screen behind the login as an
  empty page.

  Persona values are redacted from every log line the run writes (`agent.log`,
  `network.log`, `console.log`), including the percent-encoded, `+`-for-space and
  JSON-escaped spellings a form POST produces. `describe` reports persona **names**
  per target, so a caller can pick a valid `as` without opening the config file.

- **`truncated` on a capped `get_findings` read.** A whole-object read still caps
  each list at 20, but now says so structurally — `truncated: { "steps": { "returned":
  20, "total": 57 } }` in the typed payload, declared in the output schema — not only
  in a prose note a caller can skip and conclude the run found exactly 20 issues.

### Changed

- **A dead dev server no longer costs a whole run.** `describe.operational` only
  ever meant "this adapter is wired"; it said nothing about whether
  `http://localhost:5173` was serving. A connection-refused / DNS navigation failure
  now ends the run at step zero with an error naming the address, instead of a
  driver reading an empty page and reporting it as a UI bug.

## [1.5.2] - 2026-07-27

### Changed

- **`init` now prints `@developerz.ai/ui-debugger-mcp@latest`** in the `.mcp.json`
  snippet, and every doc that shows an `npx` invocation is pinned to match.
  `npx -y <pkg>` REUSES a cached install when one exists, so a bare spec keeps
  launching whatever version first landed in `~/.npm/_npx` — with no signal that
  anything is stale. Observed: a client still booting 1.4.0 days after 1.5.0
  shipped. There is no auto-update — nothing in the server checks the registry —
  so the pin IS the update mechanism. A test now asserts the printed snippet
  carries it.

  Already stuck on an old version: `rm -rf ~/.npm/_npx`, then reconnect the
  server (`/mcp` in Claude Code). New troubleshooting entry in the README covers it.

## [1.5.1] - 2026-07-27

Prompt token diet. The driver's system prompt is resent on every step of every
run, so its size is a per-step tax — this cuts ~20% off it without dropping a
single rule.

### Changed

- **In-repo system prompts compressed** — driver base, all three target addenda
  (web/desktop/android), the vision guy, and the summary guy. Method is the
  compressed-config discipline from `claude-code-bible/docs/11-compressed-config.md`:
  lead with the rule not the reason, fragments over sentences, tables for
  structured data, value-words (`NEVER`/`ALWAYS`/`fails when`) over rhetoric, and
  code/selectors/tool syntax left byte-for-byte intact.

  | Composed system prompt | Before | After |
  |---|---|---|
  | web | 15,579 | 12,543 (−19.5%) |
  | desktop | 11,237 | 8,932 (−20.5%) |
  | android | 11,908 | 9,556 (−19.7%) |
  | vision guy | 2,669 | 2,122 (−20.5%) |
  | summary guy | 887 | 811 (−8.6%) |

  Every behavioural rule survives, including the ones added in 1.4.0 after real
  failures: the cross-origin ban, `clear: true` on re-typed fields, the
  false-positive bug bar, per-adapter selector dialects, and the
  unreported-run warning. The `schema-drift` tests — which run the real belt and
  assert the emitted selector/action strings appear verbatim in the matching
  prompt — caught three of the rewrites and were the gate on the rest.

  **Not validated against a live model run.** The rules and the drift tests are
  static guarantees; prompt quality is not. Watch the first runs after upgrading.

- `CLAUDE.md` trimmed (it was already compressed — ~2%).

## [1.5.0] - 2026-07-27

The workspace stops growing forever, and you can read it. Plus one real defect:
the replay video was silently dropping frames.

### Added

- **Session retention — the newest 5.** Every run left `story.md`,
  `findings.json`, the full `logs/` trail, every screenshot and a `replay.mp4`
  behind, and nothing ever removed them: an afternoon of dogfooding is hundreds
  of megabytes of `tmp/`. A starting run now prunes `sessions/` to the 5 most
  recent (itself included) as part of its own setup — before the browser
  launches, so the cost never lands mid-run. Fails loud (`WorkspaceError`)
  naming the directories rather than quietly accumulating. `chrome-user-data/`
  is never touched: the login still survives forever.

### Changed

- **Session ids are human-readable local timestamps.**
  `2026-07-27_14-30-05-0001` instead of `1784985071909-0001` — `ls sessions/`
  now tells you when each run happened without a converter. Fixed-width and
  zero-padded on purpose: byte order equals chronological order, which is what
  retention sorts by (no `stat` per directory, no race with a live run). No
  legacy format handling — old epoch-ms directories simply sort oldest and are
  the first pruned.

### Fixed

- **JPEG frames never made it into `replay.mp4`.** `look` re-captures a
  photo-heavy page as JPEG and saves it as `.jpg`, but `listScreenshots` matched
  `^(\d+)-(.*)\.png$` — so exactly the frames with the most visual content were
  dropped from the replay, leaving an unexplained hole in the sequence
  numbering. Both extensions now match.

### Verified

- **Two projects at once.** Two editor windows, two Claude Codes, two apps: the
  workspace root, Chrome profile, `sessions/`, `state.json`, the session
  registry and the retention prune are all keyed by cwd — including two
  checkouts sharing a basename, and two projects pointed at one absolute
  `workspace`. No defect found; pinned by `src/session/isolation.test.ts` so it
  stays that way.

## [1.4.0] - 2026-07-25

A four-way audit of every source file, plus a dogfood run against the in-repo
`dummy/web` fixture. Every entry below is a defect with a reproducing test, not a
refactor. The headline: a run could silently debug the **wrong application** and
report confident findings about it.

### Fixed

- **A run could wander off the app under test and never say so.** Driven at the local fixture with the goal "debug the Nimbus Store home page", the driver's *first* action was `navigate → https://nimbus-store.vercel.app` — a public site it inferred from the goal text. It never came back, and the run returned six fully-evidenced bugs (a CORS misconfiguration, a JS crash, a 404 favicon) about a stranger's production app, with nothing marking the target as lost. Two gaps, both ours: `story.md` never recorded the run's URL, so the driver's own context could not answer "where am I supposed to be"; and the "only navigate to URLs given in the goal" rule lived in the prompt with nothing enforcing it. Now the address is stated in the prompt and in `story.md`, and `act({action:"navigate"})` refuses a cross-origin hop, naming the origin the run belongs to. Paths and same-origin URLs pass; desktop/android, whose `navigate` means a window title or an app package, are unaffected.
- **Config-drift detection was dead in every installed copy.** `configFingerprint` hashed with `Bun.hash`, but the package ships `bin: dist/main.js` behind `#!/usr/bin/env node` — under Node that is a `ReferenceError`, which fell straight into the surrounding catch and returned `null`. Every comparison was `null !== null`, so the "you edited the config, reconnect" guard added in 1.3.0 never fired for anyone who installed it, while working perfectly under `bun run dev`. Now `node:crypto`, with the catch narrowed to `ENOENT` so a real read failure is loud. A test now bans Bun globals from shipped code outright.
- **An invalid `report` call ended the run with no verdict.** `stopWhen: hasToolCall('report')` fires on the tool *call*, and AI SDK 6 records a schema-rejected call in `step.toolCalls` without executing it. So one bad enum from the small driver model — `status: "pass"`, a `bugs[].kind` outside the union — stopped the loop after a full step budget and full token spend, leaving the stale `running` snapshot as the last thing on disk. It now stops on the report *result*, and a step whose `report` never executed still flushes its progress instead of dropping that step's console errors and look issues.
- **`observe` handed desktop and android web-only selector syntax.** The belt emitted Playwright forms (`role=button[name="Save" i]`, `data-testid="…"`) as `target` for every adapter, while the AT-SPI and uiautomator parsers accept only `button "Save"` or a bare name — and both addenda instruct the driver to copy `target` verbatim and never hand-craft a selector. Every click and type on a non-web target failed. Targets are now emitted in each adapter's own dialect, with a drift test that runs the real belt and asserts the emitted form appears in the matching prompt.
- **Two acts plus `report` in one step lost the second act.** The act queue chains on promises, so act #2 had not entered the trail's gate when `report`'s barrier checked it; the barrier returned early, the verdict recorded only act #1, and since the loop then stops, act #2 — which really ran against the live UI and saved a screenshot — reached no persisted file at all. The gate is now entered when an act is *queued*, not when it starts.
- **Server boot could hang forever.** The image-capability probe `fetch`ed `/models` with no timeout and is awaited before the stdio transport connects, so a base URL that accepts the connection and blackholes the request left the MCP client with a process that started and answered nothing. Capped at 5s.
- **Playwright hijacked the graceful shutdown.** `launchPersistentContext` installs its own SIGINT/SIGTERM handlers by default; Playwright's SIGINT handler calls `process.exit(130)` immediately after ours starts, so the terminal findings write, the summary and `replay.mp4` never landed and `state.json` stayed `running`. Signals now stay with the server.
- **A signal during launch skipped teardown entirely.** `endActive()` returns immediately when the session is not yet in the manager, which is the whole browser-launch window — so a client death mid-launch exited the process with nothing aborting the launch and the Chrome profile potentially left locked. Starts are now cancellable and awaited.
- **`stop` could wedge a project permanently.** Graceful shutdown was unbounded, so a tool call that never observed the abort left `process.exit` unreachable; meanwhile `stop` had already written `status: stopped` before signalling and thereafter refused to signal again. Shutdown now gives up after 10s and exits anyway.
- **A run was invisible to `status`/`stop` while it launched.** The `state.json` breadcrumb was written after build + open + start — 5-20s on a cold profile — so `stop` reported "no active debug run" while a real browser was up holding the lock. The breadcrumb is now written before the launch and cleared on every failure path.
- **`state.json` write failures were swallowed.** `record()` caught and discarded, making the service's own teardown branch dead code: on a full or read-only workspace `start_debug` returned a session id for a run that `status` and `stop` could never see. It now fails loud; `clear()` stays best-effort.
- **`target: "constructor"` bypassed the not-found check** by walking the prototype chain — it passed the guard, littered a session dir, then died as "unknown adapter type: undefined", while `describe` correctly called it not found.
- **One transient `mkdir` failure poisoned a run's persistence.** The store cached the rejected promise forever, so a momentary `EMFILE` meant every later write in that session failed — including the terminal `report` — and the run ended with no `findings.json`.
- **The post-verdict replay ran even when the session was already aborted**, orphaning ffmpeg past `process.exit` and writing findings after close.
- **Desktop `find` reported "no element matched" for elements that exist.** The AT-SPI walk stopped at `limit` counting *query* matches, but `filters` are applied afterwards — so `find({query:'Save', filters:{enabled_eq:true}})` stopped at the first disabled "Save" and never reached the enabled one.
- **`xdotool search --name` took a POSIX regex while the title arrived as a literal**, so a window titled `MyApp (dev)` was never found and `open` failed with "window not found" against a window plainly on screen.
- **A zero-size android region swiped at the screen origin.** A not-yet-laid-out list reports `[0,0][0,0]`; `scroll({within})` then issued a 2px gesture at the top-left corner with negative Y — a notification-shade pull — and reported it as a successful scroll.
- **Managed teardown was SIGTERM-only and dropped the handle**, so a target that ignores SIGTERM was orphaned permanently with its profile lock held. Now escalates to SIGKILL after a grace period.
- **The AT-SPI walk had no wall-clock bound**, so a single `waitFor` poll against an accessibility-heavy app could overshoot its own timeout by minutes.
- **`AndroidTargetSchema` required `avd` in attach mode**, rejecting a physical device (`adbSerial` only) at boot unless the user invented an AVD name that was never used.
- **`console` and `network` reads truncated to `limit` silently** — a flow producing 120 failing requests reported as "50 failures" with no hint, in the same file that states failures are never hidden.
- **A `send_message` landing after the last step was drained and lost** with the caller believing it was delivered; pending messages now surface in the verdict.
- **`describe.workspace` returned the raw config string** (`./tmp/ui-debugger-mcp`) rather than the resolved per-project root, so a caller joining it to the relative paths it sees looked in the wrong directory.
- **Workspaces collided on `basename(cwd)`** when `workspace` was configured as an absolute shared path — two projects named `api` shared one `state.json`, profile and session history.
- **A streaming response left no trace at all.** The network row was buffered only *after* its body resolved, and an SSE stream, a long-poll or a stalled download only "finishes" when the page tears it down — so for the whole run there was no row for the driver to read and no line in `network.log`, as if the request had never been made. Rows are now recorded the moment the headers arrive and enriched in place; the body and header reads are capped at 2s and marked `<body not finished>` rather than holding the record hostage.
- **A connection reset mid-body was reported as a clean `200`.** Suppressing the post-response `requestfailed` echo (1.3.0) suppressed *every* late failure, not just `net::ERR_ABORTED` teardown — a response whose connection died while the body streamed was indistinguishable from a body-less success. Only the abort echo is dropped now; a real late failure amends the exchange in place, and re-emits its log line.
- **Credentials in a URL leaked into model context and the log.** Header *values* were redacted, but the URL was not — an OAuth callback (`?code=4/0Ae…`), a presigned S3 link (`?X-Amz-Signature=…`) or a `?api_key=` carries a live secret in the URL itself, and the URL is the one field that reaches the model on **every** network read and lands in `logs/network.log` verbatim. Credential-bearing query values are now `<redacted, N chars>` too.
- **Console locations pointed one line too high.** Playwright reports `line`/`column` 0-based; `url:line:col` is read (and opened in an editor) 1-based, so every stack location the driver reported to the smart agent was off by one in both axes.
- **`within` silently dropped everything inside an iframe.** The scope was re-resolved with `frame.locator(within)` inside each frame, and a scope living in the main document matches nothing in a child — so `find({within:'#checkout'})` returned zero of the embedded payment fields while reporting a successful, empty search. The scope is now resolved once to a page-coordinate rect that frames are tested against.
- **The off-viewport click guard was off for every attach target.** `viewportSize()` is null under `connectOverCDP` (it hard-codes `noDefaultViewport`), and null was read as "inside" — disabling the guard exactly where the window size is least predictable. The page is now asked directly before giving up.
- **Typing into a pre-filled field spliced the text mid-string.** `type` focuses with a click so it appends rather than replaces, but a click parks the caret wherever it landed — mid-value on an existing string — so the field read back as garbage the driver could not explain. The caret is moved to the end first.
- **`server.json`'s version was unchecked against `package.json`**, so a release could publish a registry entry pointing at a version that does not exist on npm.

### Changed

- **The replay clip is built to be attachable to a GitHub PR.** The encode named no codec, relying on ffmpeg's container default, and left the `moov` atom at the end — so playback stalled until the whole file downloaded. Now explicitly H.264/yuv420p with `+faststart`, and tuned with x264's `stillimage` preset: a replay is a slideshow of static frames whose entire value is the text burned into them, and the default psychovisual tuning smooths exactly the edges that text is made of. Measured on a real run: 21% smaller and sharper. Over GitHub's 10MB attachment limit, the clip is now called out in `agent.log` rather than failing on upload.
- **The vision frame is encoded for the cheapest transfer that keeps text legible.** Measured first, on a real 1280×720 app frame: PNG was **43KB**, JPEG q95 62KB, q90 49KB, q85 42KB — i.e. every JPEG quality that keeps small text crisp is *larger* than the PNG, and the one that finally wins on size is the one that starts ringing around glyph edges. Flat UI is exactly what PNG is good at, so a blanket switch to JPEG would have traded text quality for nothing. `look` now keeps PNG for anything under 400KB — which flat UI never exceeds — and falls back to JPEG q92 only for a photo-heavy frame where PNG genuinely blows up, then keeps whichever encoding actually came out smaller. The evidence saved to disk is always the exact bytes the vision model judged, with a matching extension.
- **An absolute `workspace` now stores each project under `<name>-<hash8>`.** Relative workspaces — the default and what `init` scaffolds — are byte-identical to before; installs using an absolute shared workspace start from a fresh Chrome profile once.
- `start_debug` fails loud when `state.json` cannot be written, instead of returning a session id for a run nothing can find.
- During launch, `status` reports the run and `stop` can signal it.

## [1.3.1] - 2026-07-24

Release automation only — the published package is unchanged from 1.3.0
(`files` is `dist`/`README`/`LICENSE`, none of which moved).

### Changed

- **MCP Registry publishing runs over OIDC in the same release job.** It follows `npm publish` and authenticates with `mcp-publisher login github-oidc` — the identity GitHub already mints for npm trusted publishing, so there is no token and no interactive login left in the release path. Ordering is load-bearing: the registry resolves the npm package named in `server.json` and rejects a version it cannot find.
- **The release job is re-runnable.** It skips `npm publish` when the version is already on npm, so a run that published and then failed downstream can be retried, and `workflow_dispatch` can publish only the registry half. Previously any retry died on E403 before reaching the remaining steps.

### Fixed

- **`PUBLISHING.md` documented the wrong tool.** It told you to run `npx mcp-publisher`, which fetches an unrelated npm package that starts a stdio MCP server and does nothing useful here. The real CLI is a Go binary released from `modelcontextprotocol/registry`; the doc now says so, and notes that `mcp-publisher validate` schema-checks `server.json` without auth.

## [1.3.0] - 2026-07-24

Found by dogfooding: a separate `claude -p` consumer drove this server against a
real SolidJS + Hono app while its transcript was mined for pain points. Every fix
below is a defect that consumer actually hit.

### Fixed

- **Shipped default model id was invalid** — `deepseek/deepseek-v4-flash#uptime` (the default `driver`, plus the example config and docs) is rejected by OpenRouter with `… is not a valid model ID` (HTTP 400), so a fresh install failed on its very first run, ~7s in, with no working config to copy from. Defaults are now plain catalog ids; `#` is documented as not-a-routing-suffix (`:floor`/`:nitro` are).
- **Config edits silently did nothing** — config is read once at boot, so a caller who fixed a bad model id and re-ran got the identical error with nothing indicating why. `start_debug` now compares a content fingerprint of `.ui-debugger-mcp.json` and refuses to run on a changed file, naming the reconnect as the fix (`config/fingerprint.ts`).
- **`start_debug` and `get_findings` contradicted each other** — a second MCP server was told "pid N holds session S" by one and "no session S exists" by the other, with no path forward; the observed consumer looped between them until it gave up. `get_findings` now serves a foreign run's on-disk findings, and the busy error points at it.
- **Concurrent acts interleaved keystrokes** — models batch `type` email + `type` password into one step and the SDK runs a step's tool calls in parallel, but keyboard input is dispatched at the page, not the element. A registration submitted `tTeessttuPsaesrs1TestPass123!…` as the password and the app accepted it — the run silently tested something other than what it typed. `act` calls are now serialized per run.
- **One exchange logged as two** — Chrome fires `requestfailed` (`net::ERR_ABORTED`) after a response when the connection is torn down (a logout that navigates), producing a clean `204` and a phantom `FAILED` at the same millisecond. Readers took the phantom for an outage. The echo is now suppressed; a request that never answered is still recorded.
- **Verdict-less runs got a fabricated diagnosis** — when the driver never called `report`, an empty findings set was handed to the summary model, which invented one: a run of 30 clean steps came back as "failed due to a non-functional crash … check for missing dependencies". The no-report case now writes the facts (steps run, why there is no verdict) and never calls the model; the summary prompt also forbids inferring causes absent from the input.
- **Step cap cut off the tool's own headline scenario** — register, log in, add two todos, toggle one, exercise three filters spent all 30 steps and died one action short of reporting, losing the entire run. `DEFAULT_MAX_STEPS` is 60; the 300s wall-clock cap still bounds cost.

### Added

- **Network entries are whole exchanges** — `durationMs` plus `requestBody`, `responseBody`, `requestHeaders`, `responseHeaders` for `fetch`/`xhr`. A `4xx` now carries the server's own reason (`{"error":"password too short"}`) instead of a bare status, which is the difference between a finding and a dead end. Bodies are capped and marked when truncated; credential header values are redacted to `<redacted, N chars>` so presence stays diagnostic while the secret never enters model context, logs, or findings. New filters: `duration_gte`, `body_contains`.
- **Network reads default to API traffic** — measured on a Vite dev server, static assets outnumbered real API calls 45:3, so an unfiltered tail of 50 rows returned zero API traffic. Successful assets are held back with a `hidden` count and the exact filter to reveal them; failed requests are never hidden, whatever their type.
- **iframe content is readable** — `readState` extracts from every frame, translates child-frame bounds into page coordinates (so coordinate clicks need no frame awareness) and tags nodes with `frame`; selector actions fall through frames to whichever holds the element. Embedded widgets were previously invisible to page-level locators.
- **Multi-tab support** — `observe({kind:"tabs"})`, `act({action:"switch_tab"})`, and optional `tabs`/`selectTab` on the adapter contract. Console/network capture follows a tab switch while keeping what was already buffered. Every `act` returns the tab list once more than one is open, so a `target="_blank"` click no longer reads as "nothing happened".
- **Live form state in the tree** — nodes now carry `value` (input/textarea/select contents) and `checked`. The extractor read `getAttribute('value')`, the markup's *initial* value, which never changes as the user types — and the accessible name resolves to the label or placeholder long before it would reach a value. So there was NO structural way to see what a field held, and a driver verifying its own input fell back to `look`: one observed run spent ~25 of its 60 steps asking vision "did my text land?" and died without a verdict. `name` still resolves to the label, so targeting is unchanged.
- **Driver + vision prompts rewritten against observed failures** — the driver was told to "re-`observe` after each `act`", which on a real run meant a full tree read per action and was the single largest budget sink; it now verifies narrowly and is told plainly that an unreported run produces nothing. Added a rule-yourself-out section (doubled text, invented selectors, guessed URLs, elements below the fold or in another frame are the driver's errors, not the app's — an observed run filed two of the debugger's own defects as app bugs) and a bug bar that excludes normal behaviour (a logged-out `401` probe, a request cancelled by navigation) — a run reported the pre-login 401 as a bug while annotating it "expected". The vision prompt now bounds itself to what is visible in one viewport (below-the-fold content is not "missing"; no hover/focus/animation/responsive claims), tells the model an empty `issues` list is a good answer rather than a failure to find something, keeps it out of judging content correctness, and has it point the driver back at the tree when asked to read a value off pixels.
- **`act({action:"type", clear:true})`** — replaces a field's contents instead of appending. Re-typing a used field produced `Finish project reportFinish project report`, which the driver then reported as an app bug.

## [1.2.0] - 2026-07-21

### Fixed

- **Android injection hardening** — `escapeInputText` now rejects control characters (< 0x20) with `AdapterError` instead of silently stripping them; mapped `\r`/`\r\n` to `KEYCODE_ENTER` between `type()` segments to handle line terminators as intentional input separators; added allowlist validation for agent-controlled `startArgs` via regex `^[\w.]+(/[\w.$]+)?$` before shelling to `am start`/`monkey` to prevent command injection.
- **Managed-serial binding** — Android adapter now spawns `emulator @avd -port <p>` on a free even port and binds every ADB call to `-s emulator-<p>` (instead of unbound `-e`), isolating per-instance and preventing collision with co-running emulators. `close` only targets its own instance via `emu kill -port`.
- **Findings discard on `report`** — merged driver-reported `bugs`/`visual` findings with accumulated `RunTrail` streamed findings instead of overwriting them. Added `mergeFindings` pattern (parallel to existing `mergeSteps`) to fuse vision-guy mid-run issues with driver-reported verdict.
- **Mid-run flush gate race** — fixed failed-step findings loss when `report` raced same-step `act` by gating on `toolCalls` instead of stale AI SDK 6 `toolResults` path; added `FailedStepSink` to record throws before rethrowing so findings survive a crash/abort right after.
- **Browser adapter hardening** — `closeOnFailure` closes just-opened context/browser if post-connect wiring throws, preventing zombie Chrome from squatting the profile lock; `createFailure` maps every `create()` failure to `AdapterError` with actionable profile-lock fix hints.
- **Desktop adapter hardening** — managed child exit code/signal (`Launched.died`) now races against window wait so bad `launch` rejects fast with real cause instead of generic 10s timeout; null `#windowMatch` throws before spawning. Subprocess calls capped at 30s timeouts (10s for busctl/xdotool, 30s for capture) with `SIGKILL` on expiry, surfaced as `ExecTimeoutError`.
- **MCP lifecycle corrections** — `startStdioServer` watches stdin for EOF since SDK transport doesn't, routing to `service.endActive()` for immediate browser/profile cleanup on client death. `DebugService` retains settled runs in memory so `get_findings` serves terminal snapshots post-timeout/SIGTERM. `start_debug` now gates via `StatePort.foreignRun()` to reject concurrent runs on the same cwd with clear "already running" errors.
- **CLI correctness** — unknown subcommands now exit(1) instead of hanging; workspace path anchored to absolute paths; dead-server state shows "unknown (server died)" when recorded pid is dead.
- **Config/init accuracy** — `buildSession` writes `story.md` on session creation; `profile`/`headless` config keys now honored (profile dir resolved to workspace-root-relative `chrome-user-data/` if unset, custom paths passed through, directories created as needed); `InitError` relocated to shared `errors.ts`.
- **Atomic state writes** — new `writeFileAtomic` pattern (temp file + rename keyed by pid+counter) backs both `writeState` and `writeFindings`, preventing partial writes on crash. CLI `stop` marks `stopped` before sending SIGTERM to prevent race where server's `markStatus('ended')` clobbers the status.

### Changed

- Split oversized test files to maintain 500-LOC cap: `android-adapter.test.ts` (→ parsers/lifecycle/behavior + test-helpers), `server.test.ts` (→ server + stdio), `session.test.ts` (→ lifecycle/findings/replay). Source adapters split: `browser-adapter.ts` (→ extractor/filters).
- MCP structured output: all five outer tools now declare `outputSchema` pinned to service interfaces via Zod `satisfies`, catching schema drift at compile time. Sparse `get_findings` projections use `.partial()` schema since field filters are intentionally selective.
- MCP annotations: added `destructiveHint`/`openWorldHint` to `start_debug`, `readOnlyHint` to `get_findings`/`describe`, `idempotentHint` to `end_session`, `send_message` wired for annotations completeness.
- Resource links in findings: `result.ts` now emits `resource_link` content (file:// URIs) for absolute evidence paths (screenshots, replay.mp4), capped at 20 items with steering to `get_findings fields=[...]` for overflow.
- Prompt alignment: self-look variant for multimodal drivers (drops "blind/vision-is-expensive" framing, tells driver to judge frames itself); desktop addendum neutralized vision-guy phrasing; contract clarity on `enabled` field = "disabled OR readonly" (must check `:disabled` incl. `fieldset[disabled]` inheritance, `readonly`, AND `aria-readonly`).

### Added

- Durable-write helper: `src/adapters/atomic-write.ts#writeFileAtomic` reusable pattern for crash-safe file writes.
- Timeout conversion tests: real-transport Zod-boundary validation (bad `url`, `timeout`>max, missing `goal`, `wait`>max) verifies schema enforcement at MCP tool layer.
- MCP Registry support: `server.json` + `mcp-publisher` docs for npm package registry publishing.
- Doc-example validation guard: `src/mcp/tools/doc-examples.test.ts` extracts fenced `tool_name { ... }` examples from README/reference, validates against live Zod schemas to catch doc drift.

## [1.1.0] - 2026-07-02

### Added

- **Self-look for multimodal drivers** — when `models.driver` and `models.vision` are the SAME model and the provider catalog confirms it takes image input (OpenRouter-style `/models` → `architecture.input_modalities`), `look` no longer round-trips to a separate blind vision call: it returns the screenshot itself as multimodal tool output and the driver judges the frame with its own eyes, in full conversation context. Only the newest frame stays in the transcript (older ones are pruned each step), so repeated looks never stack image tokens. Unknown capability (e.g. z.ai's catalog carries no modality info) keeps the safe separate-call path.
- **Structural contrast checks (no vision needed)** — text-bearing web nodes now carry an opt-in `style` column (`{ color, backgroundColor, contrast }`): computed text colour, effective (ancestor-resolved) background, and the WCAG contrast ratio. New `contrast_lt` filter sweeps a whole page for unreadable/invisible text in one `observe` call. The blind driver now catches white-on-white text and low-contrast copy without spending a vision token.
- **`data-testid` surfacing** — elements with a `data-testid` are always in the default tree, carry a `testid` column, and get a `data-testid="…"` `target` (preferred over role/name; also emitted on scoped reads, where positional targets are unsafe). Counters and values behind bare `<span>`s are now readable and re-checkable.
- **Bare tag-name queries** — `observe` tree queries like `span`, `img`, or `p, span, div` now resolve as CSS selectors instead of silently matching nothing as visible-text searches.

### Fixed

- **`look` no longer burns the run when the vision model is text-only** — a provider image-rejection (e.g. z.ai coding endpoint: `content.type is invalid, allowed values: ['text']`) now latches `look` off for the run with an actionable message (which model, what to change in `.ui-debugger-mcp.json`, and "do not call look again"). Previously the driver retried the same opaque provider error for many steps.
- **JSON-stringified `within` fails loud** — drivers routinely pasted a node back as a JSON string, which fell through as a `text=` selector and silently returned an empty tree. It now parses back into the node (or errors with guidance), ending the biggest observed step-waster.
- **Driver prompt corrections** — removed the fabricated `Runtime.evaluate` capability from the web addendum; added rules to test each repeated element individually (no "all buttons broken" over-generalization), to follow links by clicking instead of fabricating URLs from labels (no false-positive 404s), and to run a contrast sweep when the goal mentions readability.

## [1.0.0] - 2026-06-29

### Added

- **Android adapter** — full ADB + uiautomator support for mobile app automation with view hierarchy reading and vision fallback.
- **Desktop adapter** — X11/Wayland input control for Linux desktop apps with AT-SPI accessibility tree reading.
- **Video replay** — automatic stitching of screenshots into captioned `replay.mp4` for evidence and debugging.
- **CLI tools** — `init` (scaffold projects), `status` (check active runs), `stop` (graceful cleanup).
- **E2E test suite** — full-stack tests covering browser, desktop, and Android targets with key/scroll/replay verbs.
- **Inner debug agent** — effective text-only driver loop for autonomous UI testing: observe/act/look/report.
- **Outer MCP tools** — conversational interface (`start_debug`, `send_message`, `get_findings`, `describe`, `end_session`) for smart-agent integration.
- **Model provider abstraction** — OpenAI-compatible router (OpenRouter default) with per-role model selection (driver, vision, summarizer).
- **Session persistence** — per-project workspace with cwd-keyed sessions, screenshot archives, findings, logs.
- **Config system** — split `.mcp.json` (launch secrets) and `.ui-debugger-mcp.json` (debug config, committed).
- **Adapter contract** — unified interface across browser/desktop/mobile: `open · find · click · type · readState · screenshot · waitFor`.
- **Integration tests** — comprehensive test coverage for session lifecycle, tool execution, and adapter handoff.
- **Comprehensive docs** — design overview, architecture, adapter contracts, agent loop, MCP tool design, model strategy, config reference, workspace layout.

### Changed

- Stabilized stability hardening and CLI niceties for production readiness.
- Enhanced debug agent effectiveness for real-world web QA scenarios.
- Improved run controls and mid-run message injection for dynamic goal updates.

### Fixed

- Resolved contract completeness gaps with key + scroll verb implementations.

## [0.1.0] - 2026-01-15

### Added

- Initial MCP server foundation: dependencies, error handling, config parsing, schema validation, unit tests.
- Adapter contract design and initial browser adapter implementation (Chrome DevTools Protocol).
- Workspace path resolver and session lifecycle management.
- Model provider framework with prompt composition.
- Inner tool belt implementation: observe, act, look, report operations.
- Debug agent loop core with session wiring and mid-run message injection.
- Basic MCP server infrastructure (stdio, tool definitions).
