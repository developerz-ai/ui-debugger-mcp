# The agent loop — a conversation

The smart agent and the small debug agent hold a **live conversation** inside a
session. Not fire-and-forget, not a remote control. The smart agent gives intent
in plain language; the small agent works and reports; the smart agent can keep
talking **while the small agent is still working**.

## Roles

- **Smart agent** (Claude / you) — high level. Sets goals, reads findings, fixes
  code, gives feedback, decides when it's done.
- **Small agent** (inside this server) — does the work. Drives the target,
  watches console + network, screenshots, judges how it looks, reports findings.

## The flow

```
smart → start_debug   "On web: log in as test@x, go to checkout, buy item #3."
small ↘  (working: navigates, clicks, watches) → streams progress + findings
smart → send_message  "Also tell me if the price total looks wrong."   ← injected mid-run
small ↘  ...continues, folds in the new ask
small → findings      bugs[], visual[], evidence paths, pass/fail per step
smart    (fixes code)
smart → send_message  "Try again."
small → findings      confirms fixed / reports what's still broken
smart    ...loop...
smart → end           done
```

## Mid-run message injection

The smart agent can send messages **while the small agent is working**:
- add work ("also check the mobile view")
- redirect ("skip checkout, the login is the bug")
- answer a question the small agent raised
- tighten the goal ("only care about the navbar now")

The small agent picks these up between steps and adapts. This is what makes it a
conversation, not a job queue.

## Two kinds of feedback

The small agent reports BOTH:

1. **Functional** — does it work?
   - JS errors (console), failed/hung requests (network), dead buttons,
     wrong navigation, broken flows.
2. **Visual / UX** — how does it look?
   - overlap, cut-off text, bad spacing, misalignment, contrast, broken
     responsive layout, "this looks unfinished."
   - Backed by screenshots so the smart agent can judge too.

Visual feedback is the hard part a code-only agent can't see — that's the point.

## The bigger loop: find → fix → test

Designed for **Claude controlling the whole thing**:

```
1. FIND   small agent runs the flow → returns bugs + visual issues + evidence
2. FIX    Claude edits code to fix them
3. RE-RUN "try again" → small agent confirms, or reports what remains
4. TEST   Claude writes integration tests that lock the fix in
          (the story the small agent ran is a ready-made test spec)
```

So a debug story doubles as a test spec: once it passes, Claude turns it into a
real integration test so the bug can't come back.

## Findings shape (what comes back)

```
status:   running | passed | failed
steps:    [ { step, ok, note, screenshot } ]
bugs:     [ { kind: "console"|"network"|"flow", detail, evidence } ]
visual:   [ { issue, where, severity, screenshot } ]
summary:  one-paragraph verdict for the smart agent
evidence: ./tmp/ui-debugger-mcp/<project>/sessions/<id>/...
```

Structured + Zod-validated, so the smart agent never parses prose.
