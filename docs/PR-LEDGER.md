# PR Legder — Leg 3 (core)

Goal: `rtk_ed77cbd08b85496d968c651572c24e1c`, leg 3 — review agent loop / MCP / service boundaries for correctness, reliable teardown, and unintended disclosure.

Tag: `core` (single coherent cross-boundary change; no two tags share a file)

---

## Boundary 1 — Model / observe: persona values must not reach the driver or the trail

**Finding.** `observe` reads console + network rows from the adapter and returned them to the driver unredacted; a persona's typed value (typed into the app under test) is echoed back in console text and source locations (`url?token=…`) and recorded on the trail as bugs.

**Fix.** `runObserve` now applies the run's `Redactor` (bound per run to the persona's values via `createSecretRedactor`) to every console and network row before it reaches the driver or the trail. The `observe` tool threads `redact` through to `runObserve`. Redaction is keyed off VALUE (not header name), so form POST values echoed by adapter errors are scrubbed too.

**Tests.** `src/agent/belt/observe-redaction.test.ts`: console text+location redacted; network query+body redacted; wired `observe` tool output keeps secrets out of both bug detail and evidence; both channels route through the redactor.

**Files changed.** `src/agent/belt/observe.ts`, `src/agent/belt/observe-tool.ts`.

---

## Boundary 2 — Model / vision: persona values must not reach the vision model

**Finding.** `runLook` built the vision prompt from the raw `question`/`expect` text and sent it to the vision model — a persona value typed into the app would reach the provider.

**Fix.** `runLook` now accepts a `Redactor` and applies it to the built prompt text before the generate call. `createLookExecute` and `createLookTool` thread `redact` through; `session-builder.ts` wires the run's persona-bound redactor into `createLookTool`.

**Tests.** `src/agent/belt/look-secret.test.ts`: `runLook` redacts secret values from `question` and `expect` text before the vision request.

**Files changed.** `src/agent/belt/look.ts`, `src/services/session-builder.ts`.

---

## Boundary 3 — Logging / session logs: raw secrets must not reach disk

**Finding.** (Pre-existing, already covered by `createSecretRedactor` + `createCaptureSink` — re-verified as part of this leg.) Every captured console/network row passes through the run's redaction gate on its way into `logs/console.log` / `logs/network.log`, and `describe` exposes persona names only.

**Tests.** `src/redact.test.ts` (existing suite); no new test needed — pinned by existing `observe-redaction.test.ts` covering console+network redaction paths.

**Files changed.** (None new — boundary already held; verified, not added to.)

---

## Teardown — failed run / cancellation still closes adapter + frees lock

**Finding.** `Session.close()` awaited `this.#run` and only called `adapter.close()` after it resolved; if the loop crashed or was aborted (`#run` rejected), `adapter.close()` never ran — the browser stayed on its Chrome user-data profile lock and the target was never released. Attached targets (web `cdpUrl`, android `adbSerial`) are never started/stopped by the server — unchanged.

**Fix.** `close()` now wraps the `await this.#run` in `try/finally` so `adapter.close()` runs unconditionally when a run exists; a session with no run still closes its adapter. The close error (e.g. a wedged target) still propagates after `close()` has fired. `end()` / `endActive()` in `debug-service.ts` already clear the breadcrumb in `finally` so a stale `state.json` never survives a failing teardown.

**Tests.** `src/services/debug-service-teardown.test.ts`: close after loop crash still closes adapter (1 call); idle run closes exactly once; no-run close still closes; close error propagates while adapter still closed once.

**Files changed.** `src/session/session.ts`.

---

## LOC rule

Every changed file stays at or under 500 LOC (checked with `wc -l`):

| File                                 | LOC |
| ------------------------------------ | --- |
| `src/agent/belt/observe.ts`          | 500 |
| `src/agent/loop.ts`                  | 498 |
| `src/session/session.ts`             | 406 |
| `src/agent/belt/look.ts`             | 487 |
| `src/services/session-builder.ts`    | 481 |
| `src/agent/belt/observe-tool.ts`     | 57  |
| `src/services/debug-service.ts`      | 499 |
| `src/agent/belt/act.ts`              | 496 |
| `src/adapters/browser/log-format.ts` | 258 |
| `src/redact.ts`                      | 165 |

New test files: `observe-redaction.test.ts`, `look-secret.test.ts`, `debug-service-teardown.test.ts` (each well under 500 LOC).

---

## Synthetic secrets only

`h@unter2` is used as the persona value in every new test — synthetic, never live. No credential was read, printed, logged or committed.
