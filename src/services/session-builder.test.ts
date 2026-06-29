import { expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import type { ResolvedConfig } from '../config/load.js';
import { TargetNotFoundError } from '../errors.js';
import { workspacePaths } from '../session/workspace.js';
import { buildSession, makeSessionBuilder, type SessionBuilderDeps } from './session-builder.js';

const CONFIG: ResolvedConfig = {
  models: { driver: 'd', vision: 'v', summary: 's' },
  workspace: './tmp/ui-debugger-mcp',
  targets: {
    web: { adapter: 'browser', url: 'http://localhost:3000', headless: true },
    screen: { adapter: 'desktop', launch: 'myapp', window: { title: 'My App' } },
    phone: { adapter: 'android', avd: 'pixel' },
  },
  provider: { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1' },
};

function deps(): SessionBuilderDeps {
  return {
    config: CONFIG,
    models: {
      driver: new MockLanguageModelV3(),
      vision: new MockLanguageModelV3(),
      summary: new MockLanguageModelV3(),
    },
    workspace: workspacePaths('/project/app', '/tmp/ui-dbg-builder-test'),
  };
}

test('buildSession rejects an unknown target before touching disk or the browser', async () => {
  await expect(buildSession(deps(), { id: 's1', target: 'ghost', goal: 'x' })).rejects.toThrow(
    TargetNotFoundError,
  );
});

test('buildSession wires a desktop target (addendum + adapter) without launching', async () => {
  const built = await buildSession(deps(), {
    id: 'd1',
    target: 'screen',
    goal: 'open the settings dialog',
  });
  expect(built.session).toBeDefined();
  expect(typeof built.open).toBe('function');
  expect(typeof built.run).toBe('function');
});

test('buildSession wires an android target (addendum + adapter) without launching', async () => {
  const built = await buildSession(deps(), {
    id: 'a1',
    target: 'phone',
    goal: 'open com.example.app and verify the home screen',
  });
  expect(built.session).toBeDefined();
  expect(typeof built.open).toBe('function');
  expect(typeof built.run).toBe('function');
});

test('makeSessionBuilder binds the deps into a per-run builder', async () => {
  const build = makeSessionBuilder(deps());
  await expect(build({ id: 's1', target: 'ghost', goal: 'x' })).rejects.toThrow(
    TargetNotFoundError,
  );
});
