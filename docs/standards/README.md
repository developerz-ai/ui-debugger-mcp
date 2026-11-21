# Standards

The coding, structure and testing rules this repo already follows, each with the file it comes
from. `CLAUDE.md` is the source of truth; this page collects the rules in one place.

## Code

| Rule                                                                                                         | Source                                     |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Files at most 500 lines, one responsibility per file                                                         | `CLAUDE.md` (Coding Rules)                 |
| Strict TypeScript, no `any`, no non-null assertion, type-only imports, no default export                     | `CLAUDE.md`, `biome.json`, `tsconfig.json` |
| Zod at every boundary: config, MCP input, findings                                                           | `CLAUDE.md`, `docs/reference.md`           |
| Custom error classes under the `UiDebuggerError` base; never a generic `Error`                               | `CLAUDE.md`, `src/errors.ts`               |
| Fail fast and loud; no silent fallback (unknown persona, bad config, failed login all refuse before the run) | `CLAUDE.md`                                |
| Minimum code, no speculative abstraction, surgical changes                                                   | `CLAUDE.md`                                |
| Formatting is Biome's: 2 spaces, 100 columns, single quotes, semicolons, trailing commas, LF                 | `biome.json`                               |

## Structure

| Rule                                                                                                            | Source                                                |
| --------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| CLI entry `src/main.ts`; server boot `src/boot.ts`                                                              | `CLAUDE.md`                                           |
| Thin MCP handlers in `src/mcp/`; business logic in `src/services/`                                              | `CLAUDE.md`                                           |
| Few fat MCP tools, never one per action; click, type and screenshot are never separate tools                    | `CLAUDE.md`, `docs/idea/mcp-tools.md`                 |
| System prompts live in-repo under `src/agent/prompts/`, compressed and tested; never rely on a model's defaults | `CLAUDE.md`, `src/agent/prompts/schema-drift.test.ts` |
| Every target goes through the one adapter contract; the agent loop is adapter-blind                             | `src/adapters/contract.ts`, `docs/adapters-howto.md`  |
| Everything that could collide across projects is keyed by cwd                                                   | `CLAUDE.md`, `src/session/isolation.test.ts`          |
| Secrets never reach the model or the logs: every log sink is wrapped by the run's redactor                      | `src/redact.ts`, `CLAUDE.md` (Auth)                   |
| `.mcp.json` (launch, secret) is gitignored; the project config (how to debug the app) is committed              | `CLAUDE.md` (Config split), `docs/idea/config.md`     |

## Testing

| Rule                                                                                                                                                                             | Source                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Tests are colocated as `*.test.ts` next to the code they cover, run by `bun test`                                                                                                | `package.json`, `src/`                                                                                        |
| The unit suite stays under 10 s                                                                                                                                                  | `CLAUDE.md` (Commands), `CONTRIBUTING.md`                                                                     |
| CI and `bin/check` skip the flaky BrowserAdapter integration suite with `SKIP_BROWSER_INTEGRATION=1`; the e2e suite covers the real browser path against the `dummy/web` fixture | `bin/check`, `.github/workflows/ci.yml`, `src/dummy-web.e2e.test.ts`                                          |
| Repo guards are tests: no doc path escapes the repo root, the tracked tree names nothing private, CI and release workflows keep their shape                                      | `src/doc-paths.test.ts`, `src/public-tree.test.ts`, `src/ci-workflow.test.ts`, `src/release-workflow.test.ts` |
| The packed npm artifact is smoke-tested on the Node floor                                                                                                                        | `bin/smoke-packed`, `src/pack-smoke.test.ts`                                                                  |

## The gate

| Rule                                                                                                   | Source                                                     |
| ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `bin/setup` prepares a checkout: pinned Bun, deps, the `dummy/web` fixture, the pinned Chromium        | `bin/setup`, `CONTRIBUTING.md`                             |
| `bin/check` runs typecheck, lint, test; `bun run build` completes the four-step gate CI runs           | `bin/check`, `CONTRIBUTING.md`, `.github/workflows/ci.yml` |
| Branches `feat/<topic>` or `fix/<topic>`; one logical change per PR; commits `type: short description` | `CONTRIBUTING.md`                                          |
| Work in the one checkout, never git worktrees; parallel agents split disjoint files                    | `CLAUDE.md` (Note)                                         |
| CI `bun` job ceiling 18m (1080s): 960s install retry budget + ~30s rest of job + ~90s headroom         | `.github/workflows/ci.yml`, `CONTRIBUTING.md`              |

**CI `bun` job ceiling.** `timeout-minutes` is sized to the install retry budget, not to normal work:
three bounded attempts (3 × 300s) plus backoff (20s + 40s) is 960s, and the rest of the job (lint,
typecheck, test, build, e2e; the flaky BrowserAdapter integration suite is skipped in CI) was measured
at ~30s. That is ~990s (16.5m), so an 18-minute ceiling (1080s) leaves ~90s of headroom while still
giving every attempt its full 300s. The ceiling catches a catastrophic hang only: with 960s already
committed to retries it cannot detect a five-minute regression, and lowering it below the budget would
starve a legitimate retry. Never shrink the retry loop, its per-attempt 300s, or its 20s/40s backoff to
make room for a lower ceiling.
