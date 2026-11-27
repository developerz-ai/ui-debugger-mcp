# PR ledger: auth-secret and run-lifecycle sweep

Finding-by-finding record for this sweep. Scope: agent belt, MCP surface and service
boundaries only. Every credential used in a regression test is synthetic. Nothing in
this ledger widens target access or adds an autonomous capability.

Status legend: `verified` means the gap was confirmed by reading the code in this
checkout; `unconfirmed` means the item is a coverage request, not a proven defect.
A fix or regression test named below is the work item of the owning editor, not a
claim that it landed or passed. This docs editor ran no scoped check (by lead
decision), so no line below claims a passing test run.

## F1. `observe` tool errors reach the model unredacted

- Boundary: model (tool error fed back into the driver's context by the SDK).
- Evidence: `src/services/session-builder.ts:397` wires `observe` through
  `withToolLog` only; `src/services/session-builder.ts:144-159` logs an error copy
  and rethrows the original object; `src/services/session-builder.ts:362-366` redacts
  the log sink, not the thrown value. `src/agent/belt/redact-output.ts:52-69` is the
  existing error-redacting wrapper, applied today only to `act` and vision `look`
  (`src/services/session-builder.ts:398`, `:403-406`). `runObserve` redacts success
  fields (`src/agent/belt/observe.ts:192-329`) but a thrown adapter error is not a
  success field.
- Fix: wrap the `observe` tool in `withRedactedOutput` with the run's `Redactor`
  (`src/redact.ts:10`), preserving the error class, name and redacted stack, and
  leaving a secret-free error object untouched.
- Regression test: synthetic persona value thrown from an adapter read
  (`readState`, `console`, `network`, `tabs`) and observed at the tool boundary:
  plain, percent-encoded and JSON-escaped spellings absent from the thrown error's
  message, stack and cause; non-secret fields of successful observations still
  intact. Home: `src/agent/belt/observe-redaction.test.ts` or the existing
  `src/agent/belt/observe.test.ts` redaction section (`:661+`).
- Verification status: gap `verified` in this checkout; fix and test owned by the
  belt/service editors. Full typecheck, lint and test gate pending.

## F2. Self-look tool errors reach the model unredacted

- Boundary: model (same SDK tool-error path as F1), with the image result as a
  second constraint.
- Evidence: `src/services/session-builder.ts:399-408` selects raw
  `createSelfLookTool(adapter, store)` when control and vision are the same model;
  only the other branch gets `withRedactedOutput`. The self-look result carries the
  frame as base64 (`src/agent/belt/look.ts:379-414`), and
  `src/agent/belt/redact-output.ts:12-13` explicitly rules out blanket string
  redaction of that payload: a short secret can match inside the encoding and
  corrupt the image.
- Fix: redact the thrown error on the self-look path without touching the successful
  result, so `toModelOutput` (`src/agent/belt/look.ts:403-414`) still maps an intact
  base64 frame to its `file` part and only the prose prompt is masked.
- Regression test: synthetic persona value in a thrown self-look error is masked in
  message, stack and cause; a successful self-look keeps the exact base64 frame,
  media type and screenshot path, with its prompt prose redacted. Home:
  `src/agent/belt/look-secret.test.ts` and/or `src/services/session-builder.test.ts`
  (its `withToolLog` section at `:1087+` already pins `toModelOutput` preservation).
- Verification status: gap `verified` in this checkout; fix and test owned by the
  belt/service editors. Full gate pending.

## F3. A rejecting run can leave the target adapter open

- Boundary: run lifecycle (teardown, cancellation and failed startup).
- Evidence: `src/session/session.ts:214-218` aborts, awaits `#run`, then calls
  `adapter.close()`. There is no `try/finally` around the await and no idempotency
  guard, so a rejected run promise skips the close and a second `close()` starts a
  second abort/close sequence. `src/services/debug-service.ts:251-268` calls
  `session.close()` on a registration failure and `manager.end()` on an open failure;
  both rely on that close actually releasing the adapter. The manager frees its slot
  before closing (`src/session/manager.ts:101-112`), so a skipped adapter close is
  not visible as a busy project.
- Fix: always close the adapter once, even when awaiting the run rejects; make
  repeated `close()` calls settle the same release without a second
  `adapter.close()`. Keep failed `adapter.open()` and failed pre-run login on the
  release path too (`src/services/session-builder.ts:457-477`).
- Regression test: adapter.close is called exactly once after a rejected run; after
  cancellation during an in-flight run; after a second `close()`; and after a failed
  open or login. Verdict and findings of an already-settled run stay untouched.
  Home: `src/session/session.test.ts` and `src/services/debug-service-teardown.test.ts`.
- Verification status: gap `verified` in this checkout; fix and tests owned by the
  session/service editors. Full gate pending.

## Coverage constraints (not separate findings)

- Success-path redaction is already in place and is not to be reimplemented:
  `observe` field-by-field at `src/agent/belt/observe.ts:192-329`, findings on write
  at `src/session/findings-store.ts:80-106`, and belt result/error wrapping at
  `src/agent/belt/redact-output.ts:20-69`. It has existing tests
  (`src/agent/belt/observe.test.ts:661+`, `src/agent/belt/redact-output.test.ts:8+`).
- The value-keyed redactor already handles plain, JSON-escaped and percent-encoded
  spellings as a class (`src/redact.ts:26-38`), with unit tests in
  `src/redact.test.ts:35-125`. Extending those assertions to the belt, MCP-read and
  log boundaries is coverage work, not a proven leak. `unconfirmed` as a defect.
- MCP-read boundary: `getFindings` reads a redacted-on-write store for an owned run
  (`src/services/debug-service.ts:345-361`, `src/session/session.ts:383-388`) and a
  last-flushed snapshot for a foreign run (`src/services/foreign-findings.ts:33-52`).
  No leak was demonstrated in this checkout. `unconfirmed`; synthetic-secret tests
  at that boundary are requested by the sweep, not evidence of a defect.
- Keep `src/session/session.ts` and `src/services/debug-service.ts` at or under 500
  LOC. Both were at or under the cap when read here (`395` and `500` lines).
