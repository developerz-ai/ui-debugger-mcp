/**
 * Zod schema for `.ui-debugger-mcp.json` — the committed, per-project debug config.
 * Mirrors `.ui-debugger-mcp.example.json`. Validated at the config boundary; bad
 * config fails fast and loud (see `ConfigError`).
 */

import { z } from 'zod';

/** Per-role model strings (OpenAI-compatible router; defaults: deepseek text, glm image). */
export const ModelsSchema = z.strictObject({
  driver: z.string(), // fast guy — controls the target (blind, text)
  vision: z.string(), // vision guy — describes screenshots, judges looks
  summary: z.string().optional(), // optional — compress findings for the smart agent
});

/** Login bypass escape hatch — skips captcha only, not auth. */
const DebugLoginSchema = z.strictObject({
  param: z.string(), // query param name, e.g. "debug-ai" → `?debug-ai=true`
});

/** Web target — CDP-driven browser. Managed (default) unless `cdpUrl` attaches. */
export const WebTargetSchema = z.strictObject({
  adapter: z.literal('browser'),
  url: z.url().optional(), // optional: the caller ("boss") can supply it per-run via start_debug
  headless: z.boolean(),
  debugLogin: DebugLoginSchema.optional(),
  executablePath: z.string().nullish(), // null = auto-detect Chrome/Chromium (managed)
  profile: z.string().optional(), // persistent profile dir under the workspace (managed)
  cdpUrl: z.url().nullish(), // set → attach over CDP, server does NOT start/stop it
});

/**
 * Which window to drive once the app is up. Matched by WM properties
 * (X11: xdotool `--name`/`--class`; AT-SPI: application name). Omit a field to
 * leave it unconstrained; omit the whole object only when `open` is given the
 * window title itself — with neither, `open` fails loud instead of driving nothing.
 */
const WindowMatchSchema = z.strictObject({
  title: z.string().optional(), // WM_NAME / title substring
  class: z.string().optional(), // WM_CLASS
});

/**
 * Desktop target — X11/Xvfb + Wayland adapter. Managed launch.
 *
 * **Launch must stay foreground** (no daemonization via `detached:true`, `&`, `nohup`).
 * The adapter spawns the command and latches its exit code to detect launch failures.
 * Daemonized apps orphan the process group → `close()` can't kill them and the
 * profile lock persists.
 */
export const DesktopTargetSchema = z.strictObject({
  adapter: z.literal('desktop'),
  launch: z.string(), // command that starts the app (managed, must stay foreground)
  window: WindowMatchSchema.optional(), // which window to drive; omit → `open` must supply a title
  display: z.string().nullish(), // X11 DISPLAY, e.g. ":99" for Xvfb; null = inherit env
});

/** Android target — ADB adapter. Managed (boot `emulator @avd`) unless `adbSerial` attaches. */
export const AndroidTargetSchema = z.strictObject({
  adapter: z.literal('android'),
  avd: z.string(),
  emulatorPath: z.string().nullish(), // null = auto-detect from SDK (managed)
  adbSerial: z.string().nullish(), // set → attach to a running device, no start/stop
});

/** A single target, discriminated on `adapter`. Browser now; desktop/android reserved. */
export const TargetSchema = z.discriminatedUnion('adapter', [
  WebTargetSchema,
  DesktopTargetSchema,
  AndroidTargetSchema,
]);

/** Top-level `.ui-debugger-mcp.json` shape. Targets keyed by name (web, desktop, mobile, …). */
export const ConfigSchema = z.strictObject({
  models: ModelsSchema.partial().optional(),
  workspace: z.string().optional(),
  targets: z.record(z.string(), TargetSchema),
});

export type Models = z.infer<typeof ModelsSchema>;
export type WebTarget = z.infer<typeof WebTargetSchema>;
export type DesktopTarget = z.infer<typeof DesktopTargetSchema>;
export type AndroidTarget = z.infer<typeof AndroidTargetSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type Config = z.infer<typeof ConfigSchema>;
