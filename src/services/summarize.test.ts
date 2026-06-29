import { expect, test } from 'bun:test';
import { AgentError } from '../errors.js';
import type { Findings } from '../findings/schema.js';
import { findingsDigest, SUMMARY_SYSTEM_PROMPT, summarize } from './summarize.js';

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
