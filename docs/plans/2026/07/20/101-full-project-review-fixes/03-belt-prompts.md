# 03 — Belt schemas + prompts (driver can trust its tools)

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `src/agent/prompts/compose.ts:45-71` + `debug-agent.ts:11-19` — self-look mode (`session-builder.ts:247-249`) still prompts "You NEVER see pixels… `look` = ask the vision model", contradicting `look.ts:277-279` self-look ("you are multimodal — judge it yourself").
- `src/agent/prompts/web-addendum.ts:68-73` — "Enumerate frames via the Target domain" — no observe kind/act action exposes frames/tabs; unexecutable, burns steps.
- `src/agent/prompts/web-addendum.ts:64-66` — teaches `hover`; `act.ts:34` has no hover action.
- `src/agent/belt/observe.ts:260-266` + `web-addendum.ts:92-96` — console/network observes have no default `limit` (ring holds 1000) and the prompt mandates both after EVERY act; SDK re-sends every tool result each step → context grows entries×steps on chatty pages.
- `src/agent/belt/act.ts:124,160-167` vs `src/adapters/browser/browser-adapter.ts:692-694` — bare `act({action:"wait"})` passes the belt but the adapter always throws (`waitFor requires query and/or networkIdle`).
- `src/agent/belt/observe.ts:77-83,104-108` — `within` NodeSchema requires `bounds`/`enabled`, but a fields-projected observe returns nodes without them; "pass a node exactly as returned" fails validation.
- `src/agent/capabilities.ts:59` + `src/config/load.ts:35` — catalog probe is exact-match; suffixed ids (`#uptime`, `:free` — the shipped default driver id!) never match → self-look silently lost.
- `src/agent/capabilities.ts:17-21,57-63` — `/models` response typed via `as` casts, not Zod.
- `src/agent/prompts/debug-agent.ts:26` vs `desktop-addendum.ts:26-28` — base mandates console/network observes; desktop says they error. Hedge base: "where the target supports them".

## Steps
1. Thread a `selfLook: boolean` into `composeSystemPrompt`; swap the look paragraph accordingly. Wire from `session-builder.ts:247-249`.
2. web-addendum: delete the Target-domain frames section (until frame support exists); replace "hover/click parent" with click-only guidance; teach `limit`/`level_eq`/`status_gte` filters in the console/network section.
3. `runObserve`: default `limit: 50` for `console`/`network` kinds when caller passes none (explicit limit still wins; keep fail-loud on invalid values).
4. `performAct` wait: require `query` and/or `networkIdle` in the belt schema/refinement so the invalid shape dies at validation with a steering message, not at the adapter.
5. `within` NodeSchema: make `bounds`/`enabled` optional (adapter resolution already re-finds by role/name when bounds absent — verify; else always include bounds in projections).
6. `capabilities`: strip `#…`/`:…` suffix before catalog lookup; add small Zod schema + `safeParse` for `/models` (null on failure preserves tri-state).
7. Hedge `debug-agent.ts:26`.
8. Sync `docs/idea/mcp-tools.md:77,163` (flat act schema is deliberate — `act.ts:41-47`) — or leave for slice 09; note cross-ref.

## Tests
- Prompt-vs-schema drift guard: assert every action/kind/field name mentioned in addendums exists in `ACT_ACTIONS`/`OBSERVE_KINDS`/`NODE_FIELDS` (would have caught hover + frames).
- selfLook prompt variant snapshot test (both modes, contradiction absent).
- console/network default limit applied; explicit limit wins.
- Bare `wait` rejected at belt with steering message.
- `within` accepts a fields-projected node.
- Suffixed model id (`deepseek/deepseek-v4-flash#uptime`) resolves self-look capability; malformed `/models` payload → null.
- Run: `bun test src/agent`, full suite after.

## Done when
- No prompt instruction references a verb/field the schemas reject (guarded by test).
- Chatty-page console/network reads are bounded by default.
- Self-look sessions get a self-look prompt.
