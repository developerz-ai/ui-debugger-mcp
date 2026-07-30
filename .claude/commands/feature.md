---
description: End-to-end feature/bug-sweep workflow for ui-debugger-mcp — understand, reproduce against a real target, explore in parallel, split into path-disjoint slices, build with a hive of agents in this ONE checkout (never worktrees), gate green, PR, merge, release to npm. Tracks in GitHub issues. Reads intent from the prompt.
argument-hint: <what you want built or fixed, plain language> [+ reference URL(s)]
allowed-tools: Read, Write, Edit, Glob, Grep, Bash, Agent, Task, SendMessage, TaskCreate, TaskUpdate, TaskList, Skill, WebFetch, mcp__codegraph, mcp__ui-debugger
---

# /feature

You are a **senior engineer on ui-debugger-mcp** — an MCP server whose agent brain runs *inside* it. Read [`CLAUDE.md`](../../CLAUDE.md) and [`docs/idea/architecture.md`](../../docs/idea/architecture.md) before designing anything.

**Done means merged, green, and — when the change is user-facing — released.** understand → reproduce → explore → slice → build → gate green → PR → **merged** → **CI green on `main`** → **npm version confirmed**, if a release was in scope → docs and example configs left true. A green local gate is not done; an open PR is not done; a bumped `package.json` that never published is not done. This repo ships nowhere else: there is no server we operate, so the arc genuinely ends at merged (or at `npm view @developerz.ai/ui-debugger-mcp version`). Report what you actually verified, not what you assume happened.

## Request
$ARGUMENTS

**The prompt is the context — read the intent.** Autonomy, scope, which layer (`mcp` / `agent` / `adapters` / `session` / `config` / `services` / `cli`), whether to confirm before merging: infer it from the words. "Just ship it" → run start-to-finish, decide everything yourself, merge on green, surfacing decisions in the issue and PR body instead of asking. A tentative or exploratory ask → clarify what is genuinely ambiguous and let the user review first. Don't make the user configure you. Always stop for a true blocker: a destructive or irreversible action, anything that would leak a secret into a model's context or the logs, a published-bad-version situation, or an external dependency you cannot satisfy.

**Pick the PR mode before briefing anyone.** **Slice-per-PR** (default) — one concern per PR, merged one at a time. **One fat PR** is the user's call and legitimate for a coherent sweep: path-disjointness still governs the *build* (it is how parallel agents avoid clobbering each other), it just stops governing the *commit*, and the body then carries the finding-by-finding ledger.

**Cap a PR at ~110–120 files** — generous for a repo this size, so hitting it means the slicing was wrong. CodeRabbit refuses outright above 150 changed files, so the biggest, riskiest PR gets the *least* automated review; a human cannot hold 279 files either. One red CI job blocks everything, and this repo's single `ci.yml` job is lint + typecheck + Chromium e2e + build — one flaky browser test would hold every unrelated fix hostage. Bisecting later lands on one enormous commit. Split even if the user asked for one PR, and say why: the agent boundaries were disjoint by construction, so each becomes a PR for free. Land the adapter-contract or tool-belt change first, then the adapters that adopt it.

## Work as a hive mind, in one checkout

**Whether to hive is a judgement call, not a ritual.** Two things justify it: **searching** (a broad sweep where you want conclusions, not file dumps) and **scale** (independent, path-separable work — three adapters, the agent loop, the MCP surface — that would take hours serially). Everything else should not hive. A single-file fix or one bug with an obvious home: do it yourself; briefing, collision management and report-reading cost more than the change, and you pay it in the one context that must survive to the merge.

When you do hive, a big task is not one agent doing more; it is a **team sharing one working tree**, with you as coordinator. **Never use git worktrees** — no `isolation: worktree`, no per-agent directories, ever. They fragment the tree, hide half-finished work from the gate, and each one needs its own `bun install`, its own `dummy/web` build, its own Chromium download and its own `.mcp.json`. Worse, this server keys **everything by cwd** — workspace root, Chrome profile, `sessions/`, `state.json` — so a second checkout does not just cost time, it invents a second project identity and makes the isolation tests meaningless. One checkout, many hands; the file set is the only lock.

- **You coordinate; you do not code.** You own git, the ledger and the merge, and you are the only participant who must survive to the end — spend your context on routing, not on reading files an agent will report back. Editing `src/adapters/` yourself means you took a slice from someone who had room for it.
- **The file set is the lock.** Every brief names that agent's exclusive paths *and* what every other live agent holds. An agent needing a file it does not own **stops and reports the collision** — never edits across the line, never negotiates peer-to-peer. You mediate: hand the change to the owner, or re-cut the boundary.
- **Agents are long-lived teammates.** New work in an area someone holds goes to them via `SendMessage`, keeping their context and their file lock. A second agent on the same paths means two writers and a lost fix.
- **Work in waves; each wave re-tasks the next.** Wave 1's findings decide wave 2's slices. Don't plan wave 3 before wave 1 reports — it will be wrong.
- **Keep a visible ledger** (`TaskCreate`/`TaskUpdate`) so ownership survives a context handoff.
- **Expect the hive to contradict you.** A good agent reports "premise H1 is false, here is the line." Drop it. Findings that survive several independent readings are the ones worth shipping.

### Who runs which checks

An agent runs lint and tests **narrowed to its own files**. Whole-repo green is the coordinator's job, once, at the end — never N agents running the full suite.

| | Agent (per iteration) | Coordinator (once, at the end) |
|---|---|---|
| lint | `bunx biome check <the files it edited>` | `bun run lint` |
| tests | `bun test src/<its own>.test.ts` — named explicitly, **never a bare `bun test`** | `bun test` (the whole suite, including e2e), in the **background** |
| typecheck | `bun run typecheck` **once when otherwise done** — tsc is project-wide by nature, so this is the floor | covered above, plus `bun run build` |

**The e2e tests take a real, exclusive lock.** `src/e2e.test.ts` and `src/dummy-web.e2e.test.ts` boot the server and launch Chromium against `./tmp/ui-debugger-mcp/`, and the persistent `chrome-user-data/` profile is single-holder by design — one debug run per cwd. A bare `bun test` from two agents at once therefore means two Chromiums fighting over one profile, and the failures read as adapter bugs that do not exist. **Only the coordinator runs e2e**, once, at the end, and only after `bun install` in `dummy/web` and `bunx playwright install chromium`. Agents get named unit files and nothing else; unit tests stay under 10s, so this costs them nothing.

There is no `test:changed`-style command here, and there should not be: a command that diffs the working tree is wrong inside a hive, because that tree holds every agent's uncommitted work — the "changed" set becomes everyone's and each run expands to nearly the whole repo.

### Two things only the coordinator can do

- **Every slice you NAME, you must dispatch.** Briefs tell each agent who holds which paths, so a named-but-unlaunched slice makes agents defer work to a teammate who does not exist — and it vanishes. Keep roster and dispatched set as one list; reconcile **before** reading reports.
- **Reserve an "unowned" bucket and expect to fill it mid-run.** The real fix often lands where no slice covers: the shared adapter contract, `src/errors.ts`, a prompt in `src/agent/prompts/` that three surfaces read, `.ui-debugger-mcp.example.json`, the README. A homeless finding is the one most likely to be quietly dropped — when a report says "the real fix is outside my set", assign it immediately rather than filing it.
- **Look for causal chains across reports.** Agents see their own surface; only you see all of them. A `readState` change that stops tagging frames explains a "click does nothing" report the desktop agent is independently chasing — neither could see it. After the reports land, spend one pass asking "does A explain B?" It changes what you fix and what you can drop.

## The flow

1. **Understand.** Restate the goal in a line. Name the actor it touches — **smart agent** (the caller), **fast guy** (the driver), **vision guy** (the eyes), `docs/idea/models.md` — and the layer. URLs in the ask → `WebFetch` the *mechanism*, then translate it onto this stack: Bun + TS, the Vercel AI SDK loop, a stdio MCP server, CDP/X11/ADB behind one contract, Zod at every boundary.

2. **Distrust the paperwork.** `docs/idea/*` is design intent, not a record of what shipped. Before planning work off it, check it against the code and `git log` — merged PR titles are the cheapest ground truth here (the log is squash-merged and well-scoped). State plainly which claims you falsified, and fix the doc in the same PR.

3. **Reproduce before you theorise.** There is no production to query — this ships as an npm package — so the equivalent evidence is a **real run**, and it costs one command. Boot the server (`bun run dev`) and drive it against `dummy/web`, or point a target at the app that surfaced the bug and read `tmp/ui-debugger-mcp/<project>/logs/{agent,console,network}.log` and `sessions/<id>/findings.json`. `bunx ui-debugger-mcp status` reports the run this cwd holds. A finding carrying a real trace outranks one derived from reading alone — rank it accordingly. Never paste a captured secret anywhere; the redactor exists because the model's context must never see one.

4. **Explore (parallel).** Fan out `Agent` Explore agents (very thorough; `codegraph_explore` — this repo has a `.codegraph/` index) over **disjoint** areas: `src/mcp/`, `src/agent/` + `prompts/`, each of `src/adapters/{browser,desktop,android}/`, `src/session/`, `src/config/`, `src/services/`, `src/findings/`, `src/cli/`. Require of every finding: severity, `file:line`, a one-sentence defect statement, and a **concrete failure scenario** (inputs → wrong outcome). Demand two more things explicitly — the doc claims they **falsified**, and the brief premises that turned out **true** — so you neither re-fix working code nor re-verify settled ground. **Protect your own context**: don't read what an agent will report; prefer one thorough agent over three shallow ones plus your own reading.

5. **Fold in live user reports as first-class findings.** A mid-run agent transcript, a `findings.json`, a console trace from a real target: that is *confirmed against a real app* and routinely outranks the audit's own findings. Reproduce, root-cause, rank above equal-severity read-only findings. If an in-flight agent owns those files, extend its brief with `SendMessage` rather than spawning a second agent onto the same paths.

6. **Track in GitHub issues** — the tracker this repo actually uses. `gh issue list --search "<area>" --state all` **before** creating anything: the work may already be tracked, partly tracked, or a closed issue may have decided what you are about to re-decide. One issue per PR-sized slice under a parent checklist; each PR carries `Fixes #NNN`; the parent stays open until every child merges.

7. **Build — branch first, then fan out.**

   ```bash
   git fetch origin && git status --short   # expect a clean tree
   git checkout -b <type>/<slug>            # feat/ fix/ refactor/ docs/ test/
   ```
   Do it now, while the tree is clean; by commit time it is dirty enough that you won't want to think about branches. Then fix slice boundaries **before launching anyone**, each file set **disjoint from every other agent's**. Two agents that must edit one file are one slice, not two.

   **Contract first.** Touching more than one adapter? Never implement it three ways: extend the **one adapter contract** (`open · find · click · type · readState · screenshot · waitFor · console · network`, plus optional `tabs · selectTab`) or the inner belt (`observe`/`act`/`look`/`report`) once, land it with its first real caller, then the others adopt it. Same for the MCP surface: **few, fat** — extend `start_debug`/`send_message`/`get_findings`/`describe`/`end_session` with parameters, never add a one-per-action tool.

   **Every brief carries all nine of these** — omitting one is how a run goes wrong:
   - its **exclusive file set**, and never to edit outside it;
   - **which other agents are live on which paths**, so a collision is *reported*, not silently resolved;
   - each finding with `file:line`, the defect, the concrete failure scenario — plus permission to **drop any finding the code contradicts** (that is the agent working correctly);
   - **evidence first, diagnosis second** — the symptom, the log fingerprint, the failing input, and only then your hypothesis, explicitly labelled unverified, to confirm or kill *before* building; a brief that leads with a confident root cause sends the agent to the wrong file;
   - the **house constraints binding its area**: files ≤ 500 LOC, one responsibility; strict TS, **no `any`**; Zod at every boundary (config, MCP input, findings); custom error classes, never generic `Error`; **fail fast, no silent fallback**; minimum code, no speculative abstraction, no drive-by refactors; thin MCP handlers with logic in `src/services/`; adapters stay behind the shared contract and the loop stays adapter-blind; managed vs attach (`cdpUrl`/`adbSerial` ⇒ attach, never start/stop the target); every run timeout-capped; secrets never enter a prompt, a log or a finding;
   - **tests ship with the code, failure case first** — a bug gets a test that fails before the fix; prompts in `src/agent/prompts/` are code and get tests too;
   - **checks narrowed to its OWN files** (see above) — unit files by name, never a bare `bun test`, never the e2e suite;
   - **no git operations at all**; the coordinator owns all git and work is left uncommitted;
   - **never tell an agent to "ask me" — it cannot.** A subagent has no channel to the user, so a question is a dead end: it blocks or guesses. Give it two legal moves: **decide and flag it** (act on the most defensible reading, state the assumption, mark the artifact so you can overwrite it), or **stop and report** with evidence when either path would be unsafe or wasted. Then *you* take the question to the user and re-task with `SendMessage`.

   Small feature → one agent, skip the fan-out.

8. **Verify.** Run the **full gate once, in the background**: `bun run lint && bun run typecheck && bun test && bun run build`. Agent or adapter behaviour → prove it end-to-end against the `dummy/web` fixture (`src/dummy-web.e2e.test.ts` is the pattern; needs Chromium via `bunx playwright install chromium`). An MCP-surface change → boot the stdio server and exercise the tool for real, not just the handler in a unit test. Config gained a key → `.ui-debugger-mcp.example.json` and `.mcp.example.json` move with it.

9. **Commit & merge.** Let every agent finish, **then** plain git; never commit while agents are still writing. **First sweep the agents' leftovers** — scratch `.ts` probes at the repo root, debug `console.log`, stray screenshots, anything an e2e run dropped outside `tmp/`.

   ```bash
   git fetch origin                    # did main move? if so, see below
   git add <this slice's paths>        # never `git add -A`
   git status --short                  # then READ it
   git commit && git push -u origin HEAD
   ```
   Naming paths on `git add` is all the selectivity you need. **Never `git stash`** — one global stack shared with every concurrent agent; use `git diff` or a `cp` backup.

   **Main moves under you.** Before each build, `git fetch` and intersect *files changed on main* with *files changed locally*. A real overlap is **three-way merged** (`git merge-file -p ours base theirs`), never taken wholesale — a naive tree build drops main's lines silently, with no conflict marker.

   Then `claudetm merge-pr <pr>` — it waits for CI, fixes failures, addresses review comments (CodeRabbit included) and merges when green. It operates on the **current directory**, so at most one PR is in flight: parallel *building* is fine, parallel *merging* is not. **When every check already passes, prefer `gh pr merge --squash`** — `claudetm` can hang on an already-green PR. Gotcha: **0 registered checks reads as "pass"** — wait until the count is plausible *and* nothing is pending, or you merge RED right after a rebase.

10. **Release + close.** Publishing is **not** automatic on merge: `release.yml` fires on a published GitHub Release (OIDC trusted publishing, no token) and also pushes to the MCP Registry. To ship: bump `version` in `package.json` (behaviour change = minor, fix = patch), update `CHANGELOG.md`, merge that, then `gh release create v<X.Y.Z>`. Confirm the workflow published and that `npm view @developerz.ai/ui-debugger-mcp version` matches. If the ask did not call for a release, say so and stop at merged. Then verify each `Fixes #NNN` actually closed its issue, close any straggler by hand with a link to the merged PR, close the parent yourself, and update `README.md` / `docs/idea/*` / `CLAUDE.md` if the surface changed. A published bad version → patch forward and tell the user.

## Hard rules (from CLAUDE.md — non-negotiable)

**Few fat tools** — never ship click/type/screenshot as separate MCP tools; that floods the caller's context. **The agent brain runs inside the server**, not in the caller. **Our prompts live in-repo** (`src/agent/prompts/`), versioned and tested — never rely on a third-party model's defaults, and remember they are resent every step, so keep them compressed. **One adapter contract** for browser/desktop/android; the loop stays adapter-blind. **Session keyed by cwd**, one debug run per project, `replace:true` only for a run this server owns. Findings carry **both** functional bugs and visual/UX feedback. Every run is timeout-capped. Bun + TypeScript only; strict TS, no `any`; Zod at every boundary; custom errors, never generic `Error`; **fail fast, loud, no silent fallback**; files ≤ 500 LOC; Biome gates (no ESLint/Prettier); minimum code; surgical changes. **Never commit secrets** — `.mcp.json` holds the API key and stays gitignored, and credential values are redacted before they reach a log or a model. Never `--force`, `--no-verify`, `reset --hard`, or skipping hooks without permission. **Never `git stash`. No git worktrees.**

## Output

```
Root cause:  <the one-line mechanism, for a bug sweep>
Contract:    <adapter / tool-belt change>  (PR #NNN, merged)   [sweeps only]
Fixed:       <n> findings across <m> PRs → #… #…   layers: <mcp/agent/adapters/…>
Deferred:    <n> — <what, and why not now>               [never omit this line]
Falsified:   <docs/idea claims that were wrong, now corrected>
Gate:        lint ✓ typecheck ✓ test <n passed> ✓ build ✓   e2e: <chromium run / skipped>
Release:     v<X.Y.Z> published (npm + MCP Registry) | not released (merged only)
Verified:    <the reproduction, re-run and clean>
Issues:      #<parent> closed (<k> children)
```

A sweep that fixes 40 of 90 findings is a success only if the other 50 are named.
