import { expect, test } from 'bun:test';
import { MockLanguageModelV3 } from 'ai/test';
import { createSecretRedactor } from '../adapters/browser/log-format.js';
import { AgentError } from '../errors.js';
import type { Findings } from '../findings/schema.js';
import { createSummarize, findingsDigest, SUMMARY_SYSTEM_PROMPT, summarize } from './summarize.js';

// --- findingsDigest ----------------------------------------------------------

test('findingsDigest renders the verdict and "none" sentinels when there are no issues', () => {
  const findings: Findings = { status: 'passed', steps: [], bugs: [], visual: [] };
  const digest = findingsDigest(findings);
  expect(digest).toContain('Verdict: passed.');
  expect(digest).toContain('Functional bugs: none.');
  expect(digest).toContain('Visual issues: none.');
});

test('findingsDigest renders each bug with kind, detail, and optional evidence', () => {
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [
      { kind: 'console', detail: 'TypeError: x is undefined', evidence: 'line 42' },
      { kind: 'flow', detail: 'button not clickable' },
    ],
    visual: [],
  };
  const digest = findingsDigest(findings);
  expect(digest).toContain('Functional bugs (2):');
  expect(digest).toContain('- [console] TypeError: x is undefined (evidence: line 42)');
  expect(digest).toContain('- [flow] button not clickable');
});

test('findingsDigest omits evidence suffix when evidence is absent', () => {
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [{ kind: 'network', detail: '404 on /api/login' }],
    visual: [],
  };
  const digest = findingsDigest(findings);
  expect(digest).toContain('- [network] 404 on /api/login');
  expect(digest).not.toContain('evidence:');
});

test('findingsDigest renders visual issues with severity, description, and location', () => {
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [],
    visual: [{ issue: 'button is invisible', where: 'login page', severity: 'high' }],
  };
  const digest = findingsDigest(findings);
  expect(digest).toContain('Visual issues (1):');
  expect(digest).toContain('- [high] button is invisible @ login page');
});

test('findingsDigest renders bugs and visual issues together when both are present', () => {
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [{ kind: 'flow', detail: 'dead button' }],
    visual: [{ issue: 'misaligned', where: 'header', severity: 'low' }],
  };
  const digest = findingsDigest(findings);
  expect(digest).toContain('Functional bugs (1):');
  expect(digest).toContain('Visual issues (1):');
  expect(digest).not.toContain('none.');
});

// --- summarize ---------------------------------------------------------------

test('summarize returns trimmed text from the generate seam', async () => {
  const fake = async () => ({ text: '  login crashes on submit  ' });
  const findings: Findings = { status: 'failed', steps: [], bugs: [], visual: [] };
  const result = await summarize(fake, findings);
  expect(result).toBe('login crashes on submit');
});

test('summarize passes SUMMARY_SYSTEM_PROMPT and the findings digest to the generate seam', async () => {
  let captured: { system: string; prompt: string } | undefined;
  const fake = async (req: { system: string; prompt: string }) => {
    captured = req;
    return { text: 'one bug found' };
  };
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [{ kind: 'network', detail: '404 on /api/login' }],
    visual: [],
  };
  await summarize(fake, findings);
  expect(captured?.system).toBe(SUMMARY_SYSTEM_PROMPT);
  expect(captured?.prompt).toContain('Verdict: failed.');
  expect(captured?.prompt).toContain('404 on /api/login');
});

test('summarize forwards the abort signal into the generate seam', async () => {
  let captured: AbortSignal | undefined;
  const fake = async (req: { system: string; prompt: string; abortSignal?: AbortSignal }) => {
    captured = req.abortSignal;
    return { text: 'ok' };
  };
  const findings: Findings = { status: 'passed', steps: [], bugs: [], visual: [] };
  const controller = new AbortController();
  await summarize(fake, findings, controller.signal);
  expect(captured).toBe(controller.signal);
});

test('summarize throws AgentError when the generate seam returns an empty string', async () => {
  const fake = async () => ({ text: '' });
  const findings: Findings = { status: 'failed', steps: [], bugs: [], visual: [] };
  await expect(summarize(fake, findings)).rejects.toThrow(AgentError);
});

test('summarize throws AgentError when the generate seam returns whitespace only', async () => {
  const fake = async () => ({ text: '   \n  \t  ' });
  const findings: Findings = { status: 'failed', steps: [], bugs: [], visual: [] };
  await expect(summarize(fake, findings)).rejects.toThrow(AgentError);
});

// --- redaction: the provider prompt never carries a raw persona value ----------

/**
 * `hunter2` is a SYNTHETIC persona value (7 chars → `<redacted, 7 chars>`),
 * never a real credential — the same redactor `session-builder.ts` binds per run.
 */
const REDACT = createSecretRedactor(['hunter2']);

test('summarize passes the digest through the per-run redactor before the generate seam', async () => {
  let captured: { system: string; prompt: string } | undefined;
  const fake = async (req: { system: string; prompt: string }) => {
    captured = req;
    return { text: 'one bug found' };
  };
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [{ kind: 'console', detail: 'login failed for hunter2', evidence: '/login' }],
    visual: [],
  };
  await summarize(fake, findings, undefined, REDACT);
  expect(captured?.system).toBe(SUMMARY_SYSTEM_PROMPT);
  expect(captured?.prompt).toContain('<redacted, 7 chars>');
  expect(captured?.prompt).not.toContain('hunter2');
  // Non-persona bug text survives redaction untouched.
  expect(captured?.prompt).toContain('login failed for <redacted, 7 chars>');
  expect(captured?.prompt).toContain('evidence: /login');
});

test('createSummarize binds the redactor: the provider sees the redacted prompt only', async () => {
  const seen: string[] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ prompt }) => {
      seen.push(JSON.stringify(prompt));
      return {
        content: [{ type: 'text' as const, text: 'summary paragraph' }],
        finishReason: { unified: 'stop' as const, raw: 'stop' },
        usage: {
          inputTokens: {
            total: 1,
            noCache: 1 as number | undefined,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: { total: 1, text: 1 as number | undefined, reasoning: undefined },
        },
        warnings: [] as [],
      };
    },
  });
  const step = createSummarize(model, REDACT);
  const findings: Findings = {
    status: 'failed',
    steps: [],
    bugs: [{ kind: 'console', detail: 'auth crashed for hunter2' }],
    visual: [],
  };
  const paragraph = await step(findings);
  expect(paragraph).toBe('summary paragraph');
  expect(seen[0]).toContain('<redacted, 7 chars>');
  expect(seen[0]).not.toContain('hunter2');
});
