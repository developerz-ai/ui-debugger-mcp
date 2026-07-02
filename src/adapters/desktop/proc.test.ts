import { expect, test } from 'bun:test';
import { desktopEnv } from './proc.js';

/** Patch `process.env` for one assertion block, always restoring afterwards. */
function withEnv(patch: Record<string, string | undefined>, fn: () => void): void {
  const saved = Object.fromEntries(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

// --- desktopEnv ---------------------------------------------------------------

test('desktopEnv overrides DISPLAY and drops inherited WAYLAND_DISPLAY for an explicit display', () => {
  withEnv({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, () => {
    const env = desktopEnv(':99');
    expect(env.DISPLAY).toBe(':99');
    expect(env.WAYLAND_DISPLAY).toBeUndefined();
    // The parent process env stays untouched.
    expect(process.env.WAYLAND_DISPLAY).toBe('wayland-0');
    expect(process.env.DISPLAY).toBe(':0');
  });
});

test('desktopEnv inherits the env unchanged when no display is configured', () => {
  withEnv({ WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' }, () => {
    const env = desktopEnv();
    expect(env.DISPLAY).toBe(':0');
    expect(env.WAYLAND_DISPLAY).toBe('wayland-0');
  });
});
