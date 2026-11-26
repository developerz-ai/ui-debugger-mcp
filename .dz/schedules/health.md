# Brief: is the project healthy?

Weekly checkup (Mondays 09:00 UTC) fired by `schedules: health`: the failures no issue or PR announces.

| Signal                        | Command                                                                                                                                                                                   | Healthy                                                                            |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `main` is green               | `gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha,url`, then `git rev-parse origin/main`                                                      | `success` on the `origin/main` tip; a null conclusion or another sha is no verdict |
| the last tag published        | `t=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main); gh run list --workflow release.yml --limit 5 --json conclusion,headSha,headBranch,url` filtered to `headBranch == $t` | `success`; no run for that tag is no verdict                                       |
| npm carries it                | `npm view @developerz.ai/ui-debugger-mcp version` against `${t#v}`                                                                                                                        | equal                                                                              |
| the MCP Registry carries it   | `curl -fsS 'https://registry.modelcontextprotocol.io/v0/servers?search=io.github.developerz-ai/ui-debugger-mcp'` lists `${t#v}`                                                           | listed                                                                             |
| the stamped version is tagged | `jq -r .version package.json` against `$t`                                                                                                                                                | equal, or an open release PR or in-flight run explains it                          |
| Dependabot is not stuck       | `gh pr list --app dependabot --state open --limit 100 --json number,updatedAt,statusCheckRollup`                                                                                          | no PR with failed checks and more than 7 days since `updatedAt`                    |

## What to file

For each unhealthy signal, one ask, unless an open issue already carries its exact title. Read the open titles first, exactly so: `gh api --paginate "repos/developerz-ai/ui-debugger-mcp/issues?state=open" | jq -r '.[] | select(.pull_request == null) | .title'`, then compare byte for byte. A failed read is no verdict, never "no open ask". Titles are stable: nothing that changes run to run (sha, run URL, version) goes in one; that goes in the body, with the command and its output. A red `main` comes first: nothing releases from it. A failed `release.yml` run, npm missing the version and the Registry missing it are one defect seen three ways when they share a tag: one ask, all three in its body.

This lane reads and files; it never repairs. It never re-runs a publish, re-tags, moves or deletes a tag or Release, runs `npm publish` by hand, force-pushes `main` or merges with `--admin`. Recovery is a maintainer's.

## Rows

- `main-green` — The latest `ci.yml` push run on the `origin/main` tip is `success`; a null conclusion or another sha is no verdict.
- `last-tag-published` — The last `v*` tag has a `success` `release.yml` run, and npm and the MCP Registry both list its version.
- `stamped-version-tagged` — `version` in `package.json` equals that tag, or an open release PR or an in-flight release run explains it.
- `dependabot-not-stuck` — No open Dependabot PR has failed checks with more than 7 days since its `updatedAt`.
