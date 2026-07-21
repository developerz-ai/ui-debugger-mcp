---
description: Write a concise, self-contained execution plan to docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/ for another AI to implement
argument-hint: [what you want done]
allowed-tools: Write, Read, Glob, Grep, Task, Bash
---

# /planx

Produce a concise plan another AI can execute with zero extra context. Plan only — no implementation, no code execution, no edits outside the plan dir.

## Goal
$ARGUMENTS

## Steps

1. **Resolve path.** Run `date +%Y`, `date +%m`, `date +%d`. Dir = `docs/plans/<YYYY>/<MM>/<DD>/`. `Glob docs/plans/<YYYY>/<MM>/<DD>/1*` → next number = highest existing `1NN-*` + 1, else `101`. Slug = kebab-case title, max 5 words. Final plan dir: `docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/`.

2. **Explore.** `Task` (subagent_type=Explore, thoroughness="very thorough"): existing patterns + files to touch (`file:line`), the right layer under `src/*` (`mcp` tool defs, `agent` loop + `prompts/`, `adapters/{browser,desktop,android}`, `session`, `config`, `services`, `findings`, `cli`), tests (unit `*.test.ts` vs e2e `e2e.test.ts` / `dummy-web.e2e.test.ts`), the shared adapter contract, Zod schemas at each boundary, custom error classes in `src/errors.ts`, and the docs that move with the code (`docs/idea/*`, `docs/reference.md`, `README.md`, `CLAUDE.md`). Prefer `codegraph_*` for structural lookups when a `.codegraph/` exists. Skip only for trivial asks.

3. **Write the plan as multiple files** in the plan dir — never one big `plan.md`. Always produce an `overview.md` index plus one `<NN>-<aspect>.md` per separable area (e.g. `01-adapter-contract.md`, `02-agent-tools.md`, `03-prompts.md`, `04-mcp-surface.md`, `05-config.md`, `06-tests.md`). Split by area of work so each file is independently executable and stays short. Match the existing house style in `docs/idea/` — terse fragments, `file:line` refs, tables.

   **`overview.md`** — the map. Sections:

```markdown
# <Title>

## Goal
1-2 sentences: what + why.

## Context
- Stack facts the executor needs (Bun + TS, MCP stdio server, Vercel AI SDK agent loop running *inside* the server, OpenAI-compatible router / OpenRouter default, CDP for web / X11-Wayland for desktop / ADB for android behind one adapter contract, Zod at every boundary — only what's relevant).
- Which actor it touches: smart agent (caller) / fast guy (driver) / vision guy (eyes) — see `docs/idea/models.md`.
- Reference patterns: `src/<layer>/<thing>.ts:12` — follow this for Z.

## Plan files (execute in order)
1. [`01-<aspect>.md`](01-<aspect>.md) — one line: what it covers.
2. [`02-<aspect>.md`](02-<aspect>.md) — ...

## Done when
- Verifiable acceptance criteria spanning the whole feature.

## Risks / open questions
- Anything the executor must decide or watch.
```

   **Each `<NN>-<aspect>.md`** — one slice of work. Sections:

```markdown
# <NN> — <Aspect>

> Part of [`overview.md`](overview.md). Depends on: <NN-prior or "none">.

## Files to change
- `path:line` — what changes, why.

## Steps
1. Ordered, concrete actions. Reference `Class#method` / `file:line`, don't restate.

## Tests
- What to add/run. Tests written with the code. Commands: `bun test`, `bun run typecheck`, `bun run lint`, `bun run build`. Browser e2e needs `dummy/web` built + Chromium.

## Done when
- Verifiable acceptance criteria for this slice.
```

4. **Write a `status.yml`** in the plan dir (alongside `overview.md`) — the live tracker for this plan. New plans start `not_started` / `0%`. Get `created_by` + `owner` from `git config user.name` (the person running /planx). Leave `worked_by` empty — the executor sets it to their own `git config user.name` when they pick the plan up, so a plan written by one person can be worked by another. Shape:

```yaml
plan: <1NN>-<slug>
title: <human title from overview.md>
status: not_started        # not_started | in_progress | blocked | complete | superseded
created_by: <git config user.name>   # who authored the plan
worked_by: ""              # who is executing it; empty = unclaimed; executor fills with their git user.name
owner: <git config user.name>
percent: 0                 # 0–100, overall completion
current_focus: ""          # where it's at right now / next slice to pick up
slices:                    # one row per <NN>-<aspect>.md slice
  - file: 01-<aspect>.md
    status: not_started      # not_started | in_progress | complete
    percent: 0
evidence: []               # commits/PRs proving progress, e.g. ["#24", "abc1234"]
notes: ""
last_updated: <YYYY-MM-DD>
```

   Keep `status.yml` machine-readable (valid YAML, the enums above). It's the one file in the plan dir that IS a tracker — the `.md` slices stay reference maps (no checkboxes there).

## Rules
- Compact English. Fragments over sentences. `file:line` and `Class#method` symbol refs over prose. Tables for structured data.
- Reference-only: point at code, don't paste it or re-explain it ("follow `x.ts` but ...").
- No checkboxes (`[ ]`). Plain bullets. The plan is a reference map, not a tracker.
- Multiple files always: `overview.md` + `<NN>-<aspect>.md` slices. Never a single `plan.md`.
- Self-contained: executor reads only `overview.md`, the slice it's on, and the files those cite.
- Respect `CLAUDE.md`: few fat MCP tools (never one-per-action — that floods caller context); the agent brain runs inside the server; our prompts live in-repo (`src/agent/prompts/`), versioned and tested; one adapter contract (`open · find · click · type · readState · screenshot · waitFor`) so the loop stays adapter-blind; session keyed by cwd, one run per project, always timeout-capped; findings carry functional bugs AND visual/UX feedback; managed vs attach (`cdpUrl`/`adbSerial` → attach, never start/stop).
- Stack rules: Bun + TypeScript only. TS strict, no `any`. Biome (no ESLint/Prettier). Zod at every boundary (config, MCP input, findings). Custom error classes — never generic `Error`. Fail fast, no silent fallback. Files ≤ 500 LOC, one responsibility. Thin MCP handlers, logic in `src/services/`. Minimum code — no speculative abstractions. Surgical changes, no drive-by refactors.
- A slice that changes config keys must also cover `.ui-debugger-mcp.example.json` / `.mcp.example.json` and the docs; a slice that changes the MCP surface must cover `README.md` + `docs/reference.md`. Never plan a secret into a committed file (`.mcp.json` is gitignored).

## Output
```
✓ docs/plans/<YYYY>/<MM>/<DD>/<1NN>-<slug>/overview.md
  + 01-<aspect>.md, 02-<aspect>.md, … (one per area)
  + status.yml (tracker — status/owner/percent/current_focus)
Next: run an executor on overview.md.
```
