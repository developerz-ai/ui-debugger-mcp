import { expect, test } from 'bun:test';
import {
  BUG_KINDS,
  EVIDENCE_FIELD_NAMES,
  FINDINGS_STATUSES,
  FindingsSchema,
  TERMINAL_STATUSES,
  VISUAL_SEVERITIES,
} from './schema.js';

test('parses minimal running findings', () => {
  const result = FindingsSchema.parse({ status: 'running' });
  expect(result.status).toBe('running');
  expect(result.steps).toEqual([]);
  expect(result.bugs).toEqual([]);
  expect(result.visual).toEqual([]);
});

test('parses full findings with all fields', () => {
  const result = FindingsSchema.parse({
    status: 'failed',
    steps: [{ step: 'login', ok: false, note: 'button missing', screenshot: 'path/to/shot.png' }],
    bugs: [{ kind: 'console', detail: 'TypeError thrown', evidence: 'console.log' }],
    visual: [
      {
        issue: 'button too small',
        where: '#submit',
        severity: 'high',
        screenshot: 'path/shot.png',
      },
    ],
    summary: 'Login flow broken',
    evidence: './tmp/sessions/abc/findings.json',
  });
  expect(result.status).toBe('failed');
  expect(result.steps[0]?.step).toBe('login');
  expect(result.bugs[0]?.kind).toBe('console');
  expect(result.visual[0]?.severity).toBe('high');
  expect(result.summary).toBe('Login flow broken');
});

test('rejects invalid status', () => {
  expect(() => FindingsSchema.parse({ status: 'unknown' })).toThrow();
});

test('rejects invalid bug kind', () => {
  expect(() =>
    FindingsSchema.parse({ status: 'passed', bugs: [{ kind: 'visual', detail: 'x' }] }),
  ).toThrow();
});

test('rejects invalid visual severity', () => {
  expect(() =>
    FindingsSchema.parse({
      status: 'passed',
      visual: [{ issue: 'x', where: 'y', severity: 'critical' }],
    }),
  ).toThrow();
});

test('the findings vocabulary is exactly this pinned list', () => {
  expect([...FINDINGS_STATUSES]).toEqual(['running', 'passed', 'failed']);
  expect([...TERMINAL_STATUSES]).toEqual(['passed', 'failed']);
  expect([...VISUAL_SEVERITIES]).toEqual(['low', 'medium', 'high']);
  expect([...BUG_KINDS]).toEqual(['console', 'network', 'flow']);
  expect([...EVIDENCE_FIELD_NAMES]).toEqual(['screenshot', 'evidence']);
});

test('every terminal status is a findings status', () => {
  for (const status of TERMINAL_STATUSES) {
    expect([...FINDINGS_STATUSES]).toContain(status);
  }
});

test('every findings status parses', () => {
  for (const status of FINDINGS_STATUSES) {
    expect(FindingsSchema.parse({ status }).status).toBe(status);
  }
});
