/**
 * `.github/workflows/release.yml` — the publication path — has a contract worth
 * pinning: the version-consistency tests must run BEFORE anything is published,
 * and they must be fatal. The tests themselves existed, but only CI ran them;
 * neither publication route (the `release: published` event and the manual
 * `workflow_dispatch`) was gated by them, so a drifted version could reach npm
 * AND the MCP Registry.
 *
 * These assertions read the workflow's TEXT and never execute it: the publish
 * route is a GitHub Actions job, not a local command.
 *
 * The workflow is parsed into steps (name / uses / run / if / continue-on-error)
 * so the assertions are about the STEP GRAPH, not about prose: a comment that
 * merely mentions `bun test` must not be able to satisfy a presence assertion
 * — shell comment lines are dropped from `run:` bodies during the parse, and
 * the validation lookup demands the test command on an EXECUTABLE line — and
 * a validation step moved AFTER a publish step must fail the ordering
 * assertion even though the command itself is unchanged.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');

const workflowText = readFileSync(join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8');

/** One step of the `publish` job, as parsed out of the workflow text. */
interface Step {
  /** 1-based line number of the step's first line in the original file. */
  line: number;
  /** The step's `name:` value, or '' for a `uses:`-only step. */
  name: string;
  /** The step's `uses:` value, or '' for a `run:`-only step. */
  uses: string;
  /** The step's `run:` body, or '' when it has none. */
  run: string;
  /** The step's `if:` condition, or '' when it has none. */
  if: string;
  /** The step's `continue-on-error:` value, or '' when it has none. */
  continueOnError: string;
}

/** The keys a step can carry. */
type StepKey = 'name' | 'uses' | 'run' | 'if' | 'continue-on-error';

/** Assign one recognised step key to the step being parsed. */
function assignStepKey(current: Step, key: StepKey, value: string): void {
  if (key === 'run') {
    // A block scalar opens below; an inline `# …` value is a shell comment,
    // not a command — neither may satisfy a presence assertion.
    current.run = value === '|' || value === '>' || value.startsWith('#') ? '' : value;
    return;
  }
  if (key === 'continue-on-error') {
    current.continueOnError = value;
    return;
  }
  current[key] = value;
}

/**
 * The step list of the `publish` job, parsed from the raw text.
 *
 * Steps are the list items at the `steps:` level of the job — two-space
 * indentation under `      steps:` — so a nested list (e.g. inside a `run:`
 * block) cannot be mistaken for a step.
 */
function parseSteps(text: string): Step[] {
  const lines = text.split('\n');
  const steps: Step[] = [];

  let inSteps = false;
  let current: Step | null = null;
  let currentKey: StepKey | null = null;

  const flush = (): void => {
    if (current) steps.push(current);
    current = null;
    currentKey = null;
  };

  for (const [index, raw] of lines.entries()) {
    // `    steps:` — the job's step list starts.
    if (/^ {4}steps:\s*$/.test(raw)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;

    // A new step begins at the step-item indentation (`      - `).
    if (/^ {6}- /.test(raw)) {
      flush();
      const rest = raw.slice(8).trim();
      current = {
        line: index + 1,
        name: '',
        uses: '',
        run: '',
        if: '',
        continueOnError: '',
      };
      currentKey = null;
      const firstKey = rest.match(/^(name|uses|run|if|continue-on-error):(.*)$/);
      if (firstKey) {
        const key = firstKey[1] as StepKey;
        const value = firstKey[2]?.trim() ?? '';
        assignStepKey(current, key, value);
        currentKey = key === 'run' && (value === '|' || value === '>') ? 'run' : null;
      }
      continue;
    }

    if (!current) continue;

    // A step's keys sit at 8 spaces, its `run:` body deeper still.
    const keyMatch = raw.match(/^ {8}(name|uses|run|if|continue-on-error):(.*)$/);
    const key = keyMatch?.[1] as StepKey | undefined;
    const value = keyMatch?.[2]?.trim();
    if (key && value !== undefined) {
      assignStepKey(current, key, value);
      currentKey = key === 'run' && (value === '|' || value === '>') ? 'run' : null;
      continue;
    }

    // A deeper line belongs to the current `run:` block (or to a nested
    // mapping under a key we already consumed). Shell comment lines are
    // dropped: a commented-out `# bun test …` line is not a command and must
    // never satisfy a presence assertion (pinned by the mutation test below).
    if (currentKey === 'run' && /^\s{10,}\S/.test(raw)) {
      const text = raw.trim();
      if (!text.startsWith('#')) current.run += `\n${text}`;
    }
  }
  flush();

  return steps;
}

const steps = parseSteps(workflowText);

/** A `run:` body's executable lines — blanks and shell comments are not commands. */
function executableLines(run: string): string[] {
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((text) => text.length > 0 && !text.startsWith('#'));
}

/** The exact command the publication gate must execute, verbatim. */
const VALIDATION_COMMAND = 'bun test src/index.test.ts src/mcp/registry-server-json.test.ts';

/**
 * The step that runs the version-consistency tests, or undefined.
 *
 * The command must sit on an EXECUTABLE line of the step's `run:` body: a
 * commented-out `# bun test …` line finds nothing here, so a workflow whose
 * validation was commented out cannot pass the presence assertions. (Pinned
 * by the mutation test below — without both this check and the parser's
 * comment-stripping, the commented line used to satisfy every substring
 * assertion and publication ran without validation.)
 */
function findValidationStep(parsed: Step[]): Step | undefined {
  return parsed.find((step) =>
    executableLines(step.run).some((line) => line.includes(VALIDATION_COMMAND)),
  );
}

/** The validation step of the real workflow, or undefined. */
function validationStep(): Step | undefined {
  return findValidationStep(steps);
}

/** The step that publishes to npm, or undefined. */
function npmPublishStep(): Step | undefined {
  return steps.find((step) => step.run.includes('npm publish'));
}

/**
 * The step that publishes to the MCP Registry, or undefined. */
function registryPublishStep(): Step | undefined {
  return steps.find((step) => step.run.includes('mcp-publisher publish'));
}

/**
 * The step named by `find`, or a thrown failure.
 *
 * The absence of a step IS the defect these tests hunt (a missing validation
 * step, a moved publish step), so it must fail the test loudly — a thrown
 * error does that, and it narrows the type without a non-null assertion.
 */
function mustFind(what: string, find: () => Step | undefined): Step {
  const step = find();
  if (!step) throw new Error(`no step found for ${what}`);
  return step;
}

test('the publish job has a validation step running the version-consistency tests', () => {
  const validation = mustFind('the validation step', validationStep);

  expect(validation.run).toContain('bun test');
  expect(validation.run).toContain('src/index.test.ts');
  expect(validation.run).toContain('src/mcp/registry-server-json.test.ts');
});

test('commenting out the test command fails the guard (mutation)', () => {
  // The mutation this guard exists against: the `bun test` line commented out,
  // so publication would proceed without any validation. The commented line
  // must satisfy nothing — the parser drops comment lines from `run:` bodies,
  // and the lookup demands the command on an executable line — so the guard
  // must find NO validation step in the mutated workflow.
  expect(workflowText).toContain(VALIDATION_COMMAND);
  const mutated = workflowText.replace(VALIDATION_COMMAND, `# ${VALIDATION_COMMAND}`);
  expect(mutated).not.toBe(workflowText);

  expect(findValidationStep(parseSteps(mutated))).toBeUndefined();
});

test('the validation step runs after the build and before every publish step', () => {
  const build = mustFind('the build step', () =>
    steps.find((step) => step.run === 'bun run build'),
  );
  const validation = mustFind('the validation step', validationStep);
  const npm = mustFind('the npm publish step', npmPublishStep);
  const registry = mustFind('the registry publish step', registryPublishStep);

  // Order is by the steps' own line numbers in the workflow file.
  expect(validation.line).toBeGreaterThan(build.line);
  expect(validation.line).toBeLessThan(npm.line);
  expect(validation.line).toBeLessThan(registry.line);
});

test('the validation step cannot be made non-fatal', () => {
  const validation = mustFind('the validation step', validationStep);

  // `continue-on-error: true` would let a drifted version publish anyway.
  expect(validation.continueOnError).toBe('');
  // `if:` could skip the step — a skipped step is missing validation.
  expect(validation.if).toBe('');
});

test('the parser detects skippable and non-fatal keys in first position', () => {
  const workflow = `jobs:\n  publish:\n    steps:\n      - if: \${{ github.ref == 'refs/heads/main' }}\n        run: bun test\n      - continue-on-error: true\n        run: bun test\n`;

  const parsed = parseSteps(workflow);

  expect(parsed[0]?.if).toBe("\${{ github.ref == 'refs/heads/main' }}");
  expect(parsed[1]?.continueOnError).toBe('true');
});

test('the validation step does not swallow its own failure', () => {
  const validation = mustFind('the validation step', validationStep);

  // A `|| true` (or `&&` chain) on the test command would turn a failed test
  // into a green step while every other assertion still passed. Executable
  // lines only — a comment mentioning `||` neither runs nor swallows anything.
  for (const text of executableLines(validation.run)) {
    expect(text).not.toContain('||');
    expect(text).not.toContain('&&');
  }
});

test('the checkout is pinned to the event ref and the resolved SHA is echoed', () => {
  const checkout = mustFind('the checkout step', () =>
    steps.find((step) => step.uses.startsWith('actions/checkout')),
  );

  expect(checkout.uses).toContain('actions/checkout');
  // The checkout must name the event's ref — an unpinned checkout floats to
  // whatever the runner resolves, so the validated tree could differ from the
  // published one.
  expect(workflowText).toMatch(/ref:\s*\$\{\{\s*github\.ref\s*\}\}/);
  expect(mustFind('the validation step', validationStep).run).toContain('git rev-parse HEAD');
});

test('both publication routes run through the same gated publish job', () => {
  // `release: published` and `workflow_dispatch` must both reach the job that
  // carries the validation step — a gate on one route only is no gate.
  expect(workflowText).toContain('release:');
  expect(workflowText).toContain('types: [published]');
  expect(workflowText).toContain('workflow_dispatch:');

  const jobStart = workflowText.indexOf('\n  publish:');
  expect(jobStart).toBeGreaterThan(-1);
  expect(steps.length).toBeGreaterThan(0);
  expect(validationStep()).toBeDefined();
});
