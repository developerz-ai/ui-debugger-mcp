/**
 * The managed emulator's command line.
 *
 * Split out from the adapter because it is the one part of managed boot that is
 * a pure decision: given an AVD, a console port and whether the run wants a
 * window, what argv does `emulator` need? The adapter keeps the spawning.
 *
 * Headless is the default for the same reason the browser adapter is headless
 * by default — a run is driven by an agent, not watched by a human, and the box
 * it runs on (CI, a container, a dev server over SSH) usually has no display at
 * all. `-no-window` alone is not enough there: the emulator still opens a host
 * GL context and dies, so software rendering has to come with it.
 */

/** Console port the emulator binds; its adb serial is `emulator-<port>`. */
export type LaunchSpec = {
  avd: string;
  port: number;
  /** Run windowless with software GL. Default true — see the module note. */
  headless: boolean;
  /** Appended verbatim, after everything above. Escape hatch for `-http-proxy` &c. */
  extraArgs?: readonly string[];
};

/**
 * `emulator` argv for a managed boot.
 *
 * The headless trio is not decoration:
 * - `-no-window` — no display to open one on.
 * - `-gpu swiftshader_indirect` — software GL; `auto` picks a host GL stack that
 *   a headless box does not have, and the emulator exits before boot.
 * - `-no-audio` — probing ALSA on a box with no sound device stalls the boot.
 *
 * `-no-boot-anim` is a free few seconds off every cold start and nothing renders
 * the animation anyway.
 */
export function emulatorLaunchArgs(spec: LaunchSpec): string[] {
  const args = [`@${spec.avd}`, '-port', String(spec.port)];
  if (spec.headless) {
    args.push('-no-window', '-gpu', 'swiftshader_indirect', '-no-audio', '-no-boot-anim');
  }
  if (spec.extraArgs) args.push(...spec.extraArgs);
  return args;
}
