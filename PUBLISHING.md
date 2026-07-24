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
3. The workflow installs, builds, and runs `npm publish` over OIDC. No token.

## Registry publication (automated, same OIDC run)

This package is registered in the official [MCP Registry](https://modelcontextprotocol.io/registry).
`release.yml` publishes it right after `npm publish`, in the same job, using
`mcp-publisher login github-oidc` — the identity GitHub already minted for npm.
**No token, no interactive login, nothing to do by hand.**

Ordering matters: the registry resolves the npm package named in `server.json`
and rejects a version it cannot find, so the registry step must follow npm.

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
