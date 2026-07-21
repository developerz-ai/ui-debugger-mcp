# Per-project workspace

Each project gets its own space — the debug agent's memory and evidence locker
for that app. Keyed by the current dir.

```
./tmp/ui-debugger-mcp/<project>/
├── chrome-user-data/          persistent browser profile
│                              (login, cookies, localStorage, prefs)
├── sessions/<id>/
│   ├── story.md               the goal the smart agent gave
│   ├── screenshots/           ordered frames: NNN-step.png (+ per target)
│   ├── replay.mp4             frames stitched into a captioned video (PR evidence)
│   ├── captions.vtt           subtitle per frame (planned; v1 burns captions in)
│   ├── findings.json          structured report back to the smart agent
│   └── logs/
│       ├── console.log        browser / app console
│       ├── network.log        requests, responses, failures, timings
│       └── agent.log          small agent's step-by-step trail
└── state.json                 session state, keyed by cwd
```

## Why each piece

| Path                | Why |
|---------------------|-----|
| `chrome-user-data/` | Login survives runs. No re-auth each time. Works with `?debug-ai`. **Managed mode only** — in attach mode (`cdpUrl`) the browser keeps its own profile. |
| `story.md`          | What was asked. Becomes the integration-test spec later. |
| `screenshots/`      | Ordered frames — evidence for visual feedback, and the raw material for the replay video. |
| `replay.mp4`        | The run as a short captioned video — drop it in the PR (see below). |
| `captions.vtt`      | One subtitle per frame (planned sidecar; v1 burns captions into `replay.mp4`). |
| `findings.json`     | The structured verdict. Smart agent reads this, not prose. |
| `console.log`       | JS errors a code-only agent can't see. |
| `network.log`       | The 500s / hangs / bad payloads behind a broken UI. |
| `agent.log`         | Why the small agent decided pass/fail. Auditable. |
| `state.json`        | Resume / inspect the cwd-keyed session. |

## PR replay video

The screenshots aren't throwaway — they're **kept and ordered** (`NNN-step.png`),
and at the end of a run the session stitches them into a short **captioned
video**.

- **Frames** = the session's screenshots, in order (one per meaningful step:
  navigate, click, the broken state, the fixed state).
- **Subtitles** = a few words per frame, **present-continuous action + the real
  element label**: "filling signup", "clicking 'Add item'", "submitting form",
  "❌ total overlaps the button", "✅ centred after fix". Captions come from the
  agent's step trail (`agent.log` — each `act` knows the target's text/label) +
  visual notes from `look`. Short, human, scannable.
- **Output** = `replay.mp4` (ffmpeg-style stitch; subtitles burned in or sidecar).

### What v1 ships

`src/services/replay.ts` (driven by `Session` once the verdict settles):

- **Frames** — `FindingsStore.listScreenshots()` returns the `NNN-<label>.png`
  frames ordered by sequence (the capture order).
- **Captions** — the step label **de-slugged from each filename** (`001-clicked-
  login.png` → "clicked login"), burned into a bottom caption bar via ffmpeg
  `drawtext`. Sourcing richer captions from `agent.log` / `look` notes is future
  work. If no caption font is installed the clip still stitches, sans captions.
- **Stitch** — ffmpeg runs behind an exec seam (so the arg-building is pure and
  tested); each frame is letterboxed onto a uniform canvas and concatenated.
- **Output** — `replay.mp4` at the session root; its path is written into
  `findings.evidence` so the smart agent can attach it to the PR.
- **Best-effort** — no frames, a missing `ffmpeg`, or any stitch failure is
  swallowed: the replay never blocks teardown or overturns the verdict.

### Why — the PR drops the video

When the loop ends and the smart agent opens the PR, it attaches `replay.mp4`.
A reviewer (human or agent) watches the flow in ~10 seconds — *this is what the
change does, here's it working* — instead of pulling the branch and clicking
through. The evidence the human used to gather by hand is now a captioned clip,
generated for free from a run that already happened.

## Rules

- **One session at a time** per project — the persistent profile locks itself.
  Parallel runs would need a cloned profile; out of scope for now.
- Lives under `./tmp/` so it never pollutes the repo (gitignore `tmp/`).
- Findings reference evidence by path, so the smart agent can open a screenshot
  or grep a log without the server inlining huge blobs into context.

## Lifecycle

- New story → new `sessions/<id>/`.
- Profile (`chrome-user-data/`) persists across sessions.
- Old sessions can be pruned; the profile stays.
