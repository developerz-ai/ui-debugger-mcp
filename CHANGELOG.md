# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
