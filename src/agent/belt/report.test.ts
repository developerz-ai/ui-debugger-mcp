import { expect, test } from 'bun:test';
import { FindingsError } from '../../errors.js';
import type { Findings } from '../../findings/schema.js';
import {
  createReportTool,
  type FindingsWriter,
  ReportInputSchema,
  type ReportResult,
  runReport,
} from './report.js';

/** A fake {@link FindingsWriter} that records what it was asked to persist. */
function fakeWriter(path = 'sessions/x/findings.json'): {
  writer: FindingsWriter;
  written: Findings[];
} {
  const written: Findings[] = [];
  const writer: FindingsWriter = {
    writeFindings: async (findings) => {
      written.push(findings);
      return path;
    },
  };
  return { writer, written };
}

const FULL: ReportResult['status'] = 'failed';

test('writes the verdict through the store and returns its path', async () => {
  const { writer, written } = fakeWriter('sessions/abc/findings.json');
  const res = await runReport(writer, {
    status: 'passed',
    steps: [{ step: 'Clicked Checkout', ok: true }],
    bugs: [],
    visual: [],
    summary: 'All good.',
  });
  expect(written).toHaveLength(1);
  expect(written[0]).toEqual({
    status: 'passed',
    steps: [{ step: 'Clicked Checkout', ok: true }],
    bugs: [],
    visual: [],
    summary: 'All good.',
  });
  expect(res.findings).toBe('sessions/abc/findings.json');
});

test('signals loop stop (stop:true) and echoes the terminal status', async () => {
  const { writer } = fakeWriter();
  const res = await runReport(writer, { status: FULL, steps: [], bugs: [], visual: [] });
  expect(res.stop).toBe(true);
  expect(res.status).toBe('failed');
});

test('reports counts so the verdict reads without re-opening the file', async () => {
  const { writer } = fakeWriter();
  const res = await runReport(writer, {
    status: 'failed',
    steps: [
      { step: 'a', ok: true },
      { step: 'b', ok: false },
    ],
    bugs: [{ kind: 'console', detail: 'TypeError' }],
    visual: [
      { issue: 'overlap', where: 'header', severity: 'high' },
      { issue: 'spacing', where: 'footer', severity: 'low' },
    ],
  });
  expect(res.counts).toEqual({ steps: 2, bugs: 1, visual: 2 });
});

test('omits summary from the written findings when not given', async () => {
  const { writer, written } = fakeWriter();
  await runReport(writer, { status: 'passed', steps: [], bugs: [], visual: [] });
  expect(written[0]).toEqual({ status: 'passed', steps: [], bugs: [], visual: [] });
  expect(written[0] && 'summary' in written[0]).toBe(false);
});

test('a store write error propagates (fail loud, no silent fallback)', async () => {
  const writer: FindingsWriter = {
    writeFindings: async () => {
      throw new FindingsError('disk full');
    },
  };
  await expect(
    runReport(writer, { status: 'passed', steps: [], bugs: [], visual: [] }),
  ).rejects.toThrow(FindingsError);
});

test('schema defaults steps/bugs/visual to [] — a clean pass needs only { status }', () => {
  const parsed = ReportInputSchema.parse({ status: 'passed' });
  expect(parsed).toEqual({ status: 'passed', steps: [], bugs: [], visual: [] });
});

test('schema rejects the non-terminal "running" status', () => {
  expect(ReportInputSchema.safeParse({ status: 'running' }).success).toBe(false);
});

test('schema rejects an unknown status', () => {
  expect(ReportInputSchema.safeParse({ status: 'flaky' }).success).toBe(false);
});

test('schema rejects a malformed bug (bad kind)', () => {
  const bad = ReportInputSchema.safeParse({
    status: 'failed',
    bugs: [{ kind: 'timeout', detail: 'x' }],
  });
  expect(bad.success).toBe(false);
});

test('schema rejects a malformed visual issue (bad severity)', () => {
  const bad = ReportInputSchema.safeParse({
    status: 'failed',
    visual: [{ issue: 'x', where: 'y', severity: 'critical' }],
  });
  expect(bad.success).toBe(false);
});

test('schema accepts a full, well-formed verdict', () => {
  const ok = ReportInputSchema.safeParse({
    status: 'failed',
    steps: [{ step: 'Opened page', ok: true, note: 'fast', screenshot: 's.png' }],
    bugs: [{ kind: 'network', detail: '500 on /api', evidence: 'network.log' }],
    visual: [{ issue: 'cut off', where: 'card', severity: 'medium', screenshot: 'v.png' }],
    summary: 'Checkout 500s; card text clips.',
  });
  expect(ok.success).toBe(true);
});

test('createReportTool exposes a described tool with an input schema', () => {
  const { writer } = fakeWriter();
  const report = createReportTool(writer);
  expect(typeof report.description).toBe('string');
  expect(report.inputSchema).toBeDefined();
});
