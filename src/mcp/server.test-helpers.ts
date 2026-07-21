/**
 * Shared fixtures for `server.test.ts` + `server.stdio.test.ts` — a fake
 * `SessionBuilder` wired to a real `Session`/`FindingsStore`, so both files can
 * drive a `DebugService` without a real adapter/browser.
 */

import type { ResolvedConfig } from '../config/load.js';
import type { BuiltSession } from '../services/session-builder.js';
import { FindingsStore } from '../session/findings-store.js';
import type { LoopRunner, SessionAdapter } from '../session/session.js';
import { Session } from '../session/session.js';
import { sessionPaths, workspacePaths } from '../session/workspace.js';

export const CWD = '/project/app';
export const NOW = 1_700_000_000_000;

export const CONFIG: ResolvedConfig = {
  models: { driver: 'deepseek/x', vision: 'glm/y', summary: 'deepseek/z' },
  workspace: './tmp/ui-debugger-mcp',
  targets: {
    web: { adapter: 'browser', url: 'http://localhost:3000', headless: true },
  },
  provider: { apiKey: 'sk-test', baseUrl: 'https://openrouter.ai/api/v1' },
};

export class FakeAdapter implements SessionAdapter {
  async close(): Promise<void> {}
}

/** A run that idles until aborted. */
export const idleRun: LoopRunner = ({ signal }) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });

/** A `SessionBuilder` stub rooted at the caller's tmp workspace dir. */
export function fakeBuilder(tmpDir: string) {
  return async (params: { id: string; target: string; goal: string; criteria?: string }) => {
    const adapter = new FakeAdapter();
    const store = new FindingsStore(sessionPaths(workspacePaths(CWD, tmpDir), params.id));
    const session = new Session<SessionAdapter>({
      id: params.id,
      story: params.goal,
      criteria: params.criteria,
      adapter,
      findingsStore: store,
    });
    const built: BuiltSession = {
      session,
      open: async () => {},
      run: idleRun,
    };
    return built;
  };
}
