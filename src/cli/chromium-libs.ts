/**
 * Chromium system-library pre-check — the gate `bin/setup` runs BEFORE its
 * launch verification.
 *
 * A headless Chromium that cannot resolve `libX.so` fails at launch with a
 * stack trace naming no library, so the failure surfaces deep inside
 * `bin/check` / `bun test` instead of at setup. This module resolves the
 * library question directly: it locates the pinned headless-shell binary in
 * the Playwright cache dir, runs `ldd` on it, and reports the libraries the
 * loader cannot find.
 *
 * Contract (the shape `bin/setup` depends on):
 *  - exit 0 — every shared library resolves.
 *  - exit 1 — libraries are missing and could not be installed. stderr
 *    carries a message STARTING WITH `X_CHROMIUM_LIBS_MISSING:` naming every
 *    missing library and the remediation command.
 *
 * Remediation runs only when the libraries are missing AND noninteractive
 * elevation is available: `node node_modules/playwright-core/cli.js install-deps
 * chromium` elevates through `sudo -- sh -c ...` and PROMPTS for a password
 * when sudo wants one, which would hang a CI/setup run forever. So the
 * elevation probe is `sudo -n true` (never a bare `sudo true`), and without it
 * the check fails with the diagnostic instead of attempting an install that
 * would block on a prompt.
 *
 * A failing install stays a failure. `install-deps` is allowed to fix the
 * machine; it is never allowed to make a broken machine look healthy.
 *
 * The module NEVER launches Chromium — the launch check stays `bin/setup`'s
 * own final gate.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ChromiumLibsMissingError } from '../errors.js';

/**
 * The repo-pinned Playwright CLI invocation that installs the Chromium system
 * dependencies. NEVER `bunx playwright` — that resolves an unpinned version.
 */
export const INSTALL_DEPS_COMMAND =
  'node node_modules/playwright-core/cli.js install-deps chromium';

/** Machine-readable marker every failure message starts with. */
export const MISSING_LIBS_MARKER = 'X_CHROMIUM_LIBS_MISSING:';

/**
 * Directory prefixes of the Playwright cache that hold the Chromium headless
 * shell. The revision suffix varies with the pinned playwright-core version,
 * so the dir name is matched by prefix and the revision read from the dir.
 */
const HEADLESS_SHELL_DIR_PREFIX = 'chromium_headless_shell-';

/**
 * Candidate file names of the headless shell, across the layouts Playwright
 * has shipped (linux-x64 `chrome-headless-shell`, linux-arm64 `headless_shell`).
 * The dir is SCANNED rather than hardcoded — a layout change must degrade to
 * "binary not found", never to "libX.so missing" (a wrong answer).
 */
const HEADLESS_SHELL_BINARIES = ['chrome-headless-shell', 'headless_shell'];

/** Subdirectories (relative to the cache dir) the headless shell may live in. */
const HEADLESS_SHELL_SUBDIRS = ['chrome-headless-shell-linux64', 'chrome-linux', 'chrome-linux64'];

/**
 * Parse the shared libraries `ldd` could not resolve.
 *
 * `ldd` prints one line per dependency and reports an unresolved one as
 * `libX.so => not found`. The library name is the text LEFT of the `=>` — the
 * right side is the (absent) resolved path.
 *
 * @param lddOutput combined stdout/stderr of an `ldd` run.
 * @returns the missing library names, de-duplicated, in first-seen order.
 */
export function parseMissingLibs(lddOutput: string): string[] {
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of lddOutput.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const arrow = line.indexOf('=>');
    if (arrow < 0) continue;
    if (
      !line
        .slice(arrow + 2)
        .trim()
        .startsWith('not found')
    )
      continue;
    const name = line.slice(0, arrow).trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    missing.push(name);
  }
  return missing;
}

/**
 * The diagnostic for missing libraries. Starts with {@link MISSING_LIBS_MARKER}
 * (the marker CI greps for) and names every missing library plus the command
 * that installs them.
 */
export function formatMissingLibsMessage(
  missing: string[],
  installCommand: string = INSTALL_DEPS_COMMAND,
): string {
  const libs = missing.length > 0 ? missing.join(', ') : '(none listed)';
  return (
    `${MISSING_LIBS_MARKER} ${missing.length} shared librar${missing.length === 1 ? 'y' : 'ies'} ` +
    `missing for the Chromium headless shell: ${libs}. ` +
    `Fix with: ${installCommand}`
  );
}

/** What the check may do about the missing libraries. */
export type RemediationPlan =
  | { kind: 'none' }
  | { kind: 'install-deps'; command: string }
  | { kind: 'blocked'; message: string };

/**
 * Decide how to remediate the missing libraries.
 *
 * `none` — nothing is missing, so nothing is attempted.
 * `install-deps` — libraries are missing and noninteractive elevation exists,
 * so the pinned install-deps command may run.
 * `blocked` — libraries are missing but elevation is unavailable; the message
 * is the diagnostic to report. The install is NOT attempted (it would prompt).
 */
export function remediationPlan(
  missing: string[],
  elevated: boolean,
  installCommand: string = INSTALL_DEPS_COMMAND,
): RemediationPlan {
  if (missing.length === 0) return { kind: 'none' };
  if (!elevated) {
    return { kind: 'blocked', message: formatMissingLibsMessage(missing, installCommand) };
  }
  return { kind: 'install-deps', command: installCommand };
}

/** Seam: run `ldd` on a binary; returns combined stdout+stderr. */
export type LddRunner = (binary: string) => string;

/** Seam: is noninteractive elevation available? */
export type ElevationProbe = () => boolean;

/** Seam: run the remediation command; throws on failure. */
export type Installer = (command: string) => void;

/** Seam: locate the headless shell binary; `null` when absent. */
export type BinaryLocator = (cacheDir: string) => string | null;

/**
 * The revision number of a `chromium_headless_shell-<rev>` dir name, or -1
 * when the suffix is not numeric.
 */
function shellRevision(dirName: string): number {
  const suffix = dirName.slice(HEADLESS_SHELL_DIR_PREFIX.length);
  const rev = Number.parseInt(suffix, 10);
  return Number.isNaN(rev) ? -1 : rev;
}

/**
 * Locate the pinned Chromium headless-shell binary inside the Playwright
 * cache dir. Scans the dir for the `chromium_headless_shell-<rev>` folder and
 * the known executable names/subpaths inside it — the layout moves between
 * playwright-core versions, so it is discovered, never hardcoded.
 */
export function locateHeadlessShell(cacheDir: string): string | null {
  if (!existsSync(cacheDir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(cacheDir);
  } catch {
    return null;
  }
  const shellDirs = entries
    .filter((name) => name.startsWith(HEADLESS_SHELL_DIR_PREFIX))
    // Highest revision first: the suffix is numeric, and a lexical sort would
    // put "9999" before "1228" (the pinned revision is the older one here).
    .sort((a, b) => shellRevision(b) - shellRevision(a));
  for (const dir of shellDirs) {
    const base = join(cacheDir, dir);
    for (const sub of HEADLESS_SHELL_SUBDIRS) {
      for (const bin of HEADLESS_SHELL_BINARIES) {
        const candidate = join(base, sub, bin);
        if (existsSync(candidate)) return candidate;
      }
    }
    // Fall back to a shallow scan of the shell dir itself: a layout that
    // changed in an unforeseen way still resolves rather than reporting a
    // missing binary.
    for (const bin of HEADLESS_SHELL_BINARIES) {
      const candidate = join(base, bin);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/**
 * The captured output of a failed `execFileSync` run. `execFileSync` throws on
 * a non-zero exit and puts the piped stdout/stderr on the error object.
 */
type ExecFailure = { stdout?: unknown; stderr?: unknown };

/** The stdout/stderr of a failed exec run, as strings (empty when absent). */
function capturedOutput(err: unknown): { stdout: string; stderr: string } {
  if (typeof err !== 'object' || err === null) return { stdout: '', stderr: '' };
  const failure = err as ExecFailure;
  return {
    stdout: typeof failure.stdout === 'string' ? failure.stdout : '',
    stderr: typeof failure.stderr === 'string' ? failure.stderr : '',
  };
}

/**
 * Default `ldd` runner: the real thing, combined stdout+stderr.
 *
 * `ldd` exits NON-ZERO precisely when a shared library is missing — the exact
 * case this module exists to detect — so `execFileSync` throws and the output
 * is trapped inside the thrown error. Letting that throw escape would abort
 * the check BEFORE `parseMissingLibs` ever ran: the raw `Command failed: ldd
 * …` text would reach stderr, naming no library and no fix, and the
 * remediation path would never be reached.
 *
 * So the non-zero exit is treated as DATA, not as an error: the captured
 * stdout+stderr is returned for parsing. The library listing (`libX.so => not
 * found`) is printed on stdout even when `ldd` exits non-zero, and the
 * diagnostics land on stderr — hence both streams, combined.
 */
export const runLdd: LddRunner = (binary) => {
  try {
    return execFileSync('ldd', [binary], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const { stdout, stderr } = capturedOutput(err);
    const combined = `${stdout}${stderr}`;
    // `ldd` failed without producing a library listing at all (e.g. "not a
    // dynamic executable", or `ldd` missing from PATH). The check cannot
    // conclude anything from that, so it fails LOUD — reporting "every
    // library resolves" off a run that never resolved one would be a false
    // healthy. A listing that DOES contain `=>` lines is a real answer and is
    // handed to the parser, missing libraries included.
    if (!combined.includes('=>')) {
      throw new ChromiumLibsMissingError(
        `${MISSING_LIBS_MARKER} \`ldd\` could not resolve the shared libraries of ` +
          `${binary}: ${combined.trim() || 'no output'}. ` +
          `Fix with: ${INSTALL_DEPS_COMMAND}`,
      );
    }
    return combined;
  }
};

/**
 * Default elevation probe: `sudo -n true` — the noninteractive form, which
 * fails instead of prompting when a password is required. uid 0 counts as
 * elevated (no sudo needed at all).
 */
export const probeElevation: ElevationProbe = () => {
  if (typeof process.getuid === 'function' && process.getuid() === 0) return true;
  try {
    execFileSync('sudo', ['-n', 'true'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Default installer: run the command verbatim, throwing when it fails. */
export const runInstaller: Installer = (command) => {
  // The command is a fixed, repo-owned string — not user input — so it is
  // split on whitespace rather than run through a shell.
  const [bin, ...args] = command.split(' ');
  if (!bin) throw new ChromiumLibsMissingError(`${MISSING_LIBS_MARKER} empty install command`);
  execFileSync(bin, args, { stdio: 'inherit' });
};

/** The injectable seams of {@link checkChromiumLibs}. */
export type ChromiumLibsDeps = {
  locateBinary?: BinaryLocator;
  ldd?: LddRunner;
  probeElevation?: ElevationProbe;
  install?: Installer;
};

/** Outcome of a successful check. */
export type ChromiumLibsOk = { ok: true; binary: string; missing: string[] };

/**
 * Check the pinned Chromium headless shell's shared libraries.
 *
 * Throws {@link ChromiumLibsMissingError} when libraries are missing and could
 * not be installed (no elevation, or the install failed).
 */
export function checkChromiumLibs(cacheDir: string, deps: ChromiumLibsDeps = {}): ChromiumLibsOk {
  const locate = deps.locateBinary ?? locateHeadlessShell;
  const ldd = deps.ldd ?? runLdd;
  const probe = deps.probeElevation ?? probeElevation;
  const install = deps.install ?? runInstaller;

  const binary = locate(cacheDir);
  if (!binary) {
    throw new ChromiumLibsMissingError(
      `${MISSING_LIBS_MARKER} Chromium headless shell not found under ${cacheDir}. ` +
        `Install it with: node node_modules/playwright-core/cli.js install chromium`,
    );
  }

  const missing = parseMissingLibs(ldd(binary));
  // Nothing missing => nothing attempted. The elevation probe is skipped too:
  // it shells out to `sudo`, and a healthy machine must not pay for it.
  if (missing.length === 0) return { ok: true, binary, missing };

  const plan = remediationPlan(missing, probe());
  if (plan.kind === 'none') return { ok: true, binary, missing };

  if (plan.kind === 'blocked') {
    throw new ChromiumLibsMissingError(plan.message);
  }

  // Libraries are missing and elevation is available: install them. A FAILING
  // install stays a failure — the error names the failed command, so the
  // operator sees which remediation broke rather than a bare non-zero exit.
  try {
    install(plan.command);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ChromiumLibsMissingError(
      `${MISSING_LIBS_MARKER} remediation failed: \`${plan.command}\` — ${detail}. ` +
        `Resolve the missing libraries manually, then re-run.`,
    );
  }

  // The install claims success — verify, never trust. A still-missing library
  // must not be reported as healthy.
  const stillMissing = parseMissingLibs(ldd(binary));
  if (stillMissing.length > 0) {
    throw new ChromiumLibsMissingError(formatMissingLibsMessage(stillMissing));
  }
  return { ok: true, binary, missing };
}

/**
 * CLI entry: `bun src/cli/chromium-libs.ts <cacheDir>`.
 *
 * Exit 0 — every shared library resolves. Exit 1 — the diagnostic on stderr.
 */
export function runCli(argv: string[] = process.argv.slice(2)): number {
  const cacheDir = argv[0];
  if (!cacheDir) {
    console.error(`${MISSING_LIBS_MARKER} usage: chromium-libs <playwright-cache-dir>`);
    return 1;
  }
  try {
    const result = checkChromiumLibs(cacheDir);
    console.log(`chromium libraries OK (${result.binary})`);
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (import.meta.main) {
  process.exit(runCli());
}
