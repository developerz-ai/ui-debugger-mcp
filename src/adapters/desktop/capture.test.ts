import { expect, test } from 'bun:test';
import { access, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AdapterError, ExecTimeoutError } from '../../errors.js';
import { type CaptureTool, captureArgs, chooseCaptureTool, Screenshot } from './capture.js';
import { desktopEnv, type Exec } from './proc.js';

// Set only capture-related environment keys; never depend on the host session.
async function withEnv(env: NodeJS.ProcessEnv, run: () => void | Promise<void>) {
  const keys = [
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XDG_CURRENT_DESKTOP',
    'XDG_SESSION_DESKTOP',
    'DESKTOP_SESSION',
  ];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    await run();
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
}

const mixed = { DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' };
const png = Uint8Array.from([137, 80, 78, 71]);

async function exists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

function fakeCapture(action: (cmd: string, file: string) => Promise<void>) {
  const calls: { cmd: string; file: string; deadline: number | undefined }[] = [];
  const exec: Exec = async (cmd, args, opts) => {
    const file = args.at(-1);
    if (!file) throw new AdapterError('test capture output file missing');
    expect(args).toEqual(captureArgs(cmd as CaptureTool, file));
    calls.push({ cmd, file, deadline: opts?.deadline });
    await action(cmd, file);
    return '';
  };
  return { calls, exec };
}

async function expectClean(calls: { file: string }[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const { file } of calls) {
    expect(await exists(file)).toBe(false);
    expect(await exists(dirname(file))).toBe(false);
  }
}

test('picker tries X11 first, Wayland only when X11 is absent', () => {
  expect(chooseCaptureTool(mixed)).toBe('scrot');
  expect(chooseCaptureTool({ DISPLAY: ':99' })).toBe('scrot');
  expect(chooseCaptureTool({ WAYLAND_DISPLAY: 'wayland-0' })).toBe('grim');
  expect(() => chooseCaptureTool({})).toThrow(AdapterError);
});

test('captureArgs writes PNG per backend and rejects unknown tools', () => {
  expect(captureArgs('grim', '/tmp/shot.png')).toEqual(['/tmp/shot.png']);
  expect(captureArgs('scrot', '/tmp/shot.png')).toEqual(['--overwrite', '/tmp/shot.png']);
  expect(() => captureArgs('snap' as CaptureTool, '/tmp/x.png')).toThrow(AdapterError);
});

test('mixed session returns working X11 bytes without invoking unsupported Wayland', async () => {
  await withEnv(mixed, async () => {
    const { exec, calls } = fakeCapture(async (cmd, file) => {
      expect(cmd).toBe('scrot');
      await writeFile(file, png);
    });
    expect(await new Screenshot({ exec }).capture()).toEqual(png);
    expect(calls.map(({ cmd }) => cmd)).toEqual(['scrot']);
    await expectClean(calls);
  });
});

test('failed X11 falls back to grim bytes under the same bounded default deadline', async () => {
  await withEnv(mixed, async () => {
    let now = 1000;
    const { exec, calls } = fakeCapture(async (cmd, file) => {
      if (cmd === 'scrot') {
        await writeFile(file, Uint8Array.from([1, 2, 3]));
        now += 2000;
        throw new AdapterError('scrot: cannot open display');
      }
      await writeFile(file, png);
    });
    expect(await new Screenshot({ exec, now: () => now }).capture()).toEqual(png);
    expect(calls.map(({ cmd }) => cmd)).toEqual(['scrot', 'grim']);
    expect(calls.map(({ deadline }) => deadline)).toEqual([31_000, 31_000]);
    expect(calls[0]?.file).not.toBe(calls[1]?.file);
    await expectClean(calls);
  });
});

test('Wayland-only capture invokes grim even with a non-wlroots desktop hint', async () => {
  await withEnv({ WAYLAND_DISPLAY: 'wayland-1', XDG_CURRENT_DESKTOP: 'KDE' }, async () => {
    const { exec, calls } = fakeCapture(async (_cmd, file) => {
      await writeFile(file, png);
    });
    expect(await new Screenshot({ exec }).capture()).toEqual(png);
    expect(calls.map(({ cmd }) => cmd)).toEqual(['grim']);
    await expectClean(calls);
  });
});

test('unsupported Wayland is diagnosed as compositor capture infrastructure, not an app bug', async () => {
  await withEnv({ WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'GNOME' }, async () => {
    const { exec, calls } = fakeCapture(async () => {
      throw new AdapterError('compositor does not support wlr-screencopy-unstable-v1');
    });
    const error = await new Screenshot({ exec }).capture().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AdapterError);
    expect(String(error)).toContain('capture infrastructure');
    expect(String(error)).toContain('not an application defect');
    expect(String(error)).toContain('XDG_CURRENT_DESKTOP=GNOME');
    expect(String(error)).toContain('DISPLAY is not set');
    expect(String(error)).toContain(
      'grim failed: compositor does not support wlr-screencopy-unstable-v1',
    );
    expect(String(error)).toContain('portal/D-Bus capture is not implemented');
    expect(calls.map(({ cmd }) => cmd)).toEqual(['grim']);
    await expectClean(calls);
  });
});

test('exhausted routes retain missing binary and unsupported protocol reasons plus desktop hint', async () => {
  await withEnv({ ...mixed, XDG_CURRENT_DESKTOP: '', DESKTOP_SESSION: 'plasma' }, async () => {
    const { exec, calls } = fakeCapture(async (cmd) => {
      throw new AdapterError(
        cmd === 'scrot' ? 'spawn scrot ENOENT' : 'unsupported screencopy protocol',
      );
    });
    const error = await new Screenshot({ exec }).capture().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AdapterError);
    expect(String(error)).toContain('DESKTOP_SESSION=plasma');
    expect(String(error)).toContain('scrot failed: spawn scrot ENOENT');
    expect(String(error)).toContain('grim failed: unsupported screencopy protocol');
    expect(calls.map(({ cmd }) => cmd)).toEqual(['scrot', 'grim']);
    await expectClean(calls);
  });
});

test('no displays explains both unavailable routes without executing anything', async () => {
  await withEnv({}, async () => {
    const { exec, calls } = fakeCapture(async () => {});
    const error = await new Screenshot({ exec }).capture().catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AdapterError);
    expect(String(error)).toContain('DISPLAY is not set');
    expect(String(error)).toContain('WAYLAND_DISPLAY is not set');
    expect(String(error)).toContain('compositor/desktop unknown');
    expect(calls).toEqual([]);
  });
});

test('explicit target DISPLAY isolates capture from inherited Wayland even on failure', async () => {
  await withEnv(mixed, async () => {
    expect(desktopEnv(':99').WAYLAND_DISPLAY).toBeUndefined();
    expect(desktopEnv(':99').DISPLAY).toBe(':99');
    const { exec, calls } = fakeCapture(async () => {
      throw new AdapterError('spawn scrot ENOENT');
    });
    await expect(new Screenshot({ display: ':99', exec }).capture()).rejects.toThrow(
      'WAYLAND_DISPLAY is not set',
    );
    expect(calls.map(({ cmd }) => cmd)).toEqual(['scrot']);
    await expectClean(calls);
  });
});

test('caller deadline is shared across fallback and bytes arrive within budget', async () => {
  await withEnv(mixed, async () => {
    let now = 1000;
    const { exec, calls } = fakeCapture(async (cmd, file) => {
      now += 100;
      if (cmd === 'scrot') throw new AdapterError('X11 failed');
      await writeFile(file, png);
    });
    expect(await new Screenshot({ exec, now: () => now }).capture(1500)).toEqual(png);
    expect(calls.map(({ deadline }) => deadline)).toEqual([1500, 1500]);
    await expectClean(calls);
  });
});

for (const result of ['failure', 'late PNG', 'timeout'] as const) {
  test(`no fallback after ${result} exhausts the deadline`, async () => {
    await withEnv(mixed, async () => {
      let now = 1000;
      const timeout = new ExecTimeoutError('scrot timed out');
      const { exec, calls } = fakeCapture(async (_cmd, file) => {
        now = 1500;
        if (result === 'timeout') throw timeout;
        if (result === 'failure') throw new AdapterError('X11 failed');
        await writeFile(file, png);
      });
      const error = await new Screenshot({ exec, now: () => now })
        .capture(1500)
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ExecTimeoutError);
      if (result === 'timeout') expect(error).toBe(timeout);
      else expect(String(error)).toContain('after its deadline');
      expect(calls.map(({ cmd }) => cmd)).toEqual(['scrot']);
      await expectClean(calls);
    });
  });
}

test('an already exhausted budget starts no route', async () => {
  await withEnv(mixed, async () => {
    const { exec, calls } = fakeCapture(async () => {});
    await expect(new Screenshot({ exec, now: () => 1000 }).capture(1000)).rejects.toThrow(
      ExecTimeoutError,
    );
    expect(calls).toEqual([]);
  });
});

test('a subprocess timeout preserves identity even before the shared deadline', async () => {
  await withEnv(mixed, async () => {
    const timeout = new ExecTimeoutError('scrot killed by invocation cap');
    const { exec, calls } = fakeCapture(async () => {
      throw timeout;
    });
    const error = await new Screenshot({ exec, now: () => 1000 })
      .capture(2000)
      .catch((error: unknown) => error);
    expect(error).toBe(timeout);
    expect(calls.map(({ cmd }) => cmd)).toEqual(['scrot']);
    await expectClean(calls);
  });
});
