# Per-project workspace

Each project gets its own space — the debug agent's memory and evidence locker
for that app. Keyed by the current dir.

```
./tmp/ui-debugger-mcp/<project>/
├── chrome-user-data/          persistent browser profile
│                              (login, cookies, localStorage, prefs)
├── sessions/2026-07-27_14-30-05-0001/     ← id IS the local timestamp
│   ├── story.md               the goal the smart agent gave
│   ├── screenshots/           ordered frames: NNN-step.png (+ per target)
│   ├── replay.mp4             frames stitched into a captioned video (PR evidence)
│   ├── captions.vtt           subtitle per frame (planned; v1 burns captions in)
│   ├── findings.json          structured report back to the smart agent
│   └── logs/
│       ├── console.log        browser / app console (web) + logcat rows (android, when the console is observed)
│       ├── network.log        requests, responses, failures, timings (web targets only)
│       └── agent.log          small agent's step-by-step trail
├── owner.lock                 exclusive ownership claim (one live owner)
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
| `sessions/<id>/logs/console.log` | JS errors a code-only agent can't see — and, on a mobile run, the app's logcat rows (crashes, stack traces). **Web AND android targets**: the run's capture sink is handed to the browser adapter (CDP console) and to the android adapter (`src/adapters/factory.ts`). The web half is PUSH-based — the page's console streams as it happens; the android half is READ-driven — `AndroidAdapter.console()` streams the logcat rows it parses (`src/adapters/android/android-adapter.ts:433`) — so a mobile run writes this file only when the driver observes the console. A desktop run has no `console.log`. |
| `sessions/<id>/logs/network.log` | The 500s / hangs / bad payloads behind a broken UI. Same sink, still web-only reach — ADB has no network channel, so a mobile run writes no `network.log`. |
| `sessions/<id>/logs/agent.log`   | Why the small agent decided pass/fail. Auditable. Written for every target — the run-start breadcrumb alone lands here (`src/services/session-builder.ts`). |
| `owner.lock`        | The **exclusive ownership lock** — the authoritative one-run gate. A kernel-held `flock(2)` (`LOCK_EX \| LOCK_NB`) taken by `FileStatePort.record` before any breadcrumb is published: the kernel grants it to exactly one process and refuses every rival, so a live foreign owner's start fails with `SessionBusyError` (naming the holder from the claim written on the file), and a crashed owner's lock dies with its process — the workspace is simply free, with nothing to reclaim. The claim file is a notice board, not the lock: never unlinked (unlinking would swap the inode under a live lock), emptied on release, and litter from older protocols (`.reclaiming-*`, `owner.lock.reclaim`) is inert. Exclusion is non-revocable — no recovery logic can restore one owner over another, because there is no recovery. |
| `state.json`        | Resume / inspect the cwd-keyed session. |

The logs live **per session**, under `sessions/<id>/logs/` — there is no
project-level `logs/` directory. Path of record:
`src/session/workspace.ts` `sessionPaths().logs` (`src/session/workspace.ts:150`)
→ `src/session/findings-store.ts` `appendLog`, which writes
`<channel>.log` into that dir (`src/session/findings-store.ts:127-130`, channels
`console` / `network` / `agent` at `src/session/findings-store.ts:25`) → the
writers in `src/services/session-builder.ts`: the capture sink
(`createCaptureSink` there) and the agent sink. Which files exist depends on the
target — see the table above.

The session's capture sink is the **single** writer of `console.log` and
`network.log`: it redacts the line FIRST, then appends it. Every captured row
travels that one redacting path — the browser's CDP capture and the android
logcat drain alike — because no adapter writes to disk and no adapter is given
a sink of its own. Redaction covers the run's AUTH PERSONA values, in their
plain, percent-encoded, `+`-for-space and JSON-escaped spellings — and only
those: an android run has no persona, so its redactor is the identity. A
credential that is NOT one of those values (a token the app logged itself)
still reaches `logs/console.log` exactly as it was captured.

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

## Session ids are timestamps

`YYYY-MM-DD_HH-MM-SS-NNNN` in **local** time (`2026-07-27_14-30-05-0001`). The
counter suffix keeps two runs in the same second apart.

Two properties, both load-bearing:
- **Human-readable** — `ls sessions/` tells you when each run happened. The old
  epoch-ms ids (`1784985071909-0001`) needed a converter.
- **Fixed-width** — byte order == chronological order, which is exactly what
  retention sorts by. No `stat` per directory, no race with a live run.

## Retention: the newest 5

Every run leaves `story.md`, `findings.json`, its `logs/` trail, every
screenshot and a `replay.mp4`. Nothing used to remove them, so the workspace only
grew — an afternoon of dogfooding is hundreds of megabytes.

A starting run prunes as part of its own setup: the **5 newest** session dirs
survive (this run included), the rest are removed. It runs before the browser
launches, and fails loud (`WorkspaceError`) rather than quietly accumulating.
`chrome-user-data/` is never touched — the login survives forever.

## Multiple projects at once

Two editor windows, two Claude Codes, two apps: each MCP server runs in its own
project's cwd, and **everything that could collide is keyed by that cwd** — the
workspace root, the Chrome profile, `sessions/`, `state.json`, the session
registry, and the retention prune. Two checkouts with the same basename stay
apart because the default workspace is anchored under each project; a shared
absolute `workspace` gets a cwd-hash suffix on the project dir for the same
reason. Pinned by `src/session/isolation.test.ts`.

## Rules

- **One session at a time** per project — the gate is the workspace's exclusive
  ownership lock (`owner.lock`), a kernel-held `flock(2)` taken before the run
  is recorded: exactly one live owner per workspace, across processes, with no
  Chrome involved, and no reclaim/recovery step that could ever admit a second
  owner. The persistent profile still locks itself, but it is not the gate.
  Parallel runs *within one project* would need a cloned profile; out of scope.
  Different projects run in parallel freely (see above).
- Lives under `./tmp/` so it never pollutes the repo (gitignore `tmp/`).
- Findings reference evidence by path, so the smart agent can open a screenshot
  or grep a log without the server inlining huge blobs into context.

## Lifecycle

- New story → new `sessions/<timestamp>/`; the 6th-oldest and beyond are pruned.
- Profile (`chrome-user-data/`) persists across sessions.
