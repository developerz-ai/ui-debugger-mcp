# 05 — Desktop adapter

> Part of [`overview.md`](overview.md). Depends on: none.

## Files to change
- `src/adapters/desktop/desktop-adapter.ts:111-131` — launched process exit code never checked (`stdio:'ignore'`); bad `launch` command surfaces as "window not found within 10000ms" at best; with empty-title fallback + no `window` config, `open` can succeed having launched nothing.
- `src/adapters/desktop/desktop-adapter.ts:148-153` + `atspi.ts:440-447` — AT-SPI nodes lacking `Component` get silent `{0,0,0,0}` bounds → `click`/`type` land at screen origin with no error (browser fails loud on the same class).
- `src/adapters/desktop/proc.ts:42-47` — no `timeout` on `execFile`: hung `busctl` (unresponsive AT-SPI peer), `xdotool --sync`, or `scrot` blocks the operation until the outer session timeout.
- `src/adapters/desktop/desktop-adapter.ts:195-204` — each `waitFor` poll re-walks the full spawn-heavy AT-SPI tree (~4 busctl procs/node × up to 200 nodes / 200 ms).
- `src/adapters/desktop/capture.ts:26-30` + `input.ts` vs `docs/idea/adapters.md:13,37` + CLAUDE.md — Wayland oversold: input is xdotool-only (needs XWayland), capture wlroots-`grim` only (GNOME/KDE portal routes of `desktop-control.md:69-80` absent), "falls back to vision" for empty a11y trees unimplemented. **Decision (per overview): downgrade docs, don't implement.**
- Low: `desktop-adapter.ts:122-126` — daemonizing `launch` (`app &`) orphans the app (`close()` no-op). Document foreground requirement in config docs + schema comment.

## Steps
1. Record child exit code in the exit handler (like android's `#emulatorDown` latch); `open` fails loud with that code when the child died before the window appeared.
2. Throw `AdapterError` in `click`/`type` when resolved node w/h is 0 (same rule as slice 01 step 7 — keep messages consistent).
3. `proc.ts` exec wrapper: per-invocation `timeout` + `killSignal`, expiry → `AdapterError`. Defaults: 10 s busctl/xdotool, 30 s scrot.
4. `waitFor`: pass a scoped/`maxNodes`-bounded query to the polling `find` (target's role/name only), or lengthen interval to 500 ms — measure which is simpler.
5. Docs honesty: `docs/idea/adapters.md`, `docs/idea/desktop-control.md`, CLAUDE.md target table → "desktop: X11/Xvfb (Wayland: wlroots capture only; native Wayland input not yet)". Add foreground-`launch` note to `docs/idea/config.md`.

## Tests
- `open` with a `launch` command that exits 1 → loud failure naming the exit code.
- Zero-bounds node click/type throws.
- exec timeout expiry → `AdapterError` (fake slow binary via `sleep`).
- Gap-fill: `Xdotool` runner error paths beyond `activateWindow`; `Screenshot.capture` temp-file flow incl. cleanup-on-failure; desktop `close` killing a live process group.
- Run: `bun test src/adapters/desktop`, full suite.

## Done when
- A wrong `launch` command fails in seconds with the real reason, not a window-timeout.
- No desktop exec can hang past its own timeout.
- Docs claim exactly what ships for Wayland.
