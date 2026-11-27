# Brief: weekly maintenance

Fired every Monday at 07:00 UTC by `schedules: maintain` (`mode: devops`, `outcome: pr`): one task with a shell that delivers **at most one pull request**, or a stated reason none was owed. Reporting-only signals (red `main`, a missing publish, stuck Dependabot, the release judgement) belong to `health` and `release-due`; do not repeat them here. Dependency bumps belong to Dependabot; this brief only touches pins it cannot see.

`CLAUDE.md` binds every change.

## Rows

One per task below; the PR body (or the no-PR reason) gives each row's verdict.

- `gate`: `bin/check` passes on fresh `main`
- `tool-pins`: the Bun, node and Chromium pins are current and agree
- `deps`: nothing in the production tree has a published advisory
- `docs-truth`: `CLAUDE.md`, `README.md`, `docs/idea/` and `.dz/` match the files

## Start

```sh
git fetch origin && git checkout -B chore/weekly-maintenance-$(date -u +%F) origin/main
gh run list --workflow ci.yml --branch main --event push --limit 1 --json conclusion,headSha
bin/setup
```

If the newest push run of `ci.yml` on the `origin/main` tip did not conclude `success`, stop: no PR is owed, `health` files a red `main`. If an open pull request titled `chore(maintain): weekly maintenance …` exists, stop: last week's run is still in review.

## Tasks, in order

Do each task whose check fails. Each fix is its own commit (Conventional Commits); all of them go on the one branch above.

### 1. `gate`: the local gate on fresh `main`

```sh
bin/check
```

- **Pass:** exit 0.
- **Fail:** fix the root cause (a test that fails on `main` first, then the code), never a retry, a skip or a weakened assertion. If the fix is bigger than this run, stop: no PR is owed; name the failure in the reason.

### 2. `tool-pins`: pins Dependabot cannot see

Dependabot covers the `bun` ecosystem and GitHub Actions. It does not see:

- **Bun:** `bun-version` in `.github/workflows/ci.yml` (both jobs) and `release.yml`, and `bun` in `mise.toml`. Latest: `gh api repos/oven-sh/bun/releases/latest --jq .tag_name`. Behind by a release at least 7 days old: bump all four in one commit (`src/setup-bun-version.test.ts` holds them equal), then `bin/setup && bin/check`. A red gate on the new Bun leaves the pin and says why.
- **node:** CI runs the build on `24` and the pack smoke on the `engines.node` floor (`>=22`). The floor is a deliberate member call; only the CI/`mise.toml` `24` may move, and only to the current LTS.
- **Chromium:** it follows the `playwright-core` version in `bun.lock`; `bin/setup` installs that revision. After a Dependabot bump of `playwright-core` merged, `bin/setup && bin/check` must still pass; if the CI cache key comment in `ci.yml` (`playwright-v2`) no longer describes reality, fix the comment.

### 3. `deps`: advisories in what users install

```sh
bun audit --json
bun pm ls --all
```

Act only on a package in the production dependency tree, transitive included. A fix that needs a `dependencies` range change is a member's call: leave it and say so. A published high/critical advisory that reaches users is `security-release`'s, not this PR's.

### 4. `docs-truth`: written claims against the files

Each check prints nothing when it passes. Fix what it prints in the doc, never the code to match a doc.

```sh
# every src/ path named in the docs exists
grep -rhoE 'src/[A-Za-z0-9_/.-]+\.ts' CLAUDE.md README.md docs/idea .dz | sort -u | while read -r p; do test -e "$p" || echo "missing: $p"; done
# every `bun run <script>` named in the docs exists
grep -rhoE 'bun run [a-z:]+' CLAUDE.md README.md CONTRIBUTING.md .dz | sort -u | while read -r _ _ s; do
  jq -e --arg s "$s" '.scripts[$s]' package.json >/dev/null || echo "no script: $s"; done
# every bin/ script named in the docs exists
grep -rhoP '(?<![/\w])bin/[a-z-]+' CLAUDE.md README.md CONTRIBUTING.md .dz | sort -u | while read -r p; do test -e "$p" || echo "missing: $p"; done
# the default models CLAUDE.md, README.md, docs/idea/config.md and the example config name match src/config/load.ts
grep -rhoE '[a-z-]+/[a-z0-9.-]+:(free|floor)' CLAUDE.md README.md docs/idea .ui-debugger-mcp.example.json | sort -u
grep -oE "'[a-z-]+/[a-z0-9.-]+:(free|floor)'" src/config/load.ts | tr -d "'" | sort -u
```

`src/doc-paths.test.ts` already guards path rot in the docs; this reads what a test cannot: a tool parameter, default or CLI subcommand the docs state that the code no longer has (`src/mcp/tools/*.ts`, `src/config/schema.ts`, `src/main.ts`). One `docs:` commit per document.

## Ship

- Nothing changed: open no PR. End with the reason: each task's verdict (pass, fixed, or why not).
- Otherwise one pull request from the branch above, titled `chore(maintain): weekly maintenance <YYYY-MM-DD>`. Body: one section per task that changed something, with the command and its output before and after. `bin/check` is green on the final head before it is opened.
- Never in this PR: a version bump, `CHANGELOG.md`, `.github/workflows/release.yml` beyond the Bun pin, `dependencies`, or any change under `src/` other than the `gate` fix.
- One PR per run: no second PR for a task, no PR for a lone typo.
