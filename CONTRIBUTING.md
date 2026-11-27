# Contributing

## Quick start

```bash
git clone <repo>
cd ui-debugger-mcp
bin/setup
```

The one-command entry point is `bin/setup` — installs root + dummy/web deps and
builds the e2e fixture's `dist/`. `bin/check` runs the local typecheck, lint, and
test gate from any cwd; CI runs those legs directly. `bin/dev` boots the server in
watch mode. Both run a shared preflight (`bin/lib/preflight.sh`: pinned bun, deps,
dummy/web build, Chromium launch) and name `bin/setup` when something is missing.
`.vscode/` carries matching tasks and launch configs, with Biome as the formatter.

`bin/setup` selects and verifies the Bun version CI pins and fails loud when
that version cannot be obtained, so setup never runs on an arbitrary ambient bun.
The Node it needs comes from PATH, or — when Node is installed but missing from
PATH — from `mise`. Both are RESOLVED, never downloaded.

The verified Bun's directory stays FIRST on `PATH`: the directory the resolved
Node comes from is added BEHIND it, so a Bun installed beside mise's Node can
never shadow the runtime setup verified.

Its browser gates (the skip-when-cached check, the apt repair and the library
check) look for the pinned Chromium where playwright-core itself would put it:
`PLAYWRIGHT_BROWSERS_PATH`, else `$XDG_CACHE_HOME/ms-playwright`, else
`$HOME/.cache/ms-playwright` — on macOS `$HOME/Library/Caches/ms-playwright`,
where HOME beats XDG. `PLAYWRIGHT_BROWSERS_PATH=0` is not a directory named `0`:
it is the package-local cache, `node_modules/playwright-core/.local-browsers`.
All gates read one resolved dir, so a custom cache is never read as an absent
browser and re-downloaded.

Boot the server in watch mode (for manual testing with an MCP client):

```bash
bun run dev
```

## Checks and CI

Run the checks locally in one command, or step-by-step:

```bash
bin/check           # typecheck + lint + test (local one-command equivalent of CI's three legs)
```

```bash
bun run lint        # biome check .
bun run typecheck   # tsc --noEmit -p tsconfig.json
bun test            # bun:test suite (< 10 s)
bun run build       # tsc -p tsconfig.build.json -> dist/ (package build)
```

`bin/check` is a local convenience script. CI does not invoke it; it runs the
legs below directly.

Auto-fix most lint issues:

```bash
bun run lint:fix
```

The CI workflow (`.github/workflows/ci.yml`) has two jobs on every push and PR:

- `bun`: `bun run lint` (Biome), `bun run typecheck` (tsc --noEmit), then a
  `dummy/web` fixture build (`bun install --frozen-lockfile && bun run build`
  in `dummy/web`, which has its own lockfile). That fixture build only supplies
  the e2e fixture's `dist/`. Then `bun test` runs with
  `SKIP_BROWSER_INTEGRATION=1`, followed by `bun run build` for the package.
  The BrowserAdapter integration suite is skipped in CI's parallel test batch,
  but `bin/check` runs it in an isolated invocation with no skip flag.
- `pack-smoke`: the package-artifact requirement supersedes a source-job build
  claim. It builds the package, then smoke-tests the tarball's installed CLI on
  the Node floor (Node 22).

## Branch + PR conventions

- Branch from `main`: `feat/<topic>` or `fix/<topic>`.
- PRs are small and focused — one logical change per PR.
- PR title: imperative mood, ≤ 70 chars.
- Commits: `type: short description` (feat/fix/refactor/docs/test/chore).

## Code style

Enforced by Biome (`biome.json`) and TypeScript strict config (`tsconfig.json`).
Key rules (all error-level):

| Rule       | Constraint                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------- |
| Formatting | 2-space indent, lineWidth 100, LF, semicolons, trailing commas, arrow parens                        |
| Quotes     | single in TS/JS, double in JSX                                                                      |
| Imports    | named exports only (`noDefaultExport`); `import type` for types                                     |
| Types      | `noExplicitAny`, `noNonNullAssertion`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |

House requirements, not tool-enforced — neither Biome nor `tsconfig.json`
defines a rule for any of these, so `bin/check` cannot catch a violation; a
reviewer does. They still apply to every contribution:

- Custom error classes only — never `throw new Error(...)`.
- Zod validation at every boundary (config, MCP input, findings).
- `.js` extension on relative ESM imports.

Files stay ≤ 500 LOC with one responsibility each — a contributor requirement,
not tool-enforced (neither Biome nor `tsconfig.json` nor `bin/check` measures
it). When a file outgrows the cap, split it into a sibling module — the pattern
`src/adapters/browser/` already uses per `extractor.ts`/`filters.ts`/`geometry.ts`.

## Tests

Runner: `bun:test`. Co-locate tests next to source (`src/foo.ts` → `src/foo.test.ts`).

```ts
import { expect, test } from 'bun:test';
```

Three test tiers used in this repo:

| Tier                | Example                                                    | When to run                                                                                                                      |
| ------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Unit (fake adapter) | `src/agent/belt/act.test.ts`                               | always — no external deps                                                                                                        |
| Browser integration | `src/adapters/browser/browser-adapter.integration.test.ts` | isolated run in `bin/check`; skipped by CI's parallel batch until CI gains an isolated step; needs Chromium (or `CHROMIUM_PATH`) |
| Full-stack e2e      | `src/e2e.test.ts`                                          | always — uses `Bun.serve` fixture + in-memory MCP transport + `MockLanguageModelV3`                                              |

Reference example: `src/index.test.ts`.

## Architecture notes

Keep the agent loop **adapter-blind**: all target-specific code lives in
`src/adapters/<adapter>/`. The three actors (`fast guy` driver, `vision guy` eyes,
`smart agent` boss/caller) are documented in `docs/idea/models.md`.

Adding a new adapter: see `docs/adapters-howto.md`.

## Directory map

```
src/
  main.ts          — CLI entry: help/version/init/status/stop, then boots the server
  boot.ts          — server boot: owner-lock gate → config → workspace → provider/models → stdio MCP server
  mcp/             — MCP server + tool definitions (few fat tools)
  agent/           — debug agent (Vercel AI SDK loop)
    belt/          — inner tool belt: observe / act / look / report
    prompts/       — system prompts (versioned in-repo, provider-agnostic)
  adapters/        — target control (browser/desktop/android) + shared contract
  session/         — cwd-keyed session state
  config/          — load + validate the project config (Zod; .dz/ first, root fallback)
  services/        — business logic; handlers stay thin
docs/
  idea/            — design docs (read before changing architecture)
  reference.md     — MCP tool + findings reference
  adapters-howto.md — how to add a new adapter
dummy/web          — React test fixture with planted bugs (manual + e2e)
```

## Common mistakes

- **Forgetting `.js` on relative imports** — ESM requires it even for `.ts` source files.
- **Default exports** — banned. Use named exports everywhere.
- **Generic errors** — a house requirement, not Biome-checked: never `throw new Error(...)`. Import and throw the right custom class from `src/errors.ts`.
- **Silent fallbacks** — fail fast and loud. No `catch (() => {})`.
- **Drive-by refactors** — touch only what the task needs.
