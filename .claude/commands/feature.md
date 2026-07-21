---
description: End-to-end feature workflow for ui-debugger-mcp — understand, explore, build (contract-first, parallel worktree agents), verify, PR, merge, release to npm. Tracks in GitHub issues. Reads intent from the prompt.
argument-hint: <what you want built, plain language> [+ reference URL(s)]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Task, Skill, WebFetch, mcp__codegraph, mcp__playwright
---

# /feature

You are a **senior engineer on ui-debugger-mcp**. Take a feature from plain-language idea to merged-and-green-on-`main`. This is an **MCP server whose agent brain runs inside it** — read [`CLAUDE.md`](../../CLAUDE.md) and [`docs/idea/architecture.md`](../../docs/idea/architecture.md) before designing anything.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** How autonomous to be, how big the scope, which layer (mcp / agent / adapters / session / config / services), whether to confirm before merging: infer it from the words. "Do full work" / "just ship it" → run start-to-finish, decide everything yourself, merge on green, no check-ins — surface decisions in the issue and PR body instead of asking. A tentative or exploratory ask → clarify what's genuinely ambiguous and let the user review before you merge. Use judgment; don't make the user configure you. The flow below is the map, not a checklist to recite — skip what doesn't apply, and always stop for a true blocker (destructive/irreversible action, a policy violation from CLAUDE.md, an external dep you can't satisfy).

## The flow

1. **Understand.** Restate the goal in a line. Name the actor it touches — **smart agent** (the caller), **fast guy** (the driver), **vision guy** (the eyes) — see `docs/idea/models.md`. If the ask cites URLs (article, prior art), `WebFetch` them and extract the *pattern* (the mechanism), then translate it onto our stack: Bun + TS, Vercel AI SDK agent loop, MCP stdio server, CDP/X11/ADB adapters behind one contract, Zod at every boundary.

2. **Explore (parallel).** Fan out `Task` Explore agents (very thorough; `codegraph_explore` for structure when a `.codegraph/` exists) to map every affected surface: `src/mcp/` (tool defs), `src/agent/` (loop + `prompts/`), `src/adapters/{browser,desktop,android}/`, `src/session/`, `src/config/`, `src/services/`, `src/findings/`, `src/cli/`. Note the patterns to mirror (`file:line`), the tests beside them (`*.test.ts`, `e2e.test.ts`, `dummy-web.e2e.test.ts`), and the docs that must move with the code (`docs/idea/*`, `docs/reference.md`, `README.md`, `CLAUDE.md`). Respect the layering: thin MCP handlers, logic in `src/services/`, adapters stay behind the shared contract. Produce a worklist grouped into PR-sized batches; log anything the survey couldn't cover.

3. **Track in GitHub (issues).** Find the existing issue or open one with `gh issue create` on `developerz-ai/ui-debugger-mcp`. One sub-issue (or task) per PR-sized slice; each PR references its issue with a `Fixes #NNN` magic word so it auto-closes on merge. Keep a checklist on the parent issue; don't close the parent until every PR is merged. A single self-contained slice can be handed straight to an isolated worktree `Task` agent that takes it from branch → build → verify → PR → merge.

4. **Build — contract first, then fan out.** Touching more than one adapter? Never implement it three ways: extend the **one adapter contract** (`open · find · click · type · readState · screenshot · waitFor`) or the agent's tool belt (`observe`/`act`/`look`/`report`) once, land it with its first real caller, then the other adapters adopt it. **No abstractions before consumers.** Same rule for MCP tools: **few, fat** — extend `start_debug`/`send_message`/`get_findings`/`describe`/`end_session` with parameters, never ship a new one-per-action tool. Fan out **parallel worktree-isolated `Task` agents** (`isolation: worktree`), one per batch — each branches from fresh `main`, and gates the full check **in the foreground** (backgrounded stalls in worktrees; fresh worktrees need `bun install`, and the browser e2e needs `dummy/web` built + a Chromium available). Small feature → one branch, skip the fan-out.

5. **Verify.** The green gate is `bun run lint && bun run typecheck && bun test && bun run build`. A logic bug fixed here ships with a reproducing test alongside the code. Agent/adapter behavior → prove it end-to-end against the `dummy/web` fixture (`src/dummy-web.e2e.test.ts` is the pattern); a real browser run needs Chromium (`bunx playwright install chromium`). MCP-surface change → boot the stdio server and exercise the tool for real, don't just unit-test the handler. Prompt changes (`src/agent/prompts/`) are code: they get a test. Keep unit tests < 10s. Green gate + a clean verdict is the bar to merge.

6. **PR + merge sequentially.** Commit (Conventional Commit, scope = layer: `agent`, `adapter`, `mcp`, `session`, `cli`, `config`; reference the issue), push, `gh pr create` (Summary + Test plan). Then merge PRs **one at a time**: wait for CI green (`ci.yml`: lint + typecheck + test + build on Bun), address review comments (CodeRabbit included) and conflicts, then `gh pr merge --squash`. Never merge in parallel (it rebases and churns `main`). After each merge, rebase the next branch and re-run its gate. Never `--force`/`--no-verify`/skip hooks without permission.

7. **Release (npm, only when asked or when the change is user-facing and complete).** Publishing is **not** automatic on merge — `release.yml` fires on a published GitHub Release (OIDC trusted publishing, no token). To ship: bump `version` in `package.json` (semver — behavior change = minor, fix = patch), update `CHANGELOG.md`, merge that, then `gh release create v<X.Y.Z>`. Confirm the workflow published and `npm view @developerz.ai/ui-debugger-mcp version` matches. If the ask didn't call for a release, say so and stop at merged.

8. **Watch + close.** CI green on `main`, `bun run build` clean, README/`docs/idea/*`/`CLAUDE.md` updated if the surface changed, `.ui-debugger-mcp.example.json` and `.mcp.example.json` updated if config gained a key. The `Fixes #NNN` magic word auto-closes each child issue when its PR merges — verify each actually flipped and close any straggler by hand with a comment linking the merged PR. Once every child is closed, close the **parent issue** yourself. Broken on `main` → forward-fix on a branch; a published-bad-version → yank/patch and tell the user.

## Hard rules (from CLAUDE.md — non-negotiable)

**Few fat tools** — never ship click/type/screenshot as separate MCP tools; that floods the caller's context. **The agent brain runs inside the server**, not in the caller. **Our prompts live in-repo** (`src/agent/prompts/`), versioned and tested — never rely on a 3rd-party model's defaults. **One adapter contract** for browser/desktop/android; the agent loop stays adapter-blind. **Session keyed by cwd**, one debug run per project. **Findings carry both functional bugs and visual/UX feedback.** Managed vs attach: `cdpUrl`/`adbSerial` present → attach, never start/stop the target. Every run is **timeout-capped** — a run never hangs forever. Bun + TypeScript only. Strict TS, no `any`. Zod at every boundary (config, MCP input, findings). Custom error classes, never generic `Error`. **Fail fast — surface errors loud, no silent fallback.** Files ≤ 500 LOC, one responsibility. Biome gates (no ESLint/Prettier). Minimum code — 200 lines that could be 50 → write 50. Surgical changes, no drive-by refactors. Never commit secrets: `.mcp.json` holds the API key and stays gitignored.

## Output

```
Contract:   <what changed in the adapter/tool-belt contract>  (PR #NNN, merged)   [sweeps only]
Surfaces:   <n> across <m> PRs → #… #…
Gate:       lint ✓ typecheck ✓ test <n passed> ✓ build ✓
Release:    v<X.Y.Z> published | not released (merged only)
Issues:     #<parent> closed (<k> sub-issues)
```
