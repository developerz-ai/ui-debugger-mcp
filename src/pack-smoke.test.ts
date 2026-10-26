/**
 * `bin/smoke-packed` + the `pack-smoke` CI job — the packed-artifact path.
 *
 * The `bun` job runs the SOURCE under bun and never touches what npm ships:
 * nothing proved the PACKED artifact installs and runs on the node floor
 * package.json declares. This file pins both halves of that path:
 *
 *   - the workflow job, PARSED rather than grepped: comment lines and shell
 *     comments inside `run:` bodies are dropped, so a commented-out step
 *     satisfies no assertion;
 *   - the script, EXECUTED against a stub npm and a stub node, so a tarball
 *     without the manifest's bin/exports targets, a CLI that exits non-zero
 *     and a package that needs a newer node all fail loud instead of
 *     passing quietly;
 *
 *   - the shipped SOURCE, scanned for Bun-only imports, because a static one
 *     is what makes the installed copy die before it can print anything.
 *
 * Every guard carries a mutation test: the text it exists to reject is
 * mutated and the guard must notice. A guard that cannot fail is a defect.
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(import.meta.dirname, '..');
const workflowText = readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const scriptText = readFileSync(join(REPO_ROOT, 'bin/smoke-packed'), 'utf8');

/** The shipped source root — every module the published bin loads. */
const SRC_ROOT = join(REPO_ROOT, 'src');

interface PackageJson {
  name: string;
  version: string;
  engines?: { node?: string };
  bin?: string | Record<string, string>;
  exports?: Record<string, string | Record<string, string>>;
}

const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as PackageJson;

/** The command the CI job runs — the one line that reaches the script. */
const SMOKE_COMMAND = 'bash bin/smoke-packed';

/**
 * The node major the manifest declares as its floor: ">=20" → 20.
 *
 * Derived, never hardcoded: bumping engines.node turns the setup-node
 * assertion red until ci.yml follows.
 */
function nodeFloor(engines: string | undefined): number {
  const match = engines?.match(/>=\s*(\d+)/);
  const floor = match?.[1];
  if (!floor) {
    throw new Error(`cannot read a node floor out of engines.node "${engines ?? ''}"`);
  }
  return Number(floor);
}

const FLOOR = nodeFloor(pkg.engines?.node);

/* ------------------------------------------------------------------ parsing */

interface Step {
  /** 1-based line of the step's first line in the workflow file. */
  line: number;
  name: string;
  uses: string;
  run: string;
  if: string;
  continueOnError: string;
  with: Record<string, string>;
}

interface Job {
  key: string;
  /** 1-based line of the job's key in the workflow file. */
  line: number;
  name: string;
  runsOn: string;
  timeoutMinutes: string;
  steps: Step[];
}

/** Strip the quotes YAML allows around a scalar. */
function unquote(value: string): string {
  const match = value.match(/^(['"])(.*)\1$/);
  return match?.[2] ?? value;
}

function assignStepKey(step: Step, key: string, rawValue: string): void {
  const value = unquote(rawValue.trim());
  if (key === 'name') {
    step.name = value;
  } else if (key === 'uses') {
    step.uses = value;
  } else if (key === 'if') {
    step.if = value;
  } else if (key === 'continue-on-error') {
    step.continueOnError = value;
  } else if (key === 'run') {
    // A block scalar opens below; an inline `# …` value is a shell comment,
    // not a command — neither may satisfy a presence assertion.
    step.run = value === '|' || value === '>' || value.startsWith('#') ? '' : value;
  }
}

/**
 * The jobs of a workflow, parsed from the raw text.
 *
 * The step list of a job is the list items at the `steps:` level (six-space
 * indentation), so a nested list inside a `run:` body cannot be mistaken for
 * a step.
 */
function parseJobs(text: string): Job[] {
  const lines = text.split('\n');
  const jobs: Job[] = [];
  let inJobs = false;
  let job: Job | null = null;
  let step: Step | null = null;
  let block: 'run' | 'with' | null = null;

  const flushStep = (): void => {
    if (step && job) job.steps.push(step);
    step = null;
    block = null;
  };

  for (const [index, raw] of lines.entries()) {
    if (/^jobs:\s*$/.test(raw)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    const jobKey = raw.match(/^ {2}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (jobKey) {
      flushStep();
      if (job) jobs.push(job);
      job = {
        key: jobKey[1] ?? '',
        line: index + 1,
        name: '',
        runsOn: '',
        timeoutMinutes: '',
        steps: [],
      };
      continue;
    }
    if (!job) continue;

    const jobField = raw.match(/^ {4}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (jobField) {
      flushStep();
      const key = jobField[1] ?? '';
      const value = unquote((jobField[2] ?? '').trim());
      if (key === 'name') {
        job.name = value;
      } else if (key === 'runs-on') {
        job.runsOn = value;
      } else if (key === 'timeout-minutes') {
        job.timeoutMinutes = value;
      }
      continue;
    }

    if (/^ {4}steps:\s*$/.test(raw)) {
      flushStep();
      continue;
    }

    const stepItem = raw.match(/^ {6}- (.*)$/);
    if (stepItem) {
      flushStep();
      step = {
        line: index + 1,
        name: '',
        uses: '',
        run: '',
        if: '',
        continueOnError: '',
        with: {},
      };
      const firstKey = (stepItem[1] ?? '').match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
      if (firstKey) assignStepKey(step, firstKey[1] ?? '', firstKey[2] ?? '');
      continue;
    }
    if (!step) continue;

    const stepKey = raw.match(/^ {8}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (stepKey) {
      const key = stepKey[1] ?? '';
      const value = (stepKey[2] ?? '').trim();
      if (key === 'with') {
        block = 'with';
        continue;
      }
      assignStepKey(step, key, value);
      block = key === 'run' && (value === '|' || value === '>') ? 'run' : null;
      continue;
    }

    const subKey = raw.match(/^ {10}([A-Za-z0-9_-]+):\s*(.*)$/);
    if (block === 'with' && subKey) {
      step.with[subKey[1] ?? ''] = unquote((subKey[2] ?? '').trim());
      continue;
    }
    // A deeper line belongs to the current `run:` body. Shell comment lines
    // are dropped: a commented-out command is not a command and must never
    // satisfy a presence assertion.
    if (block === 'run' && /^\s{10,}\S/.test(raw)) {
      const body = raw.trim();
      if (!body.startsWith('#')) step.run += (step.run ? '\n' : '') + body;
    }
  }

  flushStep();
  if (job) jobs.push(job);
  return jobs;
}

/** A `run:` body's executable lines — blanks and shell comments are not commands. */
function executableLines(run: string): string[] {
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((text) => text.length > 0 && !text.startsWith('#'));
}

/* ------------------------------------------------------------------- guards */

function packSmokeJob(workflow: string): Job | undefined {
  return parseJobs(workflow).find((job) => job.key === 'pack-smoke');
}

function smokeStep(job: Job | undefined): Step | undefined {
  return job?.steps.find((step) =>
    executableLines(step.run).some((line) => line.trim() === SMOKE_COMMAND),
  );
}

/** G1 — the job exists, on the runner the repo pins, with a bounded timeout. */
function hasPackSmokeJob(workflow: string): boolean {
  const job = packSmokeJob(workflow);
  return job !== undefined && job.runsOn === 'ubuntu-22.04' && job.timeoutMinutes === '15';
}

/** G2 — setup-node is pinned to the floor the manifest declares. */
function pinsNodeFloor(workflow: string, floor: number): boolean {
  const step = packSmokeJob(workflow)?.steps.find((candidate) =>
    candidate.uses.startsWith('actions/setup-node'),
  );
  return step?.with['node-version'] === String(floor);
}

/** G3 — the build runs before the smoke; a smoke without a build packs nothing. */
function buildsBeforeSmoke(workflow: string): boolean {
  const job = packSmokeJob(workflow);
  const build = job?.steps.find((step) => step.run.trim() === 'bun run build');
  const smoke = smokeStep(job);
  return build !== undefined && smoke !== undefined && build.line < smoke.line;
}

/** G4 — the smoke step cannot be skipped, and its failure is fatal. */
function smokeStepIsUnconditional(workflow: string): boolean {
  const smoke = smokeStep(packSmokeJob(workflow));
  if (!smoke) return false;
  if (smoke.if !== '' || smoke.continueOnError !== '') return false;
  return executableLines(smoke.run).some((line) => line.trim() === SMOKE_COMMAND);
}

/**
 * The variable the script installs the package under — the one whose value is
 * a path inside node_modules (e.g. `installed_main`).
 */
function installedPathVariable(lines: string[]): string | undefined {
  for (const line of lines) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=.*node_modules\//);
    const variable = match?.[1];
    if (variable) return variable;
  }
  return undefined;
}

/**
 * G5 — the script smokes the PACKED artifact, not the checkout.
 *
 * Every property is checked on an executable line, and each one names the
 * invocation it expects — a message that merely mentions `npm pack` (or an
 * echo of it) must not be able to satisfy the guard.
 */
function scriptSmokesThePackedArtifact(script: string): boolean {
  const lines = executableLines(script);
  const has = (pattern: RegExp): boolean => lines.some((line) => pattern.test(line));
  const installed = installedPathVariable(lines);
  if (!installed) return false;
  const runs = (flag: string): boolean => has(new RegExp(`node "\\$${installed}" ${flag}`));

  return (
    has(/npm pack .*--pack-destination/) &&
    has(/tar -tzf/) &&
    has(/npm install .*\$tarball/) &&
    runs('--help') &&
    runs('--version') &&
    !has(/\bbun\b/) &&
    !has(/\bsrc\//)
  );
}

/**
 * The line that runs `npm install` — the invocation itself, not the
 * announcement above it and not the diagnostic below it.
 */
function installCommandLine(script: string): string | undefined {
  return executableLines(script).find(
    (line) => /\bnpm install\b/.test(line) && !/^(echo|fail|printf)\b/.test(line),
  );
}

/**
 * G6 — the install is engine-strict: the node floor must BITE.
 *
 * Without it npm installs a package that needs a newer node and only warns
 * about it, so the smoke would pass on a floor the package does not
 * support. The flag belongs to the install command — a flag somewhere else
 * in the file says nothing about the install.
 */
function installIsEngineStrict(script: string): boolean {
  const line = installCommandLine(script);
  if (!line) return false;
  return /npm_config_engine_strict=true\b/.test(line) || /--engine-strict\b/.test(line);
}

/**
 * A static VALUE import of a Bun-only specifier.
 *
 * Node's ESM loader rejects the `bun:` scheme outright
 * (ERR_UNSUPPORTED_ESM_URL_SCHEME) and has no `bun` module at all, so a static
 * import of one kills the published bin before it can print anything. Two
 * forms are harmless and must not trip the guard: a DYNAMIC import, which only
 * runs where a runtime check chose it (the Node-side lock backend reaches
 * Bun's FFI exactly that way), and a type-only import, which the build erases.
 */
const STATIC_BUN_IMPORT = /^\s*import\s+(?!type\s)[^'";]*?['"](bun|bun:[^'"]*)['"]/gm;

/** The Bun-only specifiers a chunk of code statically imports. */
function staticBunImports(code: string): string[] {
  return [...code.matchAll(STATIC_BUN_IMPORT)].map((match) => match[1] ?? '');
}

/**
 * The modules under `dir` that statically import a Bun-only specifier.
 *
 * Tests may use Bun freely — only shipped code has to be runtime-agnostic —
 * so the test files are skipped.
 */
function bunImportOffenders(dir: string): string[] {
  const offenders: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') || entry.name.includes('.test.')) continue;
      // Comments may name `bun:ffi` — the ban is on importing it, not on
      // explaining it.
      const code = readFileSync(path, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      for (const specifier of staticBunImports(code)) {
        offenders.push(`${path.slice(dir.length + 1)} imports '${specifier}'`);
      }
    }
  };
  walk(dir);
  return offenders;
}

/* ---------------------------------------------------------------- mutations */

/** The raw text of one job — the lines from its key up to the next job. */
function jobText(workflow: string, key: string): string {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${key}:`);
  if (start === -1) return '';
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}[A-Za-z0-9_-]+:/.test(lines[index] ?? '')) {
      end = index;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

/** Replace text inside the pack-smoke job only — the `bun` job has the same lines. */
function mutateJob(workflow: string, from: string, to: string): string {
  const block = jobText(workflow, 'pack-smoke');
  if (!block.includes(from)) {
    throw new Error(`the pack-smoke job does not contain "${from}"`);
  }
  return workflow.replace(block, block.replace(from, to));
}

/** Move the build step after the smoke step — the smoke would pack a stale dist. */
function moveBuildAfterSmoke(workflow: string): string {
  const job = packSmokeJob(workflow);
  const build = job?.steps.find((step) => step.run.trim() === 'bun run build');
  const smoke = smokeStep(job);
  if (!job || !build || !smoke) {
    throw new Error('the pack-smoke job lost its build or smoke step');
  }
  const block = jobText(workflow, 'pack-smoke').split('\n');
  const buildStart = build.line - job.line;
  const smokeStart = smoke.line - job.line;
  const buildChunk = block.slice(buildStart, smokeStart);
  const smokeChunk = block.slice(smokeStart);
  const moved = [...block.slice(0, buildStart), ...smokeChunk, ...buildChunk].join('\n');
  return workflow.replace(jobText(workflow, 'pack-smoke'), moved);
}

/* ------------------------------------------------------- script, under stubs */

/** The real node — the stub delegates `-e` snippets to it (the script reads package.json with node). */
const REAL_NODE = Bun.which('node');

const NPM_STUB = `#!/usr/bin/env bash
# Stub npm for the pack-smoke guard:
#   pack    — writes a tarball holding the entries the test asked for
#   install — unpacks that tarball into ./node_modules/<package name>
set -uo pipefail

command_name="\${1:-}"
shift || true

case "$command_name" in
  pack)
    destination=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --pack-destination)
          destination="\${2:-}"
          shift 2
          ;;
        *)
          shift
          ;;
      esac
    done
    if [ -z "$destination" ]; then
      echo "stub npm pack: --pack-destination is required" >&2
      exit 2
    fi
    stage=$(mktemp -d)
    while IFS= read -r entry; do
      [ -n "$entry" ] || continue
      mkdir -p "$stage/$(dirname "$entry")"
      printf '// stub file\\n' > "$stage/$entry"
    done <<< "$STUB_TARBALL_ENTRIES"
    tar -czf "$destination/$STUB_TARBALL_NAME" -C "$stage" package
    rm -rf "$stage"
    echo "$STUB_TARBALL_NAME"
    ;;
  install)
    tarball=""
    engine_strict=false
    if [ "\${npm_config_engine_strict:-}" = "true" ]; then
      engine_strict=true
    fi
    for argument in "$@"; do
      case "$argument" in
        --engine-strict) engine_strict=true ;;
        -*) ;;
        *)
          if [ -z "$tarball" ]; then
            tarball="$argument"
          fi
          ;;
      esac
    done
    if [ -z "$tarball" ]; then
      echo "stub npm install: no tarball given" >&2
      exit 2
    fi
    # npm with engine-strict refuses a package that needs a newer node.
    # Without the strictness it installs it anyway and only warns, so the
    # floor is checked by nobody.
    if [ "$engine_strict" = true ] && [ "$STUB_NODE_MAJOR" -lt "$STUB_PACKAGE_FLOOR" ]; then
      echo "npm error code EBADENGINE" >&2
      echo "npm error package $STUB_PKG_NAME@$STUB_PKG_VERSION needs node >=$STUB_PACKAGE_FLOOR" >&2
      echo "npm error current node is v$STUB_NODE_MAJOR.0.0" >&2
      exit 1
    fi
    tar -xzf "$tarball" -C .
    mkdir -p "node_modules/$(dirname "$STUB_PKG_NAME")"
    rm -rf "node_modules/$STUB_PKG_NAME"
    mv package "node_modules/$STUB_PKG_NAME"
    ;;
  *)
    echo "stub npm: unsupported command '$command_name'" >&2
    exit 2
    ;;
esac
`;

const NODE_STUB = `#!/usr/bin/env bash
# Stub node for the pack-smoke guard:
#   node -e <code>  — the script reads package.json with it: run it for real
#   node <file> …   — the INSTALLED CLI, which the test simulates
set -uo pipefail

if [ "\${1:-}" = "-e" ]; then
  exec "$STUB_REAL_NODE" "$@"
fi

mode=""
for argument in "$@"; do
  case "$argument" in
    --help) mode=help ;;
    --version) mode=version ;;
  esac
done

case "$mode" in
  help) printf 'ui-debugger-mcp - autonomous UI debugger (MCP server)\\n' ;;
  version) printf 'ui-debugger-mcp v%s\\n' "$STUB_NODE_VERSION" ;;
esac
exit "\${STUB_NODE_EXIT:-0}"
`;

/** The tarball name npm gives this package. */
function tarballName(): string {
  return `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`;
}

/** The paths the packed tarball must carry: the manifest's bin + exports targets. */
function manifestEntries(): string[] {
  const binMap: Record<string, string> =
    typeof pkg.bin === 'string' ? { main: pkg.bin } : (pkg.bin ?? {});
  const exportMap: Record<string, string | Record<string, string>> = pkg.exports ?? {};
  const targets = [
    ...Object.values(binMap),
    ...Object.values(exportMap).flatMap((value) =>
      typeof value === 'string' ? [value] : Object.values(value),
    ),
    'package.json',
  ];
  return targets.map((target) => `package/${target.replace(/^\.\//, '')}`);
}

interface SmokeOptions {
  /** The paths the stub npm packs into the tarball. */
  entries: string[];
  /** The exit code the stub node gives the installed CLI. */
  nodeExit?: number;
  /** The script under test — the mutation tests run a broken copy of it. */
  script?: string;
  /** The node major the stubbed install believes it runs on. */
  nodeMajor?: number;
  /** The node floor the packed package declares. */
  packageFloor?: number;
}

/**
 * The script to run: the repo's own, or a mutated copy in a tree of its own.
 *
 * The script reads package.json from the directory above its own, so a copy
 * gets a copy of the manifest beside it — the mutation runs exactly like the
 * original, only broken.
 */
function resolveScriptPath(dir: string, script: string | undefined): string {
  if (script === undefined) return join(REPO_ROOT, 'bin/smoke-packed');
  const tree = join(dir, 'tree');
  mkdirSync(join(tree, 'bin'), { recursive: true });
  writeFileSync(join(tree, 'package.json'), readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  writeFileSync(join(tree, 'bin', 'smoke-packed'), script, { mode: 0o755 });
  return join(tree, 'bin', 'smoke-packed');
}

function runSmoke(options: SmokeOptions): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  if (!REAL_NODE) {
    throw new Error('node is required — the smoke script reads package.json with node');
  }
  const dir = mkdtempSync(join(tmpdir(), 'pack-smoke-'));
  try {
    const bin = join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'npm'), NPM_STUB, { mode: 0o755 });
    writeFileSync(join(bin, 'node'), NODE_STUB, { mode: 0o755 });
    const result = spawnSync('/bin/bash', [resolveScriptPath(dir, options.script)], {
      cwd: REPO_ROOT,
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? tmpdir(),
        STUB_TARBALL_NAME: tarballName(),
        STUB_TARBALL_ENTRIES: options.entries.join('\n'),
        STUB_PKG_NAME: pkg.name,
        STUB_PKG_VERSION: pkg.version,
        STUB_NODE_VERSION: pkg.version,
        STUB_NODE_EXIT: String(options.nodeExit ?? 0),
        STUB_NODE_MAJOR: String(options.nodeMajor ?? FLOOR),
        STUB_PACKAGE_FLOOR: String(options.packageFloor ?? FLOOR),
        STUB_REAL_NODE: REAL_NODE,
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/* ------------------------------------------------------------------- tests */

test('the workflow has a pack-smoke job on the pinned runner', () => {
  expect(hasPackSmokeJob(workflowText)).toBe(true);

  // Mutation: the job is renamed — the packed path stops being gated.
  expect(hasPackSmokeJob(workflowText.replace('  pack-smoke:', '  pack-smoke-renamed:'))).toBe(
    false,
  );
  // Mutation: the job runs somewhere else.
  expect(
    hasPackSmokeJob(mutateJob(workflowText, 'runs-on: ubuntu-22.04', 'runs-on: macos-latest')),
  ).toBe(false);
  // Mutation: the job loses its ceiling.
  expect(
    hasPackSmokeJob(mutateJob(workflowText, 'timeout-minutes: 15', 'timeout-minutes: 360')),
  ).toBe(false);
});

test('the pack-smoke job pins setup-node to the floor the manifest declares', () => {
  expect(pinsNodeFloor(workflowText, FLOOR)).toBe(true);

  // Mutation: the job runs the smoke on the dev node instead of the floor.
  expect(
    pinsNodeFloor(mutateJob(workflowText, 'node-version: "20"', 'node-version: "24"'), FLOOR),
  ).toBe(false);
  // Mutation: setup-node is dropped from the job.
  expect(
    pinsNodeFloor(mutateJob(workflowText, '      - uses: actions/setup-node@v4\n', ''), FLOOR),
  ).toBe(false);
  // Mutation: the manifest raises the floor — ci.yml has to follow, or the job
  // stops testing the declared floor.
  const raised = nodeFloor(
    pkg.engines?.node?.replace(/\d+/, (digits) => String(Number(digits) + 2)),
  );
  expect(raised).toBe(FLOOR + 2);
  expect(pinsNodeFloor(workflowText, raised)).toBe(false);
});

test('the pack-smoke job builds before it smokes the packed artifact', () => {
  expect(buildsBeforeSmoke(workflowText)).toBe(true);

  // Mutation: the smoke runs first — it would pack a stale (or missing) dist.
  expect(buildsBeforeSmoke(moveBuildAfterSmoke(workflowText))).toBe(false);
  // Mutation: the build is gone.
  expect(
    buildsBeforeSmoke(
      mutateJob(workflowText, '      - name: build\n        run: bun run build\n', ''),
    ),
  ).toBe(false);
});

test('the smoke step runs unconditionally and cannot be made non-fatal', () => {
  expect(smokeStepIsUnconditional(workflowText)).toBe(true);

  // Mutation: the step is skipped.
  expect(
    smokeStepIsUnconditional(
      mutateJob(
        workflowText,
        '      - name: smoke the packed artifact\n',
        `      - name: smoke the packed artifact\n        if: \${{ false }}\n`,
      ),
    ),
  ).toBe(false);
  // Mutation: the step's failure is swallowed.
  expect(
    smokeStepIsUnconditional(
      mutateJob(
        workflowText,
        '      - name: smoke the packed artifact\n',
        '      - name: smoke the packed artifact\n        continue-on-error: true\n',
      ),
    ),
  ).toBe(false);
  // Mutation: the command is commented out — the step would run nothing.
  expect(
    smokeStepIsUnconditional(
      mutateJob(
        workflowText,
        '        run: bash bin/smoke-packed\n',
        '        run: |\n          # bash bin/smoke-packed\n',
      ),
    ),
  ).toBe(false);
});

test('the script smokes the packed artifact, not the checkout', () => {
  expect(scriptSmokesThePackedArtifact(scriptText)).toBe(true);

  // Mutation: the script stops packing — nothing would be installed.
  expect(
    scriptSmokesThePackedArtifact(
      scriptText.replace('npm pack --pack-destination', 'npm run pack --pack-destination'),
    ),
  ).toBe(false);
  // Mutation: the script stops reading the tarball.
  expect(scriptSmokesThePackedArtifact(scriptText.replace('tar -tzf', 'tar -tzvf'))).toBe(false);
  // Mutation: the script runs bun instead of node.
  expect(
    scriptSmokesThePackedArtifact(
      scriptText.replace('node "$installed_main"', 'bun "$installed_main"'),
    ),
  ).toBe(false);
  // Mutation: the script runs the repo's own sources instead of the installed copy.
  expect(scriptSmokesThePackedArtifact(scriptText.replace('node_modules/', 'src/'))).toBe(false);
});

test('the script installs engine-strict, so an incompatible package cannot land', () => {
  expect(installIsEngineStrict(scriptText)).toBe(true);

  // Mutation: the flag is deleted — npm's default installs a package that
  // needs a newer node and only warns about it.
  expect(installIsEngineStrict(scriptText.replace('npm_config_engine_strict=true ', ''))).toBe(
    false,
  );
  // Mutation: the strictness is switched off.
  expect(
    installIsEngineStrict(
      scriptText.replace('npm_config_engine_strict=true', 'npm_config_engine_strict=false'),
    ),
  ).toBe(false);
  // Mutation: the flag moves to a line that is not the install — the install
  // itself would no longer be strict.
  expect(
    installIsEngineStrict(
      scriptText
        .replace('npm_config_engine_strict=true npm install', 'npm install')
        .replace(
          'echo "==> npm install into an empty directory"',
          'echo "==> npm install into an empty directory (npm_config_engine_strict=true)"',
        ),
    ),
  ).toBe(false);
});

test('no shipped module statically imports a Bun-only specifier — the published bin loads on Node', () => {
  // The half of the runtime-agnostic rule `src/index.test.ts` cannot see: it
  // bans `Bun.` GLOBALS, but a Bun-only MODULE (`bun:ffi`) is just as fatal and
  // slips past it. The published bin runs behind `#!/usr/bin/env node`, and
  // node's ESM loader refuses the `bun:` scheme outright — the installed copy
  // dies with ERR_UNSUPPORTED_ESM_URL_SCHEME before it can print its help.
  expect(bunImportOffenders(SRC_ROOT)).toEqual([]);

  // Mutation: the walk MUST notice a static Bun-only import — that is the
  // text this guard exists to reject.
  const dir = mkdtempSync(join(tmpdir(), 'bun-import-'));
  try {
    writeFileSync(
      join(dir, 'offender.ts'),
      "import { dlopen } from 'bun:ffi';\nexport const open = dlopen;\n",
    );
    writeFileSync(
      join(dir, 'clean.ts'),
      "import { readFileSync } from 'node:fs';\nexport const read = readFileSync;\n",
    );
    expect(bunImportOffenders(dir)).toEqual(["offender.ts imports 'bun:ffi'"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // Mutation: a dynamic import is not fatal — it runs only where a runtime
  // check chose it (the Node-side lock backend reaches Bun's FFI that way).
  expect(staticBunImports("const ffi = await import('bun:ffi');")).toEqual([]);
  // Mutation: a type-only import is erased by the build, so it never reaches
  // the artifact.
  expect(staticBunImports("import type { dlopen } from 'bun:ffi';")).toEqual([]);
  // Mutation: the text quoted inside a string is not an import statement.
  expect(staticBunImports('const note = "import x from \'bun:ffi\'";')).toEqual([]);
});

describe('bin/smoke-packed, executed against a stub npm and a stub node', () => {
  test('a tarball carrying the manifest targets passes', () => {
    const result = runSmoke({ entries: manifestEntries() });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('packed artifact OK');
  });

  test('a tarball without the manifest bin target fails loud, naming it', () => {
    const entries = manifestEntries().filter((entry) => !entry.endsWith('dist/main.js'));
    const result = runSmoke({ entries });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).toContain('package/dist/main.js');
  });

  test('a tarball without the manifest exports target fails loud, naming it', () => {
    const entries = manifestEntries().filter((entry) => !entry.endsWith('dist/index.js'));
    const result = runSmoke({ entries });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('::error::');
    expect(result.stderr).toContain('package/dist/index.js');
  });

  test('an installed CLI that exits non-zero fails the smoke', () => {
    const result = runSmoke({ entries: manifestEntries(), nodeExit: 3 });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('::error::');
  });

  test('a package that needs a newer node fails the install and the smoke', () => {
    const result = runSmoke({
      entries: manifestEntries(),
      nodeMajor: FLOOR - 2,
      packageFloor: FLOOR,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('::error::');
    // The install itself is what refused the package, and the script names
    // the tarball it could not install.
    expect(result.stderr).toContain('EBADENGINE');
    expect(result.stderr).toContain(tarballName());
  });

  test('the engine-strict flag is what makes the node floor bite', () => {
    // The same scenario without the flag: npm's default installs a package
    // that needs a newer node and only warns — the smoke passes and the
    // floor is checked by nobody. The flag is what prevents that.
    const withoutFlag = scriptText.replace(
      'npm_config_engine_strict=true npm install',
      'npm install',
    );
    const result = runSmoke({
      entries: manifestEntries(),
      nodeMajor: FLOOR - 2,
      packageFloor: FLOOR,
      script: withoutFlag,
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('packed artifact OK');
    expect(result.stderr).not.toContain('EBADENGINE');
  });
});
