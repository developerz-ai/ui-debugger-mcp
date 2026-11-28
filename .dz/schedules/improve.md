# Brief: improvement

Fired on the first and third Monday of each month by `schedules: improve` (`weeks_of_month: [1, 3]`).

Twice a month, leave ui-debugger-mcp measurably better, so nobody has to touch it by hand. `CLAUDE.md` binds every change. A red `main`, a missing publish and a stuck Dependabot PR belong to the platform's red-main ask and `release-due`.

## Signals

| Signal                   | Command                                                                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| the gate on fresh `main` | `bin/setup && bin/check`                                                                                                      |
| advisories               | `bun audit --json`; act only on a package in the production dependency tree, transitive included (`bun pm ls --all` shows it) |
| dependency majors        | `bun outdated`, and the Dependabot PRs closed red                                                                             |
| open bugs                | `gh issue list --state open --label bug --json number,title,url`                                                              |

Read a failing job's log before deciding anything. A red run whose log names a missing secret or a repository setting is the owner's to fix: escalate once, never delete the check or turn it into a green skip.

## Pick at most three, in this order

1. Anything the gate found broken or flaky: the root cause, never a retry or a skip.
2. Advisories in the production dependency tree, then dependency majors Dependabot could not land, one per PR.
3. Open bugs, each starting from a test that fails on `main`.
4. Docs drift: `README.md`, `CLAUDE.md` and `docs/` naming a tool, flag, config key or command the code no longer has.
5. Hidden failures: an `|| true`, a `2>/dev/null`, an empty `catch {}`, a `.catch(() => {})`, a test that skips in CI. Make it fail or handle it visibly with the repo's own error classes (`src/errors.ts`). A documented, deliberate fallback stays.
6. Simplification: dead code, duplicated logic, slow or flaky tests.

## Ship

One small PR per improvement, its evidence in the body, `bin/check` green first. Never bump the version and never touch `release.yml` or `server.json` from this checkup: open an issue instead. A breaking change to the MCP tool surface or the config schema is a maintainer's: open the issue and leave it. Check no open PR or issue already covers it. If nothing is worth changing, do nothing: no empty PRs, no churn.

## Rows

- `gate`: `bin/check` on fresh `main` finds something broken or flaky; the root cause, never a retry or a skip.
- `advisories`: `bun audit` finds an advisory in a runtime dependency; one per PR.
- `dependency-majors`: a major Dependabot could not land; one per PR.
- `open-bugs`: an open `bug` issue, starting from a failing test.
- `docs-drift`: a doc line the code contradicts, both quoted.
- `hidden-failures`: a swallowed error or CI skip, made visible.
- `simplification`: dead code, duplicated logic, slow or flaky tests.
