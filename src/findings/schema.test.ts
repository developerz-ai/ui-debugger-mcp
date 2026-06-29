import { expect, test } from 'bun:test';
import { FindingsSchema } from './schema.js';

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
