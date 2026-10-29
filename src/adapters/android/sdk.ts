/**
 * Where the managed emulator binary comes from — the pure decision, split from
 * the adapter like its siblings (`ports.ts`, `launch.ts`).
 *
 * `emulatorPath: null` means "auto-detect from the SDK" (`config/schema.ts`).
 * The old fallback (`?? 'emulator'`) spawned a bare `emulator` and leaned on
 * PATH alone — a normal Android Studio install (macOS, Windows) never puts the
 * emulator on PATH, so a perfectly bootable SDK went unnoticed and managed
 * boot failed. Resolution order, first hit wins:
 *
 *   1. a configured `emulatorPath` — used verbatim, zero env/fs access;
 *   2. the SDK layouts: `$ANDROID_HOME/emulator/`, `$ANDROID_SDK_ROOT/emulator/`,
 *      `~/Android/Sdk/emulator/` (Linux), `~/Library/Android/sdk/emulator/` (macOS);
 *   3. a bare `emulator` on PATH — the old behaviour, kept as the last resort.
 *
 * An auto-detected hit is accepted only if it is an **executable file**: a
 * non-executable candidate (a data file, a directory, a stub without +x)
 * falls through to the next source instead of masking a runnable one behind
 * it — existence alone would let `/a/emulator` shadow `/b/emulator`.
 *
 * A miss is a **result**, not a throw: `origin: 'missing'` plus every searched
 * location, so the caller fails loud with where it looked. Env values and PATH
 * entries are trimmed; an empty one counts as unset.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** Where a resolved emulator binary came from. */
export type EmulatorOrigin = 'config' | 'sdk' | 'path' | 'missing';

/** One resolution outcome: the binary to spawn and its provenance. */
export interface EmulatorBin {
  /** Path to spawn. `''` when `origin` is `missing` — there is nothing to spawn. */
  bin: string;
  origin: EmulatorOrigin;
  /**
   * Provenance of `bin`: the source that produced it (`'$ANDROID_HOME'`,
   * `'~/Android/Sdk'`, `'PATH'`, …), `'configured emulatorPath'` or `'not found'`.
   */
  where: string;
  /** Candidate labels probed before giving up — set only on `missing`. */
  searched?: readonly string[];
}

/**
 * Host state the resolution reads, named so tests can inject all of it — no
 * test (or future caller) ever needs a real `process.env` or filesystem.
 */
export interface EmulatorSeams {
  env: Readonly<Record<string, string | undefined>>;
  /**
   * Eligibility of an auto-detected candidate: a regular file this process may
   * execute. Existence alone is not enough — an ineligible first hit must fall
   * through, or it masks the runnable candidate behind it.
   */
  isExecutableFile: (path: string) => boolean;
  home: string;
  platform: NodeJS.Platform;
}

/** The real seams: the process environment, the real filesystem, this host. */
export function realEmulatorSeams(): EmulatorSeams {
  return {
    env: process.env,
    isExecutableFile: (path) => {
      try {
        // A directory passes `X_OK` (search permission), so the file check
        // comes first; `statSync` follows symlinks, which is what we want.
        if (!statSync(path).isFile()) return false;
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    },
    home: homedir(),
    platform: process.platform,
  };
}

/**
 * Resolve the emulator binary for a managed boot. Never throws: a miss comes
 * back as `origin: 'missing'` with the searched locations attached.
 *
 * A configured `emulatorPath` (trimmed non-empty) wins verbatim — it is never
 * normalized or probed, so a typo'd path fails loud at spawn instead of being
 * silently replaced by a detected binary.
 */
export function resolveEmulatorBin(
  explicit: string | null | undefined,
  seams: EmulatorSeams = realEmulatorSeams(),
): EmulatorBin {
  if (explicit !== null && explicit !== undefined && explicit.trim() !== '') {
    return { bin: explicit, origin: 'config', where: 'configured emulatorPath' };
  }
  return detectEmulatorBin(seams);
}

/** Env-only detection: SDK layouts first, then PATH, then a `missing` result. */
function detectEmulatorBin(seams: EmulatorSeams): EmulatorBin {
  const isWin = seams.platform === 'win32';
  const binName = isWin ? 'emulator.exe' : 'emulator';
  const paths = isWin ? win32 : posix;
  const searched: string[] = [];

  // SDK layouts, in check order — the labels are what `missing` reports. The
  // env bases ARE the SDK roots; the home bases grow the layout subpath.
  const linuxSdk = seams.home === '' ? undefined : paths.join(seams.home, 'Android', 'Sdk');
  const macSdk =
    seams.home === '' ? undefined : paths.join(seams.home, 'Library', 'Android', 'sdk');
  const sdkCandidates: ReadonlyArray<readonly [label: string, base: string | undefined]> = [
    ['$ANDROID_HOME', seams.env.ANDROID_HOME],
    ['$ANDROID_SDK_ROOT', seams.env.ANDROID_SDK_ROOT],
    ['~/Android/Sdk', linuxSdk],
    ['~/Library/Android/sdk', macSdk],
  ];
  for (const [label, base] of sdkCandidates) {
    searched.push(`${label}/emulator/${binName}`);
    const dir = base?.trim();
    if (dir === undefined || dir === '') continue;
    const bin = paths.join(dir, 'emulator', binName);
    if (seams.isExecutableFile(bin)) {
      return { bin, origin: 'sdk', where: label };
    }
  }

  // PATH fallback — the old `?? 'emulator'` behaviour, now a reported origin.
  const rawPath = seams.env.PATH;
  if (rawPath !== undefined && rawPath.trim() !== '') {
    for (const entry of rawPath.split(isWin ? ';' : ':')) {
      const dir = entry.trim();
      if (dir === '') continue;
      const bin = paths.join(dir, binName);
      // The probed path itself is the label — `missing` reports every sweep.
      searched.push(bin);
      // Not executable → skipped, and a later PATH entry can still win.
      if (seams.isExecutableFile(bin)) {
        return { bin, origin: 'path', where: 'PATH' };
      }
    }
  }

  return { bin: '', origin: 'missing', where: 'not found', searched };
}
