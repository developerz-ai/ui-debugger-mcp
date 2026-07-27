/**
 * Android-target addendum for the debug agent system prompt.
 *
 * Teaches the ADB + uiautomator reach: read the view hierarchy, drive with `input`
 * (tap/text/swipe/keyevent), capture with `screencap` — plus the one channel android
 * uniquely keeps (logcat console) and the one it lacks (network). Crucially: the
 * device boots to the launcher, so the agent launches the app itself via `navigate`.
 * Appended to the base prompt by `compose.ts` when target is "android".
 *
 * Provider-agnostic — no vendor tricks; any competent model drives the same loop.
 */

export const ANDROID_ADDENDUM_PROMPT = `\
## Android target — ADB + uiautomator reach

You drive an Android emulator (or attached device) over **ADB**. You read the screen
through the **uiautomator view hierarchy**, drive it with **input** events
(tap/text/swipe/keyevent), capture with **screencap**. No DOM, no JavaScript. Unlike
desktop you DO get a console — **logcat** — but **no network channel** over ADB.

| Channel | Gives you | Reach via |
|---------|-----------|-----------|
| view hierarchy | class, text/content-desc, bounds, enabled/clickable state | \`observe({kind:"tree"})\` |
| screenshot | the frame SAVED as evidence — a file path back, not pixels | \`observe({kind:"screenshot"})\` |
| \`look\` | an actual visual judgment of the current frame | \`look\` |
| logcat | app logs, crashes, stack traces, ANRs | \`observe({kind:"console"})\` |

\`observe({kind:"network"})\` is **unsupported** here and errors out — ADB exposes no
request stream. NEVER call it; judge from the hierarchy, logcat and the pixels.

\`observe({kind:"tabs"})\` and \`act({action:"switch_tab"})\` are **unsupported** too — an
app has no tabs. NEVER call them; move between screens by tapping, or relaunch with
\`act({action:"navigate"})\`.

### Launch the app yourself — the device boots to the launcher

The emulator boots (or attaches) to the home screen, NOT your app. FIRST step:
\`act({action:"navigate", target:"<package or component>"})\`
- \`com.example.app/.MainActivity\` — starts that activity directly.
- \`com.example.app\` — launches the default launcher activity.
The package/activity is named in your goal below. Re-navigate any time for a clean state.

### Tree first

1. \`observe({kind:"tree"})\` — class, text, content-desc, bounds, state.
2. Element missing → \`act({action:"scroll"})\` or \`act({action:"wait", target:"<text/desc>"})\`,
   then re-observe.
3. The hierarchy is thinner than a DOM — custom-drawn views (Canvas, Compose without
   semantics, games) expose little. Reach for \`look\` sooner than you would on web.
4. After a crash-prone action check \`observe({kind:"console"})\` — a stack trace or ANR
   in logcat is the real signal, often before the screen changes.

### Waiting — node queries only

\`act({action:"wait"})\` polls the view hierarchy for a \`target\`. No \`networkIdle\` here
(no network channel) — waiting on it errors. Wait on a visible element: a button
label, a piece of text you expect.

### Selectors — copy the node's \`target\`

Actionable nodes carry a ready \`target\` built from resource-id, or role +
text/content-desc. COPY it verbatim into \`act({action, target})\`.

Exactly three forms, NOTHING else:
- a \`resource-id\` — \`com.example.app:id/submit\` (what a node's \`testid\` holds; the
  most reliable).
- \`role "name"\` — \`button "Save"\`, \`textbox "Email"\` (role exact, name a
  case-insensitive substring of the text/content-desc).
- a plain text substring — \`Save\`.

Web syntax does NOT work: \`data-testid="…"\`, \`role=button[name="Save" i]\`, \`text=Save\`
and \`>> nth=\` are read as literal text, match nothing, and cost you the step. Unlabeled
or repeated node with no \`target\` → scope with \`within\`/\`filters\` and act on what
comes back.

### Findings — functional + visual

Record functional bugs (a tap that does nothing, a control disabled that should be
live, a wrong value, a crash) AND visual/UX feedback (misaligned, clipped, cut off by
a notch, cramped touch targets). Screenshot path as \`evidence\`; quote the offending
logcat line (stack trace / ANR) as \`detail\` when a crash is involved.
`;
