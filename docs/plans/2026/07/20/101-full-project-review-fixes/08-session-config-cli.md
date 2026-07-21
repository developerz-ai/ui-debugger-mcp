# 08 — Session, config, CLI

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `src/index.ts:4` — `VERSION = '1.0.0'` vs package.json `1.1.0`; `--version` + MCP serverInfo (`server.ts:26`) lie.
- `src/config/schema.ts:28` + `session-builder.ts:211` — `profile` key on web targets validated + documented but never read; user-set profile dir silently ignored. **Wire it** (pass `target.profile ?? workspace.chromeUserData` to `createAdapter`).
- `src/config/schema.ts:24` — `headless` required though `docs/idea/config.md:118` promises a default; `.default(true)`.
- `src/session/state-file.ts:47-50,123-132` + `control.ts:142-152` — `writeState` in place (no tmp+rename); `markStatus` read-modify-write unlocked; CLI `stop` marks `stopped` AFTER SIGTERM, racing the server's `markStatus('ended')` → final status wrong or torn file read as "no run".
- `src/main.ts:34` — unknown subcommand (`stauts`) silently boots the stdio server, hanging the terminal.
- `src/main.ts:52` — relative `config.workspace` recorded into `state.json` though `StateFileSchema` (`state-file.ts:39`) documents absolute; anchor like `control.ts:73` does.
- `src/session/workspace.ts:47` — `story.md` in `SessionPaths`, promised by CLAUDE.md + `docs/idea/workspace.md:12`, never written.
- Lows: `findings-store.ts:79` unique tmp suffix (`.tmp-${pid}-${n}`); `findings-store.ts:24` add `cdp` LogChannel or strike from docs (pick: strike — CDP traffic already lands in agent/network logs); `cli/init.ts:18` move `InitError` → `src/errors.ts`; `config/load.ts:118` wrap `readFileSync` → `ConfigError`; `cli/init.ts:67` respect existing config's `workspace` before mkdir/gitignore; `workspace.ts:60` document same-basename collision in `docs/idea/workspace.md`; `control.ts:90` dead server + `running` state → print `unknown (server died)`.

## Steps
1. Version: read from package.json at build time (embed via tsc? simplest: keep constant + add test pinning to package.json, bump in release flow) — pick constant+test unless build-time injection is trivial.
2. Wire `profile`; update `docs/idea/config.md` wording if semantics change.
3. `.default(true)` for headless; example config unchanged (already explicit).
4. `writeState`: tmp+rename (mirror findings-store); CLI `stop`: mark `stopped` BEFORE signaling; server `markStatus('ended')` must not overwrite terminal `stopped` (now guaranteed by ordering).
5. `main.ts`: unknown arg → usage + exit 1; anchor workspace to absolute.
6. Write `story.md` (goal + criteria + target) in `buildSession` next to `ensureSession`.
7. Apply lows.

## Tests
- VERSION === package.json version (kills the drift class).
- `main.ts` dispatch: unknown subcommand exits 1 (spawn `dist/main.js` or extract dispatch fn).
- stop-vs-end ordering: after CLI stop flow, state reads `stopped`; concurrent writeState never yields a torn read (tmp+rename).
- `profile` set → adapter receives it; unset → workspace default.
- Minimal web target `{adapter,url}` parses.
- story.md written with goal/criteria.
- Gap-fill: `tryReadFindings` corrupt-file; concurrent `writeFindings`; `STARTER_CONFIG` parses with `ConfigSchema`; process-identity `unverifiable` branch; control EPERM path; runStatus with real findings.json.
- Split `session.test.ts` (797 LOC) while touching it.
- Run: `bun test src/session src/config src/cli`, full suite.

## Done when
- `--version`, serverInfo, package.json agree, test-pinned.
- Every documented config key is either honored or gone.
- `ui-debugger-mcp stop` deterministically leaves `stopped`; no torn state reads.
