# 01 — Android security + robustness

> Part of [`overview.md`](overview.md). Depends on: none. **Highest priority.**

## Files to change
- `src/adapters/android/commands.ts:62-70` — `escapeInputText` misses `\n`/`\r`/`\t`; adb joins shell argv into one device-shell string → `type(target, "hi\nrm -rf /sdcard")` executes on-device. **HIGH, injection.**
- `src/adapters/android/commands.ts:38-47` — `startArgs` interpolates agent-controlled `open` target verbatim (`am start -W -n <t>`); `com.app/.Main; <cmd>` runs `<cmd>`. **MED, injection.**
- `src/adapters/android/android-adapter.ts:191,313,366-381` — managed mode uses bare `-e`, never bound to the emulator it spawned: pre-existing emulator satisfies boot wait, run drives it, `close` runs `adb -e emu kill` on a target we never started; two emulators → every call ambiguous. **HIGH, managed-vs-attach violation.**
- `src/adapters/android/android-adapter.ts:372` — `#awaitDevice` swallows all `get-state` failures via `.catch(() => '')` incl. missing adb binary → 120 s spin then misleading "no device appeared".
- `src/adapters/android/adb.ts:60-80` — no `timeout` on `execFile`; wedged `adb shell` (uiautomator is notorious) blocks forever.
- `src/adapters/android/uiautomator.ts:339-343` — `uiautomator dump` can fail with exit 0, leaving stale `/sdcard/window_dump.xml` → silently parses old hierarchy as current UI.
- `src/adapters/android/android-adapter.ts:225-230` — zero-bounds nodes (`[0,0][0,0]` invisible) click at (0,0) silently; browser adapter fails loud on the same class.
- Lows (same files): `uiautomator.ts:289-291` `toNode` drops `resourceId` (map to `testid`); `commands.ts:66` add `?[]` to escape set; `commands.ts:176-184` map `F1`–`F12` to `KEYCODE_F<n>`; `uiautomator.ts:121-128` decode numeric XML entities (`&#10;`); `android-adapter.ts:331-345` null `#emulator` in exit/error handlers so retry `open` can respawn; `android-adapter.ts:384-388` invalidate `#screen` cache per scroll (rotation).

## Steps
1. `escapeInputText`: reject/strip all chars < 0x20 (translate `\n` → follow-up `KEYCODE_ENTER` press if cheap, else throw `AdapterError`); add `?[]` to escape set.
2. `startArgs`: validate target against `^[\w.]+(/[\w.$]+)?$`, throw `AdapterError` on mismatch.
3. Managed serial binding: spawn emulator with a fixed `-port <p>` (pick free even port 5554–5584), serial = `emulator-<p>`; build `AdbCli(['-s', serial])` for managed exactly like attach uses `adbSerial`. `close` kills only that serial.
4. `#awaitDevice`: only treat "no device"/"offline" states as keep-waiting; rethrow ENOENT-flavoured `AdbError` immediately.
5. `AdbCli`: per-invocation `timeout` (+`killSignal`) on `execFile`, expiry → `AdbError`. Sensible defaults: 30 s shell, 120 s where callers wait for boot.
6. `dump()`: `rm -f /sdcard/window_dump.xml` first; after dump verify file exists (or check success line), else throw `AdapterError` — never parse stale.
7. `click`/`type`: throw `AdapterError` when resolved node width/height is 0.
8. Lows from list above — each is a 1-5 line fix.

## Tests
- New: control chars in `type` text (assert rejected/translated, never in argv); hostile `startArgs` target throws; managed `open` binds `-s emulator-<port>` (assert argv) and attach `open` never spawns; stale-dump path (dump cmd "succeeds", file missing → throw); zero-bounds click throws; `keycodeFor('F5')`; `toNode` maps resourceId→testid; numeric entity decode.
- New: `AdbCli` unit tests (ENOENT wrap, timeout expiry, buffer-mode `execOut`) — currently zero.
- Run: `bun test src/adapters/android`, then full `bun test` + `typecheck` + `lint`.

## Done when
- No agent-controlled string can reach the device shell unvalidated.
- Managed mode provably targets only its own emulator (argv-asserted); attach provably never spawns/kills.
- Wedged adb call fails within its timeout as `AdbError`, not a hang.
