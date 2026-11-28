# Brief: is a release needed?

Weekly checkup, Mondays 05:00 UTC, fired by `schedules: release-due`. It covers what people install: `@developerz.ai/ui-debugger-mcp` on npm (run through `npx`/`bunx`), its entry in the MCP Registry (`server.json`), the `v*` tag and the GitHub Release that triggers `release.yml`. The block below gathers facts and you make the call.

## Cadence: weekly, judged (owner, 2026-11-26)

Only this Monday checkup cuts a release: at most one a week. A merge, a fix, a count of fixes or an interactive session never cuts one; a maintainer can still cut by hand. The only case for an off-cycle release, and only when the owner asks for it, is a fix for a _published_ first-tier advisory (GitHub Security Advisories, NVD, CISA KEV or the vendor's own) rated **high or critical (CVSS >= 7.0, or KEV-listed)** that affects what users install (the npm package and its production dependency tree, transitive included; not a `devDependencies`, test, `dummy/` fixture or docs-tooling package). Our own hardening with no published advisory waits for Monday.

## Judge

Read everything merged since the last release: the window below with its diffs, then `git log "$last"..origin/main` for what the pathspec leaves out, and `CHANGELOG.md`'s `[Unreleased]` section. Does someone running the server get something real from a release now?

- Usually yes: a fix they can hit, a feature they can use, a runtime `dependencies` bump that reaches the package.
- Usually no: a run of `devDependencies`, `dummy/web` or CI bumps. `package.json` and `bun.lock` count as shipping below, so read whether a bump is a runtime one.

Nothing real: no release. Say why either way: a release ask opens with your reason, and a no ends your run summary with `no release: <reason>`.

## Decide

```bash
git fetch --tags --unshallow origin 2>/dev/null || git fetch --tags origin
last=$(git describe --tags --abbrev=0 --match 'v[0-9]*' origin/main)
git log --format='%h %cI %s' "$last"..origin/main -- src ':!src/**/*.test.ts' package.json bun.lock server.json tsconfig.build.json
jq -r .version package.json
```

The pathspec names what reaches the published package (`files: [dist, README.md, LICENSE]`, built from `src/`). Tests, `dummy/`, docs and CI ship nothing.

| Window                                                                                                                                                                       | Do                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| a command above failed                                                                                                                                                       | no verdict: surface it, file nothing                                                                                     |
| empty                                                                                                                                                                        | nothing                                                                                                                  |
| the stamped version is already ahead of `$last`                                                                                                                              | nothing: a release is in flight, watch `release.yml`                                                                     |
| the oldest shipping commit is under 24 h old                                                                                                                                 | usually nothing: next week's checkup sees it                                                                             |
| `main`'s latest `ci.yml` push run (`gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha`) is not `success` on the `origin/main` tip | nothing: the platform's red-main ask owns a red `main`                                                                   |
| a breaking change in the window                                                                                                                                              | no release ask. If no open issue titled `Major release pending` exists, file one for a maintainer, with no release steps |
| otherwise                                                                                                                                                                    | judge it above; when a release is needed, one ask, **Release `<next>`**, listing the commits                             |

`<next>`: a `feat` subject in the window is a minor, anything else a patch.

## The ask

Pre-flight guard: only a lane where `gh auth status` exits 0 files the ask. File nothing if an open issue title from `gh api --paginate "repos/developerz-ai/ui-debugger-mcp/issues?state=open" | jq -r '.[] | select(.pull_request == null) | .title'` is exactly `Release <next>`, or an open PR title from `gh api --paginate "repos/developerz-ai/ui-debugger-mcp/pulls?state=open" | jq -r '.[].title'` matches `^chore\(release\):`. A failed read is no verdict. Body, for the box that takes it:

1. Re-run Decide on fresh `main`; still needed, or stop.
2. Bump the version in `package.json`, `server.json` (`version` and `packages[0].version`) and `src/index.ts` (`VERSION`); move `CHANGELOG.md`'s `[Unreleased]` entries under `## [<next>] - <date>`. No source change beyond the constant. `src/index.test.ts` and `src/mcp/registry-server-json.test.ts` fail on a version left behind.
3. `bin/check`, then one PR titled `chore(release): <next>`. It merges on green like any PR, never `--admin`.
4. After it merges: `git fetch origin`, confirm `git show <merge sha>:package.json` shows `<next>`, then `gh release create v<next> --target <merge sha> --title v<next> --notes-file <the CHANGELOG section>`. Publishing the Release runs `release.yml`.
5. Watch `release.yml` to the end: the version-consistency gate, `npm publish` (OIDC, provenance), then the MCP Registry publish. Confirm `npm view @developerz.ai/ui-debugger-mcp version` shows `<next>`. A failure is an issue for a maintainer.

Never re-tag, move or delete a tag or a Release, never force-push `main`, never `npm publish` by hand. A failed publish ships its fix as the next patch.

## Rows

- `release-needed` — A release is needed now and none is in flight.
- `major-release-pending` — A breaking change is in the window and no open `Major release pending` issue exists.
- `release-publish-failed` — `release.yml` was watched to the end and the publish failed.
