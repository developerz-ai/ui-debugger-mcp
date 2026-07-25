import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NAME, VERSION } from './index.js';

test('exposes a stable package name', () => {
  expect(NAME).toBe('ui-debugger-mcp');
});

test('exposes a semver version', () => {
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});

test('VERSION matches package.json', async () => {
  const pkgPath = new URL('../package.json', import.meta.url);
  const pkg = await import(pkgPath.href, { with: { type: 'json' } });
  expect(VERSION).toBe(pkg.default.version);
});

// The release publishes npm AND the MCP Registry from one tag. server.json carries
// the version twice; either one drifting ships a registry entry pointing at a
// version that does not exist on npm.
test('server.json versions match package.json', async () => {
  const pkg = await import(new URL('../package.json', import.meta.url).href, {
    with: { type: 'json' },
  });
  const server = await import(new URL('../server.json', import.meta.url).href, {
    with: { type: 'json' },
  });
  expect(server.default.version).toBe(pkg.default.version);
  expect(server.default.packages[0].version).toBe(pkg.default.version);
});

/**
 * We develop under Bun but ship `bin: dist/main.js` behind `#!/usr/bin/env node`,
 * so any Bun global in production code is a `ReferenceError` in every installed
 * copy while passing every local test. `Bun.hash` in the config fingerprint did
 * exactly that: it threw into a catch and silently disabled drift detection for
 * everyone who installed from npm. Tests may use Bun freely — only shipped code
 * has to be runtime-agnostic.
 */
test('no production source reaches for a Bun global — the published bin runs on Node', () => {
  const src = new URL('.', import.meta.url).pathname;
  const offenders: string[] = [];

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else if (entry.name.endsWith('.ts') && !entry.name.includes('.test.')) {
        // Comments may name `Bun.*` — the ban is on calling it, not explaining it.
        const code = readFileSync(path, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '');
        if (/\bBun\s*\./.test(code)) offenders.push(path.slice(src.length));
      }
    }
  };
  walk(src);

  expect(offenders).toEqual([]);
});
