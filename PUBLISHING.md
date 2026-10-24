# Publishing

Publishes to npm as **`@developerz.ai/ui-debugger-mcp`** (public scope).

Releases use **OIDC trusted publishing** from GitHub Actions
(`.github/workflows/release.yml`) — no `NPM_TOKEN` secret. npm mints a
short-lived token from the run's OIDC identity and attaches a provenance
attestation automatically.

## One-time bootstrap (manual, requires npm auth)

A trusted publisher can only be attached to a package that **already exists**, so
the first version (v1) must be published by hand by a member of the
`developerz.ai` npm org:

```sh
npm login                    # as a developerz.ai org member
bun install && bun run build # emits dist/
npm publish                  # publishConfig already sets --access public + provenance
```

## One-time: configure the trusted publisher

On npmjs.com:

`npmjs.com/package/@developerz.ai/ui-debugger-mcp` → **Settings** →
**Trusted Publisher** → **GitHub Actions**, then enter:

| Field             | Value                |
| ----------------- | -------------------- |
| Organization/user | `developerz-ai`      |
| Repository        | `ui-debugger-mcp`    |
| Workflow filename | `release.yml`        |
| Environment       | *(leave blank)*      |

(The GitHub org is `developerz-ai` with a hyphen; the npm scope is
`@developerz.ai` with a dot — both are correct.)

## Ongoing releases (automated)

1. Bump `version` in `package.json`, commit.
2. Publish a GitHub Release (or **Actions → release → Run workflow**).
3. The workflow installs, builds, validates, and runs `npm publish` over OIDC. No token.

### Validation gate (both routes)

Both publication routes go through the same `publish` job in `release.yml`:
the `release: types: [published]` trigger and the manual `workflow_dispatch`
trigger. There is one gate, and it sits between the build and the first
publish step.

Before anything is published, the job runs the **version-consistency tests** of
the checked-out revision:

```sh
bun test src/index.test.ts src/mcp/registry-server-json.test.ts
```

Those tests are the same ones CI runs: the exported `VERSION` must match
`package.json`, `server.json`'s `version` and `packages[0].version` must match
`package.json`, and `server.json` must validate against its own `$schema`. A
`server.json` pointing at a version that does not exist on npm is exactly the
failure this gate exists to stop.

The gate is **mandatory and unfailable**:

- it carries no `continue-on-error`, so a failing test fails the job;
- it carries no `if:` condition, so it can never be skipped;
- it runs AFTER `build` and BEFORE both `npm publish` and the MCP Registry
  publish — a failed or missing validation therefore blocks *both* publication
  steps, not just npm.

The checkout is pinned to `ref: ${{ github.ref }}` and the run echoes
`git rev-parse HEAD`, so the commit that was validated is provably the commit
`npm publish` publishes from (the package is built from this same working
directory).

## Registry publication (automated, same OIDC run)

This package is registered in the official [MCP Registry](https://modelcontextprotocol.io/registry).
`release.yml` publishes it right after `npm publish`, in the same job, using
`mcp-publisher login github-oidc` — the identity GitHub already minted for npm.
**No token, no interactive login, nothing to do by hand.**

Ordering matters: the registry resolves the npm package named in `server.json`
and rejects a version it cannot find, so the registry step must follow npm.

Both steps sit behind the same validation gate described above — the registry
publish is blocked by a failed validation just like `npm publish` is.

`server.json` (committed) holds the registry metadata — `registryType: npm`,
`transport: stdio`, environment variables with `isSecret` markers. Its `version`
must be bumped alongside `package.json`; `mcp-publisher validate` checks the
schema without publishing.

The namespace `io.github.developerz-ai/*` is authorized by the GitHub org that
owns this repo, which is what makes OIDC sufficient — keep the `name` in
`server.json` under it.

### The CLI

`mcp-publisher` is a **Go binary** from
[`modelcontextprotocol/registry`](https://github.com/modelcontextprotocol/registry/releases),
not an npm package. `npx mcp-publisher` fetches an unrelated package that starts
a stdio MCP server and does nothing useful here. To run it locally:

```sh
curl -fsSL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" | tar xz mcp-publisher
./mcp-publisher validate               # schema check, no auth needed
./mcp-publisher login github           # interactive, only for a manual publish
./mcp-publisher publish
```

## Requirements baked into the workflow

- `permissions: id-token: write` — lets npm mint the OIDC token.
- npm CLI `>= 11.5.1` — the workflow upgrades npm because Node 22 ships an older one.
- `publishConfig.access: public` + `provenance: true` in `package.json`.
