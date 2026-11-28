# `.dz/`

Repo-scoped configuration for the developerz.ai maintainer agent, under the namespace each config
belongs to. The platform owns the layout. `CLAUDE.md` binds everything here.

| Path                           | What                                                                                                                                                                                                                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pipeline/agent-pipeline.json` | the agent pipeline: `repo` and the `ci-only` review gate, nothing else (#59)                                                                                                                                                                                                                            |
| `maintainer/maintainer.yml`    | the policy: what the bot triages, closes, reviews, merges and releases. [Reference](https://developerz.ai/docs/maintainer-yml)                                                                                                                                                                          |
| `schedules/`                   | what each `schedules:` checkup works from, read at `main`'s HEAD when it fires: `release-due.md` (weekly: is a release needed), `maintain.md` (weekly: at most one PR: the gate, tool pins, advisories, docs truth), `improve.md` (first and third Monday: at most three small, evidenced improvements) |

The gate is the repo's `main-protection` ruleset (`bun (lint + typecheck + test)` and
`pack-smoke (packed artifact on the node floor)` required, no review count, no force-push or
deletion): `gh api repos/developerz-ai/ui-debugger-mcp/rulesets`. No file here relaxes it.

Docs: https://developerz.ai/docs/maintainer-yml
