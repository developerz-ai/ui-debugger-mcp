# Adapters & targets

The small agent must not care whether it's driving a web page, a desktop app, or
a mobile emulator. One **shared contract**; each adapter implements it.

## Targets (per project)

A big project like `tesote.ai` exposes several:

| Target  | Adapter            | Drives                         | Reads state |
|---------|--------------------|--------------------------------|-------------|
| web     | browser (CDP)      | a headless Chrome page         | DOM         |
| desktop | desktop (x11/wl)   | the desktop app window         | a11y tree / vision |
| mobile  | desktop (x11/wl)   | the mobile emulator window     | a11y tree / vision |

**Two adapters, three targets.** Mobile and desktop are both just windows on the
Linux desktop, so they share the desktop adapter. Only web is separate (CDP).

The story names the target: *"on **mobile**, log in and …"*.

## The shared contract (the one real seam)

Every adapter implements the same small interface so the agent loop is
adapter-blind:

| Op          | Web (CDP)                | Desktop / mobile (x11/wayland) |
|-------------|--------------------------|--------------------------------|
| `open`      | navigate to url          | launch / focus the app window  |
| `find`      | DOM selector             | a11y node, else vision match   |
| `click`     | CDP input                | synthesized pointer event      |
| `type`      | CDP input                | synthesized key event          |
| `readState` | DOM snapshot             | AT-SPI a11y tree, else OCR/vision |
| `screenshot`| CDP capture              | compositor screenshot          |
| `waitFor`   | DOM / network idle       | poll a11y / pixels             |

Web is precise (DOM). Desktop/mobile prefer the **accessibility tree**; when an
app exposes none, the adapter **falls back to vision** (screenshot + coordinates).

> Linux tooling per adapter (X11 vs Wayland input, screenshots, AT-SPI) is
> worked out in [`desktop-control.md`](desktop-control.md). Short version:
> a11y-tree-first everywhere it exists, vision as the universal fallback,
> X11/Xvfb container as the low-friction default and native Wayland as hard mode.

## Why this matters

- The smart agent writes one kind of story regardless of target.
- The small agent's loop is written once.
- Swapping `xdotool`→`ydotool`, or adding macOS later, is an adapter change only.

## Web specifics

- CDP via the persistent Chrome profile (login survives runs).
- Headless by default; headed when debugging the debugger.
- DOM + console + network come "for free" from CDP — richest signal of all targets.
