# Adapters & targets

The small agent must not care whether it's driving a web page, a desktop app, or
a mobile emulator. One **shared contract**; each adapter implements it.

## Targets (per project)

A big project can expose several:

| Target  | Adapter            | Protocol / drives              | Reads state  |
|---------|--------------------|--------------------------------|--------------|
| web     | browser            | CDP — a Chrome page            | DOM          |
| desktop | desktop (x11/wl)   | the desktop app window         | a11y tree    |
| mobile  | android            | ADB — uiautomator + screencap | view hierarchy |

**Three adapters, three targets.** Each target speaks its own real protocol:
web = CDP, desktop = X11/Wayland input, mobile = ADB. They share one contract
(below), not one implementation. iOS is out of scope on Linux.

Each adapter also runs **managed or attach**: launch+own the target, or attach
to an already-running one (`cdpUrl` for web, `adbSerial` for android) and never
touch its lifecycle. See per-adapter sections + [`config.md`](config.md).

The story names the target: *"on **mobile**, log in and …"*.

## The shared contract (the one real seam)

Every adapter implements the same small interface so the agent loop is
adapter-blind:

| Op          | Web (CDP)                      | Desktop (X11/XWayland)              | Mobile (ADB)                                        |
|-------------|--------------------------------|-------------------------------------|-----------------------------------------------------|
| `selectorDialect` | `"web"` — Playwright engines | `"native"` — role "name" / bare name | `"native"` — role "name" / bare name or resource-id |
| `open`      | navigate to url                | launch / focus the window           | boot (managed) + launch activity / app              |
| `find`      | DOM selector                   | a11y node                           | uiautomator node                                    |
| `click`     | CDP input                      | synthesized pointer event           | `input tap`                                         |
| `type`      | CDP input                      | synthesized key event               | `input text`                                        |
| `pressKey`  | CDP input                      | synthesized key event               | `input keyevent`                                    |
| `scroll`    | mouse wheel                    | wheel, optionally inside a region   | `input swipe`                                       |
| `readState` | DOM snapshot                   | AT-SPI a11y tree                    | uiautomator dump                                    |
| `screenshot`| CDP capture                    | X11/Xvfb or grim (Wayland)          | `screencap`                                         |
| `waitFor`   | DOM / network idle             | poll a11y (networkIdle unsupported) | poll hierarchy (networkIdle unsupported)            |
| `console`   | CDP capture                    | unsupported — fails loud            | logcat tail                                         |
| `network`   | CDP exchanges (bodies/headers) | unsupported — fails loud            | unsupported over ADB — fails loud                   |
| `close`     | managed: stop Chrome · attach: disconnect | managed: stop the launched app · else no-op | managed: kill our emulator · attach: disconnect |
| `tabs` — optional (web) | list open tabs | — | — |
| `selectTab` — optional (web) | drive another tab | — | — |
| `takeUnrequestedLoads` — optional (web) | drained surprise full-document loads | — | — |

Web is precise (DOM). Desktop reads the **accessibility tree**; mobile the
**view hierarchy**. There is **no automatic vision/OCR fallback** — the adapter
never switches to pixels. A custom-drawn surface (canvas, game, custom widget)
exposes no nodes at all, so the adapter finds nothing there; Chromium/Electron
need `--force-renderer-accessibility`, Qt needs its bridge. The only vision
today is the agent-level `look`: the driver captures a frame and hands it to
the vision model for a visual judgment.

> Linux tooling per adapter (X11 vs Wayland capture, screenshots, AT-SPI) is
> worked out in [`desktop-control.md`](desktop-control.md). Short version:
> a11y-tree-first everywhere it exists, no automatic vision/OCR fallback, the
> adapter never switches to pixels, X11/Xvfb container as the low-friction
> default. Wayland capture via `grim` (wlroots) is supported; native-Wayland
> input via libei/ydotool is future work.

## Why this matters

- The smart agent writes one kind of story regardless of target.
- The small agent's loop is written once.
- Swapping `xdotool`→`ydotool`, or adding macOS later, is an adapter change only.

## Web specifics

- CDP via the persistent Chrome profile (login survives runs).
- Headless by default; headed when debugging the debugger.
- DOM + console + network come "for free" from CDP — richest signal of all targets.

### Session lifecycle: managed vs attach (web)

The browser adapter runs Chrome one of two ways:

- **Managed (default)** — the server launches Chrome with the per-project
  persistent profile and **owns start/stop**. `executablePath` picks the binary
  (else auto-detect).
- **Attach** — if a **`cdpUrl`** is configured, the adapter connects to an
  already-running browser over CDP and **never starts/stops it** (not its
  process). Teardown disconnects without closing its context. For
  live/staging/containerised or remote Chrome.

Attach adopts the **first tab in the first available browser context**, creating
a context or tab only if missing. This is **not active-tab or URL-based
selection**. `start_debug` navigates that tab to the effective target URL (the
per-run `url` override, otherwise the configured target URL). When `as` selects a
configured persona, the same tab then navigates to the persona's login URL,
resolved against the run URL, and the login flow enters and submits its configured
fields before the agent starts.

**Lifecycle non-ownership does not preserve tab contents or browser state.**
Navigation replaces the adopted tab's contents; login and agent actions can change
cookies, storage, and other session state. Use a **dedicated browser for attach
runs**, not a browser holding unrelated work or personal sessions.

`cdpUrl` set → attach. Unset → managed. See [`config.md`](config.md).

## Mobile / Android specifics

Android is controlled over a real protocol — **ADB (Android Debug Bridge)** — so
the same managed/attach split applies:

- **Protocol**: ADB. `uiautomator dump` → view hierarchy (structured tree),
  `input tap/swipe/text` → actions, `screencap` → screenshots. Appium's
  UiAutomator2 driver sits on top for richer queries. The emulator adds a
  **console / gRPC** for launch + sensors.
- **Managed (default)** — server boots an emulator (`emulator @avd -port <p>`, optional
  `emulatorPath`) and owns its lifecycle. The port is picked free from 5554–5584, so the
  emulator answers as `emulator-<p>` and **every call is bound to that serial**
  (`adb -s`) — a co-running emulator is never driven, and never killed on `close`.
- **Attach** — if an **`adbSerial`** (device/emulator id, e.g. `emulator-5554`
  or a network `host:port`) is configured, the adapter talks to that already-running
  device over ADB and **does not start/stop it**. For a physical phone or a
  shared emulator.
- **Canvas / Compose surfaces** expose no view hierarchy, so they are simply
  absent from the tree — no automatic vision/OCR fallback. The only vision is
  the agent-level `look`.
- iOS stays out of scope on Linux (XCUITest is macOS-only) — see
  [`desktop-control.md`](desktop-control.md).
