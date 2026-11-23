# 04 — Browser adapter + contract

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change

- DONE (#202): `src/adapters/browser/lifecycle.ts:117-142`, where `launchHandles`/`attachHandles` wrap post-connect steps in `closeOnFailure` (`launch.ts:14-21`); a failure closes the context/browser, so no zombie Chrome holds the profile lock.
- DONE (#202): `src/adapters/browser/lifecycle.ts:65-86`, where `openBrowserHandles` wraps `create()` failures in `createFailure(...)` (`launch.ts:34-37`) as `AdapterError`, including profile-locked.
- DONE: `src/adapters/browser/browser-adapter.ts:289-303`, where `scroll` applies `#centerInViewport` (`:259-267`) when `within` is set, so off-screen regions no longer silently no-op.
- DONE (superseded): `Query` no longer has `fields` (`src/adapters/contract.ts:114-123`; `NodeField` remains at `:89-90`); `#collect` (`browser-adapter.ts:403-433`) returns full nodes and projection lives in `src/agent/belt/observe.ts:339-343,466`. No adapter change needed.
- DONE (#202): in-page `NODE_EXTRACTOR` + DOM typings extracted to `src/adapters/browser/extractor.ts`; `browser-adapter.ts` is now 513 lines.
- Lows: `limit` validation is DONE via `capToLimit` (`src/adapters/limit.ts`), used at `browser-adapter.ts:39,432` and `cdp.ts:35,184,196`; `readonly`/`aria-readonly`/`fieldset[disabled]` handling is DONE in `src/adapters/browser/extractor.ts:212-248` (`enabled: interactable(el)` at `:248`, contract wording at `contract.ts:46`); `#run` AdapterError pass-through with `cause` is DONE at `browser-adapter.ts:501-512`; attach `pages()[0]` selection now lives in `lifecycle.ts:139` (still open: select the active page or document the single-tab constraint in `contract.ts`); CDP sink wrapping is DONE at `cdp.ts:467-475`; `contract.ts:193,196` now describe request resource type and error, so the stale "Drain" wording is gone.

## Steps

1. DONE (#202): post-connect cleanup and `create()` wrapping live in `src/adapters/browser/lifecycle.ts` (`launchHandles`/`attachHandles`, `openBrowserHandles`), not in `browser-adapter.ts`.
2. DONE: `scroll` viewport guard is `browser-adapter.ts:289-303` via `#centerInViewport` (`:259-267`).
3. DONE: `fields` was removed from `Query` (`contract.ts:114-123`); projection is observe-only (`observe.ts:339-343,466`).
4. DONE (#202): `NODE_EXTRACTOR` lives in `src/adapters/browser/extractor.ts`.
5. Lows mostly DONE: limit via `capToLimit` (`src/adapters/limit.ts`), readonly via `extractor.ts:212-248`, `#run` passthrough via `browser-adapter.ts:501-512`, sink try/catch via `cdp.ts:467-475`. Only attach-page selection remains open at `lifecycle.ts:139`. Prefer documenting the constraint over guessing the active tab.

## Tests

- Launch-failure cleanup: fake context whose `newPage()` throws → close called, `AdapterError` thrown.
- `scroll` into off-viewport region throws.
- `#collect` respects `fields` / or Query no longer has `fields` (compile-time).
- readonly input reports `enabled: false`.
- Gap-fill from review: `adapter.type()` (integration header claims it, nothing calls it); `readState`/`find` with `within`; `waitFor` timeout expiry → `AdapterError`; `factory.ts` unit tests (unknown target → `TargetNotFoundError`, per-kind dispatch); `close()` idempotence.
- Run: `bun test src/adapters/browser` (+ integration locally: unset `SKIP_BROWSER_INTEGRATION`), full suite.

## Done when

- A failed launch never leaves Chrome holding the profile lock (verified by test).
- All `create()`/method failures surface as `AdapterError`.
- `browser-adapter.ts` ≤500 LOC; contract and implementation agree on `fields`, `enabled`, drain wording.
