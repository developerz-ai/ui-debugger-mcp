/**
 * Post-verdict finalisation vs teardown: an abort that lands while a step is
 * READING the findings must stop every write-back (and the model call) after it.
 * `Session#raceAbort` stops waiting at the abort, so `close()` can already have
 * returned when that read resolves.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Findings } from '../findings/schema.js';
import { ensureReplay, ensureSummary, type FinalizeContext } from './finalize.js';
import { FindingsStore } from './findings-store.js';
import type { ReplayOutcome } from './session.js';
import { sessionPaths, workspacePaths } from './workspace.js';

/** A store whose reads park until released, and which counts the writes it receives. */
class GatedStore extends FindingsStore {
  writes = 0;
  #release: () => void = () => undefined;
  #gate = new Promise<void>((resolve) => {
    this.#release = resolve;
  });
  entered: Promise<void>;
  #enter: () => void = () => undefined;

  constructor(dir: string) {
    super(sessionPaths(workspacePaths('/project/app', dir), 'sess-1'));
    this.entered = new Promise<void>((resolve) => {
      this.#enter = resolve;
    });
  }

  release(): void {
    this.#release();
  }

  override async tryReadFindings(): Promise<Findings | null> {
    this.#enter();
    await this.#gate;
    return super.tryReadFindings();
  }

  override async writeFindings(findings: Findings): Promise<string> {
    this.writes += 1;
    return super.writeFindings(findings);
  }
}

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'ui-dbg-finalize-test-'));
});
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Seed findings on disk (through the base store, so the gate is not involved). */
async function seed(findings: Findings): Promise<void> {
  await new FindingsStore(
    sessionPaths(workspacePaths('/project/app', tmpDir), 'sess-1'),
  ).writeFindings(findings);
}

/** Run `step`, abort while its findings read is parked, then let the read finish. */
async function abortDuringRead(
  step: (ctx: FinalizeContext) => Promise<void>,
  extra: Partial<FinalizeContext> = {},
): Promise<GatedStore> {
  const store = new GatedStore(tmpDir);
  const abort = new AbortController();
  const run = step({
    store,
    status: 'failed',
    signal: abort.signal,
    summarize: undefined,
    replay: undefined,
    ...extra,
  });
  await store.entered;
  abort.abort();
  store.release();
  await run;
  return store;
}

test('the no-verdict summary is not written when the abort lands during its read', async () => {
  await seed({ status: 'running', steps: [], bugs: [], visual: [] });
  const store = await abortDuringRead(ensureSummary);
  expect(store.writes).toBe(0);
});

test('the summary model is never called when the abort lands during the read', async () => {
  await seed({ status: 'passed', steps: [], bugs: [], visual: [] });
  let called = false;
  const store = await abortDuringRead(ensureSummary, {
    status: 'passed',
    summarize: async () => {
      called = true;
      return 'prose';
    },
  });
  expect(called).toBe(false);
  expect(store.writes).toBe(0);
});

test('neither replay write-back lands when the abort comes during its read', async () => {
  for (const outcome of [
    { kind: 'rendered', path: '/x/replay.mp4' },
    { kind: 'skipped', note: 'ffmpeg missing' },
  ] satisfies ReplayOutcome[]) {
    await seed({ status: 'passed', steps: [], bugs: [], visual: [] });
    const store = await abortDuringRead(ensureReplay, {
      status: 'passed',
      replay: async () => outcome,
    });
    expect(store.writes).toBe(0);
  }
});
