# MCP tools — the two-layer design

Two layers of tools, two different audiences. The bible's rule
("[few parameterized tools beat many](../../sebyx07/claude-code-bible/docs/07-memory-and-mcp.md)")
applies to both, but the win lands differently at each layer.

```
 smart Claude
     │  ── OUTER: MCP tools (this server exposes) ── few, conversational
     ▼
 debug agent  (small model, in-server, Vercel AI SDK)
     │  ── INNER: agent tool belt (observe / act / report) ── few, parameterized
     ▼
 adapter contract  (open · find · click · type · readState · screenshot · waitFor)
     │  ── protocol / libs ──
     ▼
 browser (CDP) · desktop (X11/Wayland) · android (ADB)
```

The whole point: **the agent boundary is the compression.** All the per-click
complexity lives at the inner layer. The smart agent never sees it.

---

## Outer layer — what smart Claude sees

A tiny, constant-size surface. The smart agent talks **goals and feedback**, not
clicks. This is the "don't ship one tool per action" rule taken to its limit —
the small agent absorbs every low-level action, so the MCP surface stays ~5 tools
no matter how complex the debugging gets.

| Tool | Input | Returns |
|------|-------|---------|
| `start_debug`   | `{ target, goal, criteria? }` | `session_id` |
| `send_message`  | `{ session_id, message }`     | ack — inject work mid-run |
| `get_findings`  | `{ session_id, wait?, fields? }` | status + findings + evidence paths |
| `describe`      | `{}` or `{ target }`          | targets catalog + config (lazy) |
| `end_session`   | `{ session_id }`              | closes it |

### Why plain few-tools, not the 3-tool meta-dispatcher

The bible's `list/describe/manage_resource` dispatcher is for **large CRUD
surfaces** (50+ resources). We have ~5 verbs hit every turn — the bible says
plainly: *"for a handful of resources hit on every turn, plain tools can still
win — the handshake never amortizes there."* So: plain tools, no dispatcher.

### Apply the parameterization rule anyway

- **Fold, don't multiply.** One `get_findings` with a `fields` param — not
  `get_status` + `get_bugs` + `get_screenshots`. Model asks for what it needs.
- **Rich `describe`.** Carry each target's name + one-line capability inline
  (list_resources-style) so the smart agent picks a target without a round-trip.
- **`criteria` over tool variants.** Pass/fail rules go in a param, not in
  `start_debug_strict` vs `start_debug_loose`.

### Anti-patterns (outer)

- ❌ Exposing `click`, `type`, `screenshot`, `navigate` to smart Claude. That's
  playwright-mcp — chatty, expensive, one action per round-trip. The whole
  project exists to **not** do this.
- ❌ A tool per target (`debug_web`, `debug_mobile`). Target is a param.

---

## Inner layer — the debug agent's tool belt (SQL-like)

The small model drives the target through its own Vercel AI SDK tools. Here
granularity is needed (it really does click and type), but still **few + heavily
parameterized** — treat each protocol like **SQL/REST, not RPC.** The bible:
*"AIs are very good at SQL and REST precisely because those interfaces are
heavily parameterized — one SELECT, one GET, dozens of knobs. That's the same
shape MCP tools should have."* So: a handful of verbs, lots of composable params.

| Tool | Shape | Maps to adapter |
|------|-------|-----------------|
| `observe` | `{ kind, query?, fields?, filters?, limit? }` | `readState` / `screenshot` |
| `act`     | discriminated union: `click \| type \| key \| scroll \| navigate \| wait` `{ target, ... }` | `find` + `click`/`type`/`waitFor`/`open` |
| `report`  | `{ bugs[], visual[], steps[], summary }` (Zod) | → surfaced via `get_findings` |

- **One `act`, not six tools.** `act({action:"click", target})` beats
  `click_element` / `fill_input` / `press_key` — gold-standards discriminated-union.
- **One `observe`, not four.** `kind` selects tree / screenshot / console / network.
- **`report` is the bridge.** Structured, Zod-validated; exactly what outer
  `get_findings` returns. No prose parsing.

### SQL-like parameters (the knobs)

Push composition into params, like a `SELECT`:

| Param | Like | Use |
|-------|------|-----|
| `query`   | `WHERE` / selector | target a node: CSS/role/text (web), a11y role+name (desktop), resource-id/text (android) |
| `fields`  | `SELECT cols` | sparse reads — ask only for role/name/bounds, not the whole tree |
| `filters` | `WHERE field_op` | `{ visible_eq: true, role_in: ["button","link"] }` |
| `limit` / `within` | `LIMIT` / scope | cap tree size; scope to a subtree/region |
| `kind`    | table | `tree \| screenshot \| console \| network` |

One `observe({kind:"tree", query:"role=button[name=Checkout]", fields:["bounds","enabled"]})`
beats a dozen `get_*` tools. The model composes the call; that's what it's good at.
**Whitelist** allowed `fields`/`filters` per adapter — don't ship an injection surface.

The agent loop is **adapter-blind** — `act`/`observe` hit the shared contract;
the contract is implemented per protocol below.

---

## System prompts — we own them, provider-agnostic

The debug agent's behavior comes from **our** system prompts, checked into this
repo — **not** from whatever a 3rd-party model does by default. OpenRouter lets
the model swap freely; the prompt must make any competent model behave the same.

- **In-repo, versioned, tested.** Prompts live under `src/agent/prompts/`
  (e.g. `debug-agent.md`, per-target addenda). Treated as code: reviewed,
  diffed, unit-tested against expected tool-call behavior.
- **Don't rely on model defaults.** Never assume the model "knows" to take a
  screenshot on failure, report visual issues, or stop at the goal. Spell it out:
  the loop, when to `observe` vs `act`, what a finding must contain, pass/fail
  rules, when to ask the smart agent vs proceed.
- **Composed, not monolithic.** Base debug-agent prompt + target addendum
  (web/desktop/android specifics) + the session's `story` + `criteria`. Same
  composition pattern as `../ai-task-master` subagents.
- **Provider-agnostic.** No vendor-specific tricks. Swap Claude↔GLM↔Llama via
  OpenRouter and the prompt still drives the same loop.

This is what makes the debugger reliable across model choices instead of
inheriting some provider's unstated behavior.

---

## Bottom layer — protocols / libs

The adapter contract bottoms out in real protocols (see
[`adapters.md`](adapters.md), [`desktop-control.md`](desktop-control.md)):

| Adapter | Protocol | Likely lib |
|---------|----------|------------|
| browser | CDP      | Playwright / puppeteer-core (drive directly, in-process) |
| desktop | X11/Wayland input + AT-SPI | xdotool / ydotool / libei + AT-SPI (`Atspi` GI) |
| android | ADB      | adb + uiautomator (or Appium UiAutomator2) |

### Build vs reuse (web)

Because the brain is in-server, the web adapter wraps the **Playwright library
directly** — simpler than mounting playwright-mcp as a client (no second MCP
hop, full CDP access for console/network). Desktop + android have no
off-the-shelf MCP worth wrapping → custom adapters over the libs above.

> If we ever *did* want to reuse an external MCP (e.g. chrome-devtools-mcp), the
> debug agent would mount it as an **MCP client** (`@ai-sdk/mcp`, gold-standards
> pattern) and merge its tools into the inner belt. Not needed for v1.

---

## Implementation notes

- Outer tools: defined with Zod input schemas; `describe` doubles as the catalog.
- Inner tools: Vercel AI SDK `tool()` with discriminated-union `inputSchema`.
- Everything Zod-validated at the boundary. Custom errors, never generic `Error`.
- Cost: outer surface is flat (~5 tools); the smart agent's context never grows
  with debugging complexity — that's the design goal.
