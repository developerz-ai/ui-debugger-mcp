# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
