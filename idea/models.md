# Models — the three actors

Three actors, plain terms: **the smart agent, the fast guy, the vision guy.**

| Nickname | Role | Where | Model | Sees pixels? |
|----------|------|-------|-------|--------------|
| **smart agent** | the boss — sets goals, reads findings, **fixes the code**, loops | outside (Claude / caller) | the host's | via screenshots in findings |
| **fast guy** | the **driver** — controls browser/desktop/android, runs the click loop | in-server | `deepseek-v4-flash` (text) | **no — blind** |
| **vision guy** | the **eyes** — describes screenshots, judges how it looks | in-server | `glm-5v-turbo` (image) | **yes** |

The smart agent talks to the in-server agent over MCP (a conversation). Inside,
the fast guy drives blind and asks the vision guy for eyes when needed. Three
specialists, each cheap at its job.

**One goal: the UI WORKS *and* LOOKS NICE.** Fast guy proves it works (flows,
console, network); vision guy proves it looks right (alignment, colour, spacing);
smart agent fixes the code until both pass, then writes the test. Functional +
visual, every loop.

---

The fast guy + vision guy cooperate like a **blind person and a sighted helper**.
One drives; one describes what it sees and is asked questions.

```
 driver (fast, text-only)  ──"does this look right? where is X?"──▶  vision (multimodal)
   controls via structure                                            describes pixels
   DOM / a11y tree / ADB                                             colors, layout, alignment
        ◀────────────────"the button sits left of centre, blue #2b6"────────────────
```

## The two roles

- **driver** — fast, **text-only**, cheap. Runs the high-frequency click loop.
  Controls browser/desktop/android through **structured protocols** (CDP DOM,
  AT-SPI tree, ADB hierarchy). It is effectively **blind** — it acts on structure,
  not pixels. This is where most turns happen, so it must be cheap and fast.
- **vision** — **multimodal** (images + text). The **eyes**. Given a screenshot
  and a question, it describes what it sees and judges *how it looks*: colour,
  spacing, alignment, "is the button centred horizontally?", "does this match the
  intended design?". Returns **text** the blind driver can act on.

It's the cooperation of a blind man and a man who describes the scene: the blind
one does the moving and asks — *"is the cup to my left?"* — and acts on the answer.

## The loop

1. driver acts on structure (find node, click, type) — no vision needed.
2. when it needs **eyes** ("does this look right?", "where is X visually?", "is
   it centred?"), it calls **`look`** → the vision model describes / judges.
3. driver continues, or records a **visual finding** (with the screenshot as
   evidence).

## Why split the models

- **Cost + speed.** Vision tokens are slow and expensive; driving is
  high-frequency. Keep the loop on a cheap fast text model; spend the vision
  model **only when visual judgment is needed**.
- **Specialisation.** Text model = great at protocols, selectors, logic. Vision
  model = great at describing pixels. Each does what it's best at.
- **Swappable.** Both come from any **OpenAI-compatible router**, set **per
  role** — pick a tiny fast model to drive, a strong multimodal one to see.

## Config — model roles (defaults: deepseek text, glm image)

`.ui-debugger-mcp.json`:
```jsonc
"models": {
  "driver":  "deepseek/deepseek-v4-flash#uptime",  // fast guy — text, controls
  "vision":  "z-ai/glm-5v-turbo",                  // vision guy — image, describes
  "summary": "deepseek/deepseek-v4-flash"          // optional — compress findings
}
```
Defaults if omitted: **deepseek for text** (driver + summary), **glm for image**
(vision). Capability-based assignment, same idea as `../ai-task-master`'s roles.
Provider = any OpenAI-compatible endpoint (`OPENAI_BASE_URL` + `OPENAI_API_KEY`);
OpenRouter is the default — see [`config.md`](config.md#providers--openai-compatible-routers).

## The `look` tool — the cooperation seam

The bridge between blind and sighted lives in the inner belt
([`mcp-tools.md`](mcp-tools.md)):

```
look({ question?, expect? })
  → capture screenshot of the current target
  → send to the VISION model with the question + expected look
  → return { description, matches?, issues:[{ what, where, severity }] }
```

The driver **never "sees"** — it asks. Every **visual finding** (button not
centred, colour off, overlap, cut-off text) is born here, screenshot attached.

## Why CDP for web — what the driver is taught

Models are already good at CDP; the system prompt teaches **the bits and the
why**, so the driver reaches for it deliberately:

> **CDP is the universal lever.** One protocol/connection reaches *everything*:
> the current page, **every iframe** (including out-of-process), **all tabs and
> windows**, workers — plus DOM, console, network, input, and screenshots.

The prompt teaches the relevant domains — **Target** (enumerate/switch
tabs+frames), **Page** (navigate, capture), **DOM** (query/read), **Runtime**
(eval in a context), **Network/Log** (console + requests) — and the rule:
**structure first** (DOM/a11y), **eyes only when needed** (call `look`). From one
connection the blind driver can enumerate tabs, switch into an iframe, read the
DOM, eval, and capture — no per-feature tool needed. That reach is *why* CDP, and
why the web target is the richest.

This teaching is provider-agnostic and lives in our prompts — see
[`mcp-tools.md`](mcp-tools.md#system-prompts--we-own-them-provider-agnostic).
