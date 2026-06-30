# Contributing

## Quick start

```bash
git clone <repo>
cd ui-debugger-mcp
bun install
```

Boot the server in watch mode (for manual testing with an MCP client):

```bash
bun run dev
```

## CI gate — all four must pass before commit

```bash
bun run lint        # Biome format + lint
bun run typecheck   # tsc --noEmit
bun test            # bun:test suite (< 10 s)
bun run build       # esbuild / tsc emit
```

Auto-fix most lint issues:

```bash
bun run lint:fix
```

The CI workflow (`.github/workflows/ci.yml`) runs the same four steps on every push and PR.
It also builds `dummy/web` ahead of `bun test` so the e2e suite finds the fixture's `dist/`.

## Branch + PR conventions

- Branch from `main`: `feat/<topic>` or `fix/<topic>`.
- PRs are small and focused — one logical change per PR.
- PR title: imperative mood, ≤ 70 chars.
- Commits: `type: short description` (feat/fix/refactor/docs/test/chore).

## Code style

Enforced by Biome (`biome.json`) and TypeScript strict config (`tsconfig.json`).
Key rules (all error-level):

| Rule | Constraint |
|------|-----------|
| Formatting | 2-space indent, lineWidth 100, LF, semicolons, trailing commas, arrow parens |
| Quotes | single in TS/JS, double in JSX |
| Imports | named exports only (`noDefaultExport`); `import type` for types; `.js` extension on relative ESM imports |
| Types | `noExplicitAny`, `noNonNullAssertion`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax` |
| Errors | custom error classes only — never `throw new Error(...)` |
| Files | ≤ 500 LOC, one responsibility each |
| Boundaries | Zod validation at every boundary (config, MCP input, findings) |

## Tests

Runner: `bun:test`. Co-locate tests next to source (`src/foo.ts` → `src/foo.test.ts`).

```ts
import { expect, test } from 'bun:test';
```

Three test tiers used in this repo:

| Tier | Example | When to run |
|------|---------|-------------|
| Unit (fake adapter) | `src/agent/belt/act.test.ts` | always — no external deps |
| Browser integration | `src/adapters/browser/browser-adapter.integration.test.ts` | skip-guarded via `SKIP_BROWSER_TESTS=1`; needs `CHROMIUM_PATH` |
| Full-stack e2e | `src/e2e.test.ts` | always — uses `Bun.serve` fixture + in-memory MCP transport + `MockLanguageModelV3` |

Reference example: `src/index.test.ts`.

## Architecture notes

Keep the agent loop **adapter-blind**: all target-specific code lives in
`src/adapters/<adapter>/`. The three actors (`fast guy` driver, `vision guy` eyes,
`smart agent` boss/caller) are documented in `docs/idea/models.md`.

Adding a new adapter: see `docs/adapters-howto.md`.

## Directory map

```
src/
  main.ts          — stdio MCP server boot
  mcp/             — MCP server + tool definitions (few fat tools)
  agent/           — debug agent (Vercel AI SDK loop)
    belt/          — inner tool belt: observe / act / look / report
    prompts/       — system prompts (versioned in-repo, provider-agnostic)
  adapters/        — target control (browser/desktop/android) + shared contract
  session/         — cwd-keyed session state
  config/          — load + validate .ui-debugger-mcp.json (Zod)
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
- **Generic errors** — `throw new Error(...)` fails Biome. Import and throw the right custom class from `src/errors.ts`.
- **Silent fallbacks** — fail fast and loud. No `catch (() => {})`.
- **Drive-by refactors** — touch only what the task needs.
