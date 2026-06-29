import { expect, test } from 'bun:test';
import { ReplayError } from '../errors.js';
import { buildFfmpegArgs, type RenderConfig, type ReplayFrame, renderReplay } from './replay.js';

const CFG: RenderConfig = {
  secondsPerFrame: 2,
  width: 1280,
  height: 720,
  fps: 30,
  fontFile: '/fonts/DejaVuSans.ttf',
};

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
