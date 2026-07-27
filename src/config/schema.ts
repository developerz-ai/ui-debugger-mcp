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

/**
 * One named login persona — how to sign into THIS app as THIS user.
 *
 * The recipe lives in config, not in every `start_debug` goal string: almost
 * every interesting screen is behind a login, so re-teaching the flow in prose
 * per run burned driver steps before the real goal started and put credentials
 * into a free-text field that gets logged. `start_debug({as:"admin"})` names one
 * instead; the run signs in out-of-band before the driver's first step and the
 * values never enter the model's context (see `docs/idea/config.md`).
 */
const AuthPersonaSchema = z.strictObject({
  /** Login page — a path resolved against the target url (`/login`) or an absolute URL. */
  path: z.string().min(1),
  /**
   * Field hint → value. The KEY locates the control (`name`/`id`/`type`/
   * `data-testid`/`aria-label`/`placeholder`, in that order, or a selector when it
   * looks like one); the VALUE is typed into it and is redacted everywhere it
   * would otherwise be written down.
   */
  fields: z.record(z.string().min(1), z.string()).refine((f) => Object.keys(f).length > 0, {
    message: 'needs at least one field to type',
  }),
  /** The control that submits the form — a button/link label, or a selector. */
  submit: z.string().min(1),
  /**
   * Proof the login WORKED — a selector/text that only exists once signed in.
   * Omit and the run instead requires that submitting left `path`; an app that
   * signs in without navigating must set this, or the login reads as a failure.
   */
  expect: z.string().min(1).optional(),
});

/** Web target — CDP-driven browser. Managed (default) unless `cdpUrl` attaches. */
export const WebTargetSchema = z.strictObject({
  adapter: z.literal('browser'),
  url: z.url().optional(), // optional: the caller ("boss") can supply it per-run via start_debug
  headless: z.boolean().default(true), // docs/idea/config.md promises headless by default
  debugLogin: DebugLoginSchema.optional(),
  auth: z.record(z.string().min(1), AuthPersonaSchema).optional(), // personas, keyed by `as`
  executablePath: z.string().nullish(), // null = auto-detect Chrome/Chromium (managed)
  // Persistent profile dir, resolved against the workspace root (absolute path used
  // as-is); unset = `chrome-user-data/`. Managed mode only — attach keeps its own.
  profile: z.string().min(1).optional(),
  cdpUrl: z.url().nullish(), // set → attach over CDP, server does NOT start/stop it
});

/**
 * Which window to drive once the app is up. Matched by WM properties
 * (X11: xdotool `--name`/`--class`; AT-SPI: application name). Omit a field to
 * leave it unconstrained; omit the whole object only when `open` is given the
 * window title itself — with neither, `open` fails loud instead of driving nothing.
 */
const WindowMatchSchema = z.strictObject({
  title: z.string().optional(), // WM_NAME / title substring, literal (regex chars escaped)
  class: z.string().optional(), // WM_CLASS, literal (regex chars escaped)
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

/**
 * Android target — ADB adapter. Managed (boot `emulator @avd`) unless `adbSerial` attaches.
 *
 * `avd`/`emulatorPath` are **managed-only** — attach binds straight to the serial and
 * never reads them, so a physical device is just `{ adapter, adbSerial }` instead of a
 * made-up AVD name. The constraint is stated where it is real: managed requires `avd`.
 */
export const AndroidTargetSchema = z
  .strictObject({
    adapter: z.literal('android'),
    avd: z.string().optional(), // required in managed mode (see the refinement below)
    emulatorPath: z.string().nullish(), // null = auto-detect from SDK (managed)
    adbSerial: z.string().nullish(), // set → attach to a running device, no start/stop
  })
  .superRefine((target, ctx) => {
    if (target.adbSerial == null && target.avd === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['avd'],
        message: '`avd` is required in managed mode (set `adbSerial` to attach instead)',
      });
    }
  });

/** A single target, discriminated on `adapter`. All three adapters (browser, desktop, android) are operational. */
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
export type AuthPersona = z.infer<typeof AuthPersonaSchema>;
export type WebTarget = z.infer<typeof WebTargetSchema>;
export type DesktopTarget = z.infer<typeof DesktopTargetSchema>;
export type AndroidTarget = z.infer<typeof AndroidTargetSchema>;
export type Target = z.infer<typeof TargetSchema>;
export type Config = z.infer<typeof ConfigSchema>;
