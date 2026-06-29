# Overview — the problem & the idea

## The problem

AI writes the code fine. AI can't tell if the **UI** works.

Backend code has unit + integration tests. UI does not, really — a human still
opens the app, logs in, clicks around, and says what's broken or ugly. When a
whole product is built by AI, that human-in-the-loop is the
bottleneck. It's slow, repetitive, and annoying.

## The idea

A local MCP server that takes the human out of the UI-debug loop.

- A **smart agent** (Claude / you) finishes a change and wants to verify the UI.
- It opens a **conversation** with a **small fast agent that lives inside this server**.
- The small agent drives the real browser / desktop / mobile window, watches
  console + network, takes screenshots, and reports back:
  - **does it work?** (functional bugs, errors, hangs)
  - **how does it look?** (layout, overlap, spacing, polish — visual/UX feedback)
- The smart agent fixes the code, and continues the conversation: *"try again",
  "now also check the mobile view", "the button still overlaps?"*
- **Loop until the UI works and looks right.**

## The full loop (you driving)

This is meant for **Claude controlling it end-to-end**:

```
1. FIND   — ask the debug agent to run the flow → it reports bugs + visual issues
2. FIX    — Claude edits the code to fix what came back
3. RE-RUN — continue the conversation: "try again" → confirm fixed
4. TEST   — Claude writes integration tests that lock the fix in
```

So the debug agent isn't just a tester — it's how the AI **closes its own loop**:
find bugs, fix them, prove they're fixed, write the test so they stay fixed.

## Not playwright-mcp

[playwright-mcp](https://github.com/microsoft/playwright-mcp): the smart model
issues every click itself — one action per round-trip, expensive, low-level.

Here: the smart model **talks to** a small agent that owns the clicking. The
smart model stays high-level (goals, feedback, fixes). Few tools, a real
conversation, structured findings — not a remote control.

## Principles

- **Linux first.** x11 / wayland. Adapter-based.
- **Headless by default** for web.
- **One session at a time** per project (persistent browser profile locks it).
- **Session = current dir.** Open it in the repo, it debugs that repo.
- **Evidence over claims.** Every finding has a screenshot / log to back it.
