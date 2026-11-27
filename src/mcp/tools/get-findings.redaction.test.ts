/**
 * MCP read boundary: findings written through `FindingsStore` with synthetic
 * persona secrets in every prose field must come out of `get_findings` redacted,
 * both whole and under a sparse `fields` projection. No target, no credentials.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetFindingsInput } from '../../services/debug-api.js';
import type { DebugApi } from '../../services/debug-service.js';
import type { Findings } from '../../findings/schema.js';
import { projectFindings } from '../../services/foreign-findings.js';
import { createSecretRedactor } from '../../redact.js';
import { FindingsStore } from '../../session/findings-store.js';
import type { WorkspacePaths } from '../../session/workspace.js';
import { getFindingsTool } from './get-findings.js';

const SECRETS = ['hunter2', 'a b/c@dev.local'];
const redact = createSecretRedactor(SECRETS);
const MASK = '<redacted, 7 chars>';

function noSecret(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
    expect(text).not.toContain(JSON.stringify(secret).slice(1, -1));
  }
}

const DIRS: string[] = [];
afterAll(async () => {
  for (const dir of DIRS.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A real findings store on disk in a throwaway workspace. */
async function store(): Promise<FindingsStore> {
  const root = await mkdtemp(join(tmpdir(), 'ui-debugger-findings-redaction-'));
  DIRS.push(root);
  const workspace: WorkspacePaths = {
    root,
    chromeUserData: join(root, 'chrome-user-data'),
    sessions: join(root, 'sessions'),
    stateJson: join(root, 'state.json'),
  };
  return new FindingsStore(
    {
      root: join(workspace.sessions, 's1'),
      storyMd: join(workspace.sessions, 's1', 'story.md'),
      screenshots: join(workspace.sessions, 's1', 'screenshots'),
      replayMp4: join(workspace.sessions, 's1', 'replay.mp4'),
      findingsJson: join(workspace.sessions, 's1', 'findings.json'),
      logs: join(workspace.sessions, 's1', 'logs'),
    },
    redact,
  );
}

/** The MCP tool needs only the read half of DebugApi. */
function service(read: () => Promise<Findings>): {
  api: DebugApi;
  seen: GetFindingsInput[];
} {
  const seen: GetFindingsInput[] = [];
  return {
    seen,
    api: {
      getFindings: async (args: GetFindingsInput) => {
        seen.push(args);
        const findings = await read();
        return args.fields ? projectFindings(findings, args.fields) : findings;
      },
    } as unknown as DebugApi,
  };
}

type Handler = (
  args: Record<string, unknown>,
  extra?: unknown,
) => Promise<CallToolResult> | CallToolResult;

/** Register the given service's tool and hand back its raw handler. */
function handlerFor(api: DebugApi): Handler {
  let handler: Handler | undefined;
  const server = {
    registerTool(_name: string, _config: unknown, cb: Handler) {
      handler = cb;
    },
  } as unknown as McpServer;
  getFindingsTool(api).register(server);
  if (!handler) throw new Error('get_findings did not register');
  return handler;
}

const raw: Findings = {
  status: 'failed',
  steps: [
    {
      step: `typed ${SECRETS[0]} into ${SECRETS[1]}`,
      ok: false,
      note: `body=${encodeURIComponent(SECRETS[0] ?? '')}`,
      screenshot: `screenshots/${SECRETS[0]}.png`,
    },
  ],
  bugs: [
    {
      kind: 'flow',
      detail: `login rejected ${SECRETS[0]} and ${JSON.stringify(SECRETS[1])}`,
      evidence: `${SECRETS[1]} at /login`,
    },
  ],
  visual: [
    {
      issue: `badge showed ${SECRETS[0]}`,
      where: `header ${SECRETS[1]}`,
      severity: 'medium',
      screenshot: `screenshots/${SECRETS[1]}.png`,
    },
  ],
  summary: `run failed for ${SECRETS[0]}`,
  evidence: `logs/${SECRETS[0]}.log`,
};

test('get_findings returns no persona secret in steps/bugs/visual/summary/evidence', async () => {
  const storeInstance = await store();
  await storeInstance.writeFindings(raw);
  const { api, seen } = service(() => storeInstance.readFindings());
  const handler = handlerFor(api);
  const result = await handler({ session_id: 's1' });

  const text = JSON.stringify(result);
  noSecret(text);
  const structured = JSON.stringify(result.structuredContent);
  noSecret(structured);
  expect(structured).toContain(MASK);
  expect(seen).toEqual([{ session_id: 's1' }]);

  // The on-disk copy is redacted too: the MCP read boundary is a second line of
  // defence, not the only one. No target was ever launched.
  const onDisk = JSON.stringify(await storeInstance.readFindings());
  noSecret(onDisk);
});

test('sparse fields projection returns ONLY the requested keys, still redacted', async () => {
  const storeInstance = await store();
  await storeInstance.writeFindings(raw);
  const { api, seen } = service(() => storeInstance.readFindings());
  const handler = handlerFor(api);
  const result = await handler({ session_id: 's1', fields: ['status', 'bugs', 'summary'] });

  const structured = result.structuredContent as Record<string, unknown>;
  expect(Object.keys(structured).sort()).toEqual(['bugs', 'status', 'summary']);
  noSecret(JSON.stringify(structured));
  expect(JSON.stringify(structured.bugs)).toContain(MASK);
  expect(seen).toEqual([{ session_id: 's1', fields: ['status', 'bugs', 'summary'] }]);
});
