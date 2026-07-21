# 04 — Browser adapter + contract

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `src/adapters/browser/browser-adapter.ts:571-577,584-588` — anything throwing after `launchPersistentContext`/`connectOverCDP` leaves the context open → zombie Chrome holds the persistent-profile lock, blocking every later run.
- `src/adapters/browser/browser-adapter.ts:556-589` — `create()` failures (incl. profile-locked, the most common) escape as raw Playwright `Error`s, violating the file's own "every Playwright call wrapped to AdapterError" header.
- `src/adapters/browser/browser-adapter.ts:672-676` — `scroll` with `within` has no viewport check (unlike `click` at `:646`) → off-screen region silently no-ops.
- `src/adapters/browser/browser-adapter.ts:734-753` vs `src/adapters/contract.ts:91` — `Query.fields` projection silently ignored by `#collect` (observe re-projects, other consumers get full nodes).
- `src/adapters/browser/browser-adapter.ts` — 775 LOC > 500 rule: extract in-page `NODE_EXTRACTOR` + DOM typings (~230 lines) to `src/adapters/browser/extractor.ts`.
- Lows: `:750-751` validate `limit` (negative/NaN) like `cdp.ts:236-241` does; `:308` add `readonly`/`aria-readonly` (+ `fieldset[disabled]` ancestor) to `enabled` per `contract.ts:41`; `:766-774` `#run` must pass AdapterError through (attach original as `cause`), no double-wrap; `:585-586` attach mode picks `pages()[0]` arbitrarily — select the active page or document the single-tab constraint in `contract.ts`; `cdp.ts:349,356` wrap sink invocation in try/catch; `contract.ts:193,196` fix "Drain" wording (reads are non-destructive).

## Steps
1. Wrap post-connect steps of `#launch`/`#attach` in try/catch → `context.close()`/`browser.close()` then rethrow as `AdapterError` (profile-locked gets a clear message).
2. `scroll`: apply the same `isOutsideViewport` guard before `mouse.move`.
3. `#collect`: implement `fields` projection (reuse observe's projector) — or, if simpler, delete `fields` from `Query` and keep projection in observe only; pick one, update `contract.ts` doc either way.
4. Extract `NODE_EXTRACTOR` module; no behavior change; both files ≤500 LOC after.
5. Apply the lows (each ≤5 lines except attach-page selection — prefer documenting the constraint over guessing the active tab).

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
