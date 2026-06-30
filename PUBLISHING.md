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

## Requirements baked into the workflow

- `permissions: id-token: write` — lets npm mint the OIDC token.
- npm CLI `>= 11.5.1` — the workflow upgrades npm because Node 22 ships an older one.
- `publishConfig.access: public` + `provenance: true` in `package.json`.
