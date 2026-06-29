# Desktop control — Linux tooling (research)

How to actually drive desktop + mobile + web on Linux, and what comparable AI
agents use. Decides the adapter internals. Linux-first, X11 + Wayland.

## The core asymmetry

Web and mobile hand you a **structured element tree for free**. The Linux
desktop does **not**.

| Target  | Free structured tree? | From |
|---------|-----------------------|------|
| web     | yes — DOM + a11y       | CDP  |
| mobile  | yes — view hierarchy   | ADB / uiautomator |
| desktop | **uneven** — AT-SPI2 when present, else nothing | D-Bus |

So: **a11y-tree-first everywhere it exists, vision (screenshot + coordinates) as
the universal fallback.** That's the whole strategy.

## What other AI agents use

Almost all frontier desktop agents are **pure pixel + coordinates** on **X11**
(or Xvfb in a container):

- **Anthropic Computer Use** — `xdotool` + `scrot` on **Xvfb**, X11 only, no a11y.
- **OpenAI Operator / CUA** — model emits `click(x,y)`; harness executes (cloud browser VM).
- **UI-TARS, Agent-S2, self-operating-computer, Open Interpreter** — PyAutoGUI (X11), vision.
- **OSWorld** (benchmark) — pyautogui/xdotool in Ubuntu VMs; optional AT-SPI2.
- **Cua (trycua)** — closest reference for us: a11y-tree inspection **+** X11 **and** preview Wayland, runs in VM/container without stealing focus. Study before building.

Takeaway: the easy, proven path is **X11 / Xvfb in a container**. Native Wayland is the hard mode — reserve it for driving the user's real session.

## Why Wayland breaks classic automation

X11 (1984): any client can read any window's pixels, list windows, and inject
input via **XTEST**. Wayland: the **compositor is the sole authority**, clients
are isolated — no reading other windows, no injecting input, no global window
list **by default**. Everything routes through the compositor + **portals**.
This is the "Wayland fragmentation" — no universal tool can exist; capability is
compositor-specific.

## Input

| Tool | X11 | Wayland | Notes |
|------|-----|---------|-------|
| **xdotool** | ✅ | ❌ | input + windows + geometry, all-in-one. The X11 default. |
| **libei + RemoteDesktop portal** | — | ✅ GNOME≥46, KDE≥6.1 (not wlroots) | the *blessed* XTEST replacement, consent-gated. Future-proof. |
| **ydotool / dotool** | ✅ | ✅ any compositor | via `/dev/uinput`. **Window-blind** — needs coords. Needs `input` group + udev rule. |
| **wtype / virtual-keyboard** | ❌ | wlroots only | **refused by GNOME & KDE.** Don't rely on it. |
| **kdotool** (KWin) / **wlrctl** (wlroots) | — | compositor-specific | window mgmt only. No portable Wayland window API exists. |

## Reading desktop state — AT-SPI2

The Linux a11y tree over **D-Bus** (`org.a11y.atspi`). **Display-agnostic** —
same on X11 and Wayland (the one Wayland-robust piece).

- Nodes: role, name, states; `Component.GetExtents(SCREEN)` → screen `(x,y,w,h)`
  for set-of-marks overlays + click mapping.
- Actions via `Action` / `Text` / `Value` interfaces.
- Binding: **`from gi.repository import Atspi`** (GI), not legacy `pyatspi`.
  **Accerciser** to inspect coverage.
- **Gaps (why vision is still needed):** Qt needs its bridge; **Chromium/Electron
  need `--force-renderer-accessibility`**; canvas/games/custom-drawn expose nothing.
- Vision fallback: **OmniParser**-style detector + OCR → set-of-marks.

## Screenshots on Wayland

Naive X11 capture (`scrot`, `mss`, `pyautogui.screenshot()`) returns **BLACK** on
Wayland. No universal API. Detect compositor and dispatch:

| Route | Works on |
|-------|----------|
| **grim** | wlroots (Sway/Hyprland) only |
| `org.gnome.Shell.Screenshot` (D-Bus) | GNOME |
| `org.kde.KWin.ScreenShot2` (D-Bus) | KDE |
| **xdg-desktop-portal** Screenshot / ScreenCast (+ **PipeWire**) | **all DEs** — the portable route |

**Agent gotcha:** the portal **prompts** and needs a surface to anchor the dialog
→ headless agents fail the first time. Plan a one-time interactive grant, then
rely on persisted permission (KDE Plasma 2025 supports it).

## Mobile

Android is **fully framework-driven on Linux** — no vision required:

- **ADB + uiautomator** — `uiautomator dump` → hierarchy XML; `input tap/swipe`; `screencap`.
- **Appium UiAutomator2** — richer, XPath, runs on Linux via ADB.
- **scrcpy** — mirror + control; window-driving / vision fallback only (no tree).
- **iOS = out of scope on Linux** (XCUITest/WDA is macOS-only). Gate behind an optional remote-macOS adapter.

## Web

Cleanest target. **CDP** gives DOM + a11y tree + console + network + screenshots.
Lift **playwright-mcp**'s design: a11y-snapshot-first, stable refs, vision optional.

## Recommendation for our adapters

- **Web adapter** — Playwright + CDP, a11y-first. Build this first.
- **Mobile adapter** — Android via ADB/uiautomator (structured). scrcpy for fallback. iOS out of scope on Linux.
- **Desktop adapter — compositor-aware:**
  - **Read state:** AT-SPI2 (`Atspi` GI), `GetExtents(SCREEN)`. `--force-renderer-accessibility` for Chromium/Electron. Vision SoM (OmniParser-style) when the tree is empty.
  - **Input:** X11/XWayland → `xdotool`. Wayland future-proof → libei + portal (GNOME/KDE). Wayland lowest-common-denominator → `ydotool`/`dotool` via uinput, driven by AT-SPI coords.
  - **Screenshots:** detect compositor → grim / GNOME-DBus / KDE-DBus / portal+PipeWire.
  - **Window mgmt:** xdotool (X11), kdotool (KWin), wlrctl (wlroots).
- **Default execution env:** ship an **X11 / Xvfb container** as the low-friction default (what Anthropic/OpenAI/OSWorld all do). Native-Wayland path only when driving the user's real session.

## Wayland gotchas to bake in

1. X11 screenshot libs return black → use grim / D-Bus / portal per compositor.
2. Portal screenshots prompt + need a surface → one-time grant, then persisted.
3. No global input injection by default → libei+portal or uinput; wtype refused by GNOME/KDE.
4. uinput is window-blind → pair with AT-SPI screen coords; needs `/dev/uinput` perms.
5. No universal window API → compositor-specific (kdotool / wlrctl).
6. Xvfb/X11 container sidesteps all of it when policy allows.
