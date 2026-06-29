/**
 * `replay` — stitch a run's ordered screenshots into a short captioned `replay.mp4`.
 *
 * The session keeps every screenshot ordered on disk (`screenshots/NNN-<label>.png`).
 * At the end of a run this service turns them into one scannable video — PR evidence
 * a reviewer (human or agent) watches in ~10s instead of pulling the branch and
 * clicking through (see `idea/workspace.md`). Each frame holds for a beat with its
 * step label burned in as a caption, so the clip narrates itself.
 *
 * The ffmpeg invocation hides behind a small {@link ReplayEncoder} exec seam, so the
 * arg-building ({@link buildFfmpegArgs}) is a pure function the tests assert against
 * with no subprocess — the same shape as `summarize`'s model seam and `look`'s vision
 * seam. {@link createReplayStep} binds the real `spawn('ffmpeg', …)` plus a resolved
 * caption font into the {@link ReplayStep} the session runs once the verdict settles.
 *
 * ffmpeg is optional tooling, so {@link createReplayStep} probes for the binary
 * ({@link ffmpegOnPath}) BEFORE stitching: absent, it skips cleanly with a note the
 * session folds into the findings and a loud line in `agent.log` — never a crash.
 * When ffmpeg IS present this layer fails loud — a non-zero exit throws a
 * {@link ReplayError} — and the session decides to swallow it. The session wraps the
 * whole step fail-soft (a missing ffmpeg or font must never block teardown). When no
 * caption font is installed the stitch still runs, just without burned-in captions.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { ReplayError } from '../errors.js';
import type { ScreenshotFrame } from '../session/findings-store.js';
import type { ReplayOutcome, ReplayStep } from '../session/session.js';

/** One frame to stitch: the PNG path plus the caption burned onto it. */
export interface ReplayFrame {
  /** Absolute path to the source PNG. */
  path: string;
  /** Short human caption (the step label). */
  caption: string;
}

/** Resolved stitch tunables `buildFfmpegArgs` reads (no defaults — fully specified). */
export interface RenderConfig {
  /** Seconds each frame holds on screen. */
  secondsPerFrame: number;
  /** Canvas the frames are scaled+padded into (even px). */
  width: number;
  /** Canvas height (even px). */
  height: number;
  /** Output frame rate. */
  fps: number;
  /** TrueType font for burned-in captions; omit to stitch without captions. */
  fontFile?: string;
}

/**
 * The exec seam {@link renderReplay} drives — runs ffmpeg with the built args,
 * resolving on success and throwing on failure. {@link createReplayStep} binds it to
 * a real `spawn`; tests pass a fake that records the args.
 */
export type ReplayEncoder = (args: readonly string[]) => Promise<void>;

/** Stitch defaults — 2s/frame at 720p30 makes a calm, scannable clip. */
const DEFAULTS = { secondsPerFrame: 2, width: 1280, height: 720, fps: 30 } as const;

/** Common installed font paths probed for burned-in captions (Linux + macOS). */
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
  '/System/Library/Fonts/Supplemental/Arial.ttf',
  '/Library/Fonts/Arial.ttf',
] as const;

/**
 * Constrain a caption to `[a-z0-9 ]` so it drops cleanly into the ffmpeg filtergraph
 * (no `:`, `,`, `\`, `'` or `%` to escape). Labels already arrive de-slugged; this
 * just guards. Empties fall back to `step`.
 */
function sanitizeCaption(caption: string): string {
  const clean = caption
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean || 'step';
}

/** One `drawtext` filter that burns `caption` into a centred bottom bar. */
function drawtext(caption: string, fontFile: string): string {
  return [
    `drawtext=fontfile=${fontFile}`,
    `text=${sanitizeCaption(caption)}`,
    'fontcolor=white',
    'fontsize=28',
    'box=1',
    'boxcolor=black@0.5',
    'boxborderw=12',
    'x=(w-text_w)/2',
    'y=h-th-32',
  ].join(':');
}

/**
 * Build the full ffmpeg arg list for the stitch — pure and deterministic, so the
 * tests assert it directly. Each PNG becomes a looped, time-limited input; every
 * input is scaled into a uniform letterboxed canvas (so differing screenshot sizes
 * never break the concat), optionally captioned, then concatenated into one stream.
 */
export function buildFfmpegArgs(
  frames: readonly ReplayFrame[],
  output: string,
  cfg: RenderConfig,
): string[] {
  const { secondsPerFrame, width, height, fps, fontFile } = cfg;
  const inputs: string[] = [];
  const chains: string[] = [];
  frames.forEach((frame, i) => {
    inputs.push('-loop', '1', '-t', String(secondsPerFrame), '-i', frame.path);
    const steps = [
      `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
      'setsar=1',
    ];
    if (fontFile !== undefined) steps.push(drawtext(frame.caption, fontFile));
    chains.push(`[${i}:v]${steps.join(',')}[v${i}]`);
  });
  const concatInputs = frames.map((_, i) => `[v${i}]`).join('');
  const filter = `${chains.join(';')};${concatInputs}concat=n=${frames.length}:v=1:a=0[out]`;
  return [
    '-y',
    ...inputs,
    '-filter_complex',
    filter,
    '-map',
    '[out]',
    '-r',
    String(fps),
    '-pix_fmt',
    'yuv420p',
    output,
  ];
}

/**
 * Stitch `frames` into `output` over the {@link ReplayEncoder} seam. Returns the
 * output path on success, or `null` when there are no frames (nothing to stitch).
 * Pure over the seam, so it unit-tests against a fake with no subprocess.
 * @throws {ReplayError} propagated from the encoder when ffmpeg fails.
 */
export async function renderReplay(
  encode: ReplayEncoder,
  frames: readonly ReplayFrame[],
  output: string,
  cfg: RenderConfig,
): Promise<string | null> {
  if (frames.length === 0) return null;
  await encode(buildFfmpegArgs(frames, output, cfg));
  return output;
}

/** First installed caption font, or `undefined` when none is found (→ stitch without captions). */
export function resolveFontFile(): string | undefined {
  return FONT_CANDIDATES.find((path) => existsSync(path));
}

/**
 * True when the ffmpeg binary is resolvable: a path-like `bin` (absolute or relative)
 * is checked directly; a bare command is searched across `PATH`. Pure and synchronous
 * (no subprocess), so {@link createReplayStep} can probe before stitching and skip
 * cleanly when ffmpeg is absent — never spawning a process that won't exist.
 */
export function ffmpegOnPath(bin: string): boolean {
  if (bin.includes('/')) return existsSync(bin);
  const dirs = (process.env.PATH ?? '').split(delimiter).filter((dir) => dir.length > 0);
  return dirs.some((dir) => existsSync(join(dir, bin)));
}

/** The real encoder: spawn ffmpeg, resolve on exit 0, throw {@link ReplayError} otherwise. */
function spawnFfmpeg(bin: string): ReplayEncoder {
  return (args) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on('error', (err) =>
        reject(new ReplayError(`ffmpeg ('${bin}') failed to launch: ${err.message}`)),
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else
          reject(new ReplayError(`ffmpeg exited ${code ?? 'null'}: ${stderr.trim().slice(-400)}`));
      });
    });
}

/** What {@link createReplayStep} needs to stitch one session's replay. */
export interface ReplayStepDeps {
  /** Lists the run's ordered screenshot frames (the `FindingsStore` satisfies this). */
  screenshots: { listScreenshots(): Promise<ScreenshotFrame[]> };
  /** Absolute path to write the stitched video (`sessionPaths.replayMp4`). */
  output: string;
  /** ffmpeg binary; defaults to `ffmpeg` (resolved on PATH). */
  ffmpegBin?: string;
  /** Override stitch tunables (frame duration, canvas, fps). */
  render?: Partial<Omit<RenderConfig, 'fontFile'>>;
  /** Loud breadcrumb sink (`agent.log`); defaults to a no-op. Surfaces an absent ffmpeg. */
  log?: (line: string) => void;
  /** Probe whether ffmpeg is installed; defaults to {@link ffmpegOnPath}. A seam for tests. */
  hasFfmpeg?: (bin: string) => boolean;
}

/**
 * Bind {@link renderReplay} to the real ffmpeg spawn + a resolved caption font,
 * yielding the {@link ReplayStep} the session runs after the verdict settles. The
 * session stays tool- and path-blind; everything ffmpeg-shaped lives here.
 *
 * Probes for ffmpeg first (graceful when it is not installed): no frames → a silent
 * skip; ffmpeg absent → a skip carrying a `note` the session records in the findings,
 * plus a loud line in `agent.log` so the missing `replay.mp4` is never a mystery; a
 * stitched clip → its path for `findings.evidence`.
 */
export function createReplayStep(deps: ReplayStepDeps): ReplayStep {
  const bin = deps.ffmpegBin ?? 'ffmpeg';
  const log = deps.log ?? (() => undefined);
  const hasFfmpeg = deps.hasFfmpeg ?? ffmpegOnPath;
  const encode = spawnFfmpeg(bin);
  const cfg: RenderConfig = {
    secondsPerFrame: deps.render?.secondsPerFrame ?? DEFAULTS.secondsPerFrame,
    width: deps.render?.width ?? DEFAULTS.width,
    height: deps.render?.height ?? DEFAULTS.height,
    fps: deps.render?.fps ?? DEFAULTS.fps,
    fontFile: resolveFontFile(),
  };
  return async (): Promise<ReplayOutcome> => {
    const frames = await deps.screenshots.listScreenshots();
    if (frames.length === 0) return { kind: 'skipped' }; // nothing to stitch
    if (!hasFfmpeg(bin)) {
      const note = `ffmpeg not found ('${bin}'); replay.mp4 was not generated — install ffmpeg to enable replay video`;
      log(`replay: ${note}`);
      return { kind: 'skipped', note };
    }
    const replayFrames = frames.map((f) => ({ path: f.path, caption: f.label }));
    const path = await renderReplay(encode, replayFrames, deps.output, cfg);
    return path === null ? { kind: 'skipped' } : { kind: 'rendered', path };
  };
}
