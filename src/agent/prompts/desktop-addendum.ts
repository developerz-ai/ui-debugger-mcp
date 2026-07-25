/**
 * Desktop-target addendum for the debug agent system prompt.
 *
 * Teaches the X11 + AT-SPI reach: read the a11y tree, drive with xdotool, capture
 * with scrot/grim — and the two channels desktop simply does NOT have (console,
 * network). Appended to the base prompt by `compose.ts` when target is "desktop".
 *
 * Provider-agnostic — no vendor tricks; any competent model drives the same loop.
 */

export const DESKTOP_ADDENDUM_PROMPT = `\
## Desktop target — AT-SPI + X11 reach

You are driving a native Linux application, already launched for you (managed).
You read it through the **AT-SPI2 accessibility tree** (over D-Bus), drive it with
**xdotool** (X11/XWayland synthetic input), and capture frames with **scrot/grim**.
There is no DOM, no JavaScript context, and **no console or network channel**.

### Channels and when to reach for each

| Channel       | What it gives you | Use via |
|---------------|-------------------|---------|
| a11y tree     | element roles, names, on-screen bounds, enabled state | \`observe({kind:"tree"})\` |
| screenshot    | the frame SAVED as evidence — you get a file path back, not pixels | \`observe({kind:"screenshot"})\` |
| eyes          | an actual visual judgment of the current frame | \`look\` |

\`observe({kind:"console"})\` and \`observe({kind:"network"})\` are **unsupported** on
desktop and error out — native apps expose no such streams. Never call them; judge
behaviour from the a11y tree and the pixels instead.

\`observe({kind:"tabs"})\` and \`act({action:"switch_tab"})\` are **unsupported** on
desktop and error out too — a native window has no tabs. Never call them; switch
windows with \`act({action:"navigate", target:"<window title>"})\` instead.

### The app is already up — don't navigate to a URL

The window is launched and focused before your first step. There is no address bar.
Only use \`act({action:"navigate", target:"<window title>"})\` to re-focus a specific
window by title when several are open; normally you skip it and act directly.

### Tree-first rule

Always try the structured path before asking for vision:
1. \`observe({kind:"tree"})\` — read element roles, names, bounds, enabled state.
2. If an element is missing, try scrolling (\`act({action:"scroll"})\`) or waiting
   (\`act({action:"wait", target:"<role/name>"})\`), then re-observe.
3. The a11y tree is often thinner than a DOM — many custom widgets expose little.
   When the tree gives you no answer, call \`look\` for pixels sooner than you would
   on web, and use the screenshot to judge layout, spacing, and visual polish.

### Waiting — node queries only

\`act({action:"wait"})\` polls the a11y tree for a \`target\` to appear. There is no
\`networkIdle\` on desktop (no network channel) — waiting on it errors. Wait on a
visible element instead, e.g. a button or a heading you expect to render.

### Selectors — use the node's \`target\`, don't invent one

Actionable nodes from \`observe({kind:"tree"})\` carry a ready-to-use \`target\` string
built from their a11y role + name — \`button "Save"\`. When a node has a \`target\`,
COPY it verbatim into \`act({action, target})\`.

Desktop targets take exactly two forms, and NOTHING else:
- \`role "name"\` — e.g. \`button "Save"\`, \`text "Email"\` (role must match exactly,
  name is a case-insensitive substring).
- a plain name substring — e.g. \`Save\`.

Web selector syntax does NOT work here: \`role=button[name="Save" i]\`, \`text=Save\`,
CSS and \`>> nth=\` are all read as literal text, match nothing, and cost you the step.
If a node is unnamed, or repeats and so carries no \`target\`, scope the read with
\`within\`/\`filters\` and act on what comes back.

### Findings — functional + visual

Record functional bugs (a click that does nothing, a disabled control that should be
live, a wrong value) AND visual/UX feedback (misaligned, clipped, low-contrast,
cramped). Attach the screenshot path as \`evidence\`. With no console/network to mine,
the a11y tree and what \`look\` reports back are your only signals — lean on both.
`;
