import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReplayError } from '../errors.js';
import type { ScreenshotFrame } from '../session/findings-store.js';
import {
  buildFfmpegArgs,
  createReplayStep,
  ffmpegOnPath,
  type RenderConfig,
  type ReplayFrame,
  renderReplay,
} from './replay.js';

const CFG: RenderConfig = {
  secondsPerFrame: 2,
  width: 1280,
  height: 720,
  fps: 30,
  crf: 23,
  fontFile: '/fonts/DejaVuSans.ttf',
};

/** Read the value that follows a flag in an arg list. */
function argValue(args: string[], flag: string): string {
  const i = args.indexOf(flag);
  return i === -1 ? '' : (args[i + 1] ?? '');
}

/** Pull the single `-filter_complex` value out of an arg list. */
function filterOf(args: string[]): string {
  const i = args.indexOf('-filter_complex');
  return args[i + 1] ?? '';
}

// --- buildFfmpegArgs ---------------------------------------------------------

test('buildFfmpegArgs loops each frame as a timed input, in order', () => {
  const frames: ReplayFrame[] = [
    { path: '/s/001-open.png', caption: 'open' },
    { path: '/s/002-click.png', caption: 'click' },
  ];
  const args = buildFfmpegArgs(frames, '/s/replay.mp4', CFG);
  expect(args).toContain('-loop');
  expect(args.join(' ')).toContain('-loop 1 -t 2 -i /s/001-open.png');
  expect(args.join(' ')).toContain('-loop 1 -t 2 -i /s/002-click.png');
  // input order preserved
  expect(args.indexOf('/s/001-open.png')).toBeLessThan(args.indexOf('/s/002-click.png'));
});

// The boss agent is expected to attach replay.mp4 to the PR it opens. GitHub only
// plays H.264/yuv420p MP4 inline, and only starts before full download when the
// moov atom leads — so these flags are the difference between usable evidence and
// a file nobody can watch. Leaving the codec to ffmpeg's container default made
// that silently dependent on the host build.
test('buildFfmpegArgs encodes H.264/yuv420p with faststart — playable inline on a GitHub PR', () => {
  const args = buildFfmpegArgs([{ path: '/a.png', caption: 'open' }], '/out.mp4', CFG);

  expect(argValue(args, '-c:v')).toBe('libx264');
  expect(argValue(args, '-pix_fmt')).toBe('yuv420p');
  expect(argValue(args, '-movflags')).toBe('+faststart');
});

// A replay is a slideshow of static UI frames whose entire value is the readable
// text burned into them; x264's default psychovisual tuning smooths exactly the
// sharp edges that text is made of.
test('buildFfmpegArgs tunes for still images at the configured crf, so captions stay legible', () => {
  const args = buildFfmpegArgs([{ path: '/a.png', caption: 'open' }], '/out.mp4', CFG);
  expect(argValue(args, '-tune')).toBe('stillimage');
  expect(argValue(args, '-crf')).toBe('23');

  const sharper = buildFfmpegArgs([{ path: '/a.png', caption: 'open' }], '/out.mp4', {
    ...CFG,
    crf: 18,
  });
  expect(argValue(sharper, '-crf')).toBe('18');
});

test('buildFfmpegArgs concats all frames and maps the output stream last', () => {
  const frames: ReplayFrame[] = [
    { path: '/a.png', caption: 'one' },
    { path: '/b.png', caption: 'two' },
    { path: '/c.png', caption: 'three' },
  ];
  const args = buildFfmpegArgs(frames, '/out.mp4', CFG);
  const filter = filterOf(args);
  expect(filter).toContain('[v0][v1][v2]concat=n=3:v=1:a=0[out]');
  expect(args).toContain('-pix_fmt');
  expect(args).toContain('yuv420p');
  expect(args.at(-1)).toBe('/out.mp4'); // output is the final positional arg
});

test('buildFfmpegArgs burns a drawtext caption per frame when a font is given', () => {
  const args = buildFfmpegArgs([{ path: '/a.png', caption: 'clicked login' }], '/out.mp4', CFG);
  const filter = filterOf(args);
  expect(filter).toContain('drawtext=fontfile=/fonts/DejaVuSans.ttf');
  expect(filter).toContain('text=clicked login');
});

test('buildFfmpegArgs sanitizes caption text to a filtergraph-safe charset', () => {
  const args = buildFfmpegArgs(
    [{ path: '/a.png', caption: "Clicking 'Add item': now!" }],
    '/o.mp4',
    CFG,
  );
  expect(filterOf(args)).toContain('text=clicking add item now');
});

test('buildFfmpegArgs omits drawtext entirely when no font is available', () => {
  const args = buildFfmpegArgs([{ path: '/a.png', caption: 'open' }], '/out.mp4', {
    ...CFG,
    fontFile: undefined,
  });
  expect(filterOf(args)).not.toContain('drawtext');
});

// --- renderReplay (over the exec seam) --------------------------------------

test('renderReplay returns null and never spawns ffmpeg when there are no frames', async () => {
  let called = false;
  const out = await renderReplay(
    async () => {
      called = true;
    },
    [],
    '/out.mp4',
    CFG,
  );
  expect(out).toBeNull();
  expect(called).toBe(false);
});

test('renderReplay encodes the built args and returns the output path', async () => {
  const frames: ReplayFrame[] = [{ path: '/a.png', caption: 'open' }];
  let received: readonly string[] = [];
  const out = await renderReplay(
    async (args) => {
      received = args;
    },
    frames,
    '/out.mp4',
    CFG,
  );
  expect(out).toBe('/out.mp4');
  expect(received).toEqual(buildFfmpegArgs(frames, '/out.mp4', CFG));
});

test('renderReplay threads the abort signal to the encoder (teardown kills ffmpeg)', async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  await renderReplay(
    async (_args, signal) => {
      received = signal;
    },
    [{ path: '/a.png', caption: 'open' }],
    '/out.mp4',
    CFG,
    controller.signal,
  );
  // Without this the encoder outlives the server: the session exits right after
  // teardown and a detached ffmpeg keeps running against a dead run's frames.
  expect(received).toBe(controller.signal);
});

test('renderReplay propagates an encoder failure (loud — the session decides to swallow it)', async () => {
  await expect(
    renderReplay(
      async () => {
        throw new ReplayError('ffmpeg exited 1');
      },
      [{ path: '/a.png', caption: 'open' }],
      '/out.mp4',
      CFG,
    ),
  ).rejects.toThrow(ReplayError);
});

// --- ffmpegOnPath (binary detection) ----------------------------------------

test('ffmpegOnPath resolves an existing absolute path and rejects a missing one', () => {
  expect(ffmpegOnPath(process.execPath)).toBe(true); // the running binary exists
  expect(ffmpegOnPath('/no/such/dir/ffmpeg')).toBe(false);
});

test('ffmpegOnPath finds a bare command on PATH and misses one that is absent', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ui-dbg-ffmpeg-'));
  const savedPath = process.env.PATH;
  try {
    writeFileSync(join(dir, 'ffmpeg'), '');
    process.env.PATH = dir;
    expect(ffmpegOnPath('ffmpeg')).toBe(true);
    expect(ffmpegOnPath('definitely-absent-binary')).toBe(false);
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- createReplayStep (graceful ffmpeg-absent handling) ---------------------

const FRAME: ScreenshotFrame = { seq: 1, path: '/s/001-open.png', label: 'open' };

test('createReplayStep skips silently when there are no frames (never probes ffmpeg)', async () => {
  const logs: string[] = [];
  let probed = false;
  const step = createReplayStep({
    screenshots: { listScreenshots: async () => [] },
    output: '/out.mp4',
    log: (line) => logs.push(line),
    hasFfmpeg: () => {
      probed = true;
      return true;
    },
  });
  expect(await step()).toEqual({ kind: 'skipped' });
  expect(logs).toEqual([]); // a no-frame skip is quiet
  expect(probed).toBe(false); // bails before the ffmpeg probe
});

test('createReplayStep skips with a note and logs loud when ffmpeg is absent', async () => {
  const logs: string[] = [];
  const step = createReplayStep({
    screenshots: { listScreenshots: async () => [FRAME] },
    output: '/out.mp4',
    log: (line) => logs.push(line),
    hasFfmpeg: () => false, // ffmpeg not installed — never spawns it
  });
  const outcome = await step();
  expect(outcome.kind).toBe('skipped');
  if (outcome.kind === 'skipped') {
    expect(outcome.note).toContain('ffmpeg not found');
    expect(outcome.note).toContain('install ffmpeg');
  }
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain('replay:'); // surfaced loud in agent.log
  expect(logs[0]).toContain('ffmpeg not found');
});
