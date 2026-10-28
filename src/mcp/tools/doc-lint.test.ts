/**
 * Doc-lint guard: the three documents that describe the OUTER MCP catalog must
 * agree with the live catalog — tool names, MCP annotations and input params.
 *
 * The live catalog is the only authority. `outerTools()` is registered against
 * a stub `McpServer` and the guard reads back what each tool DECLARES (the SDK
 * keeps a tool's config verbatim — it fills no annotation defaults). Nothing
 * here restates a tool name, an annotation or a parameter list: a restatement
 * would be exactly the drift this guard exists to kill.
 *
 * Every check is anchored to one exact table header, so an unrelated table (the
 * inner-belt table in docs/idea/mcp-tools.md, the findings tables in
 * docs/reference.md) can never pass itself off as the outer catalog. Sets are
 * compared, not sequences — the documents order their tables differently.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { DebugApi } from '../../services/debug-service.js';
import { outerTools } from './index.js';

const ROOT = join(import.meta.dir, '../../..');

/** What the live catalog declares for one outer tool. */
interface CatalogTool {
  readonly name: string;
  readonly annotations: Readonly<Record<string, boolean>>;
  readonly params: readonly string[];
}

/** The part of a registered tool's config the guard reads. */
interface RegisteredTool {
  readonly annotations?: Record<string, boolean>;
  readonly inputSchema?: Record<string, unknown>;
}

/**
 * The live catalog: every outer tool's name, declared annotations and raw
 * Zod input keys, read off the real tools at runtime.
 */
function liveCatalog(): CatalogTool[] {
  const registry = new Map<string, RegisteredTool>();
  const server = {
    registerTool(name: string, config: RegisteredTool) {
      registry.set(name, config);
    },
  } as unknown as McpServer;
  for (const tool of outerTools({} as unknown as DebugApi)) tool.register(server);
  return [...registry].map(([name, config]) => ({
    name,
    annotations: config.annotations ?? {},
    params: Object.keys(config.inputSchema ?? {}),
  }));
}

const CATALOG = liveCatalog();

const REFERENCE_TEXT = readFileSync(join(ROOT, 'docs/reference.md'), 'utf8');
const README_TEXT = readFileSync(join(ROOT, 'README.md'), 'utf8');
const IDEA_TEXT = readFileSync(join(ROOT, 'docs/idea/mcp-tools.md'), 'utf8');

// --- markdown parsing --------------------------------------------------------

/** Split a markdown table row into its trimmed cells. */
function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/** Strip markdown code ticks and surrounding space. */
function unquote(text: string): string {
  return text.replace(/`/g, '').trim();
}

/** True for a markdown separator row (`|---|---|`). */
function isSeparator(row: readonly string[]): boolean {
  return row.every((cell) => /^:?-{2,}:?$/.test(cell));
}

/**
 * The body rows of the FIRST table whose header cells equal `header`.
 *
 * The header is the anchor: only the table under it is ever read, so no
 * unrelated table can be mistaken for the outer catalog.
 */
function tableRows(text: string, header: readonly string[]): string[][] {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => {
    if (!line.trim().startsWith('|')) return false;
    const row = cells(line);
    return row.length === header.length && row.every((cell, i) => cell === header[i]);
  });
  if (start === -1) return [];
  const rows: string[][] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim().startsWith('|')) break;
    const row = cells(line);
    if (!isSeparator(row)) rows.push(row);
  }
  return rows;
}

/** The `## Outer MCP Tools` section of docs/reference.md (ends before Findings Schema). */
function referenceSection(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## Outer MCP Tools');
  if (start === -1) return null;
  const end = lines.findIndex((line, i) => i > start && line.trim() === '## Findings Schema');
  return lines.slice(start, end === -1 ? lines.length : end).join('\n');
}

/** The `### \`tool\`` subsections of the reference's outer-tools section. */
function referenceSubsections(section: string): Array<{ title: string; body: string }> {
  const found: Array<{ title: string; body: string }> = [];
  let current: { title: string; body: string } | null = null;
  for (const line of section.split('\n')) {
    const heading = line.match(/^###\s+`([^`]+)`\s*$/);
    const title = heading?.[1];
    if (title !== undefined) {
      if (current) found.push(current);
      current = { title, body: '' };
      continue;
    }
    if (current) current.body += `${line}\n`;
  }
  if (current) found.push(current);
  return found;
}

/** Parse a `\`readOnlyHint: true\`, \`destructiveHint: false\`` cell into a map. */
function parseAnnotations(cell: string): Record<string, boolean> {
  const annotations: Record<string, boolean> = {};
  for (const entry of cell.split(',')) {
    const [rawKey, rawValue] = unquote(entry)
      .split(':')
      .map((part) => part.trim());
    if (!rawKey || rawValue === undefined) continue;
    annotations[rawKey] = rawValue === 'true';
  }
  return annotations;
}

/** The first inline code span in a cell, or '' when the cell has none. */
function firstCodeSpan(cell: string): string {
  return cell.match(/`([^`]+)`/)?.[1] ?? '';
}

/** Every `{ … }` group in a cell, in order. */
function braceGroups(cell: string): string[] {
  return [...cell.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? '');
}

/** The `{ … }` group inside a code span, or null when the span is not one. */
function braceGroup(span: string): string | null {
  return span.match(/^\{([^{}]*)\}$/)?.[1] ?? null;
}

/** The parameter names in a brace group — `goal?` is the optional `goal`. */
function shapeNames(group: string): string[] {
  return group
    .split(',')
    .map((part) => part.trim().replace(/\?$/, ''))
    .filter((name) => name.length > 0);
}

/** The union of the parameter names in every brace group of a cell. */
function cellShapeNames(cell: string): string[] {
  const names = new Set<string>();
  for (const group of braceGroups(cell)) {
    for (const name of shapeNames(group)) names.add(name);
  }
  return [...names];
}

/** The `*Hint` names the README lists beside its "MCP annotations" sentence. */
function readmeHintNames(text: string): string[] {
  const anchor = text.indexOf('MCP annotations');
  if (anchor === -1) return [];
  const window = text.slice(anchor, anchor + 300);
  return [...window.matchAll(/`([A-Za-z][A-Za-z0-9]*Hint)`/g)].map((match) => match[1] ?? '');
}

/**
 * Set drift between what a document lists and what the live catalog has.
 * Both directions: a documented name that is not live fails, and a live name
 * missing from the document fails.
 */
function setDrift(label: string, documented: Iterable<string>, live: Iterable<string>): string[] {
  const doc = new Set(documented);
  const act = new Set(live);
  const problems: string[] = [];
  for (const name of doc) {
    if (!act.has(name)) problems.push(`${label}: "${name}" is documented but not live`);
  }
  for (const name of act) {
    if (!doc.has(name)) problems.push(`${label}: live "${name}" is not documented`);
  }
  return problems;
}

// --- the three documents -----------------------------------------------------

/** Problems in docs/reference.md: its annotations table and its param tables. */
function lintReference(text: string, catalog: readonly CatalogTool[]): string[] {
  const problems: string[] = [];
  const live = new Map(catalog.map((tool) => [tool.name, tool]));

  const annotationRows = tableRows(text, ['Tool', 'Annotations']);
  if (annotationRows.length !== catalog.length) {
    problems.push(
      `docs/reference.md: annotations table has ${annotationRows.length} rows, expected ${catalog.length}`,
    );
  }
  const documented = new Map<string, Record<string, boolean>>();
  for (const row of annotationRows) {
    const name = unquote(row[0] ?? '');
    if (name.length === 0) continue;
    documented.set(name, parseAnnotations(row[1] ?? ''));
  }
  problems.push(...setDrift('docs/reference.md annotations table', documented.keys(), live.keys()));
  for (const [name, annotations] of documented) {
    const tool = live.get(name);
    if (!tool) continue;
    for (const [key, value] of Object.entries(annotations)) {
      const declared = tool.annotations[key];
      if (declared === undefined) {
        problems.push(
          `docs/reference.md: "${name}" documents annotation "${key}", which it does not declare`,
        );
      } else if (declared !== value) {
        problems.push(
          `docs/reference.md: "${name}" annotation "${key}" is documented as ${value}, live declares ${declared}`,
        );
      }
    }
    for (const key of Object.keys(tool.annotations)) {
      if (!(key in annotations)) {
        problems.push(`docs/reference.md: "${name}" omits live annotation "${key}"`);
      }
    }
  }

  const section = referenceSection(text);
  if (section === null) {
    problems.push('docs/reference.md: no "## Outer MCP Tools" section');
    return problems;
  }
  const params = new Map<string, string[]>();
  for (const subsection of referenceSubsections(section)) {
    const rows = tableRows(subsection.body, ['Param', 'Type', 'Required', 'Description']);
    if (rows.length === 0) continue;
    params.set(
      subsection.title,
      rows.map((row) => unquote(row[0] ?? '')).filter((name) => name.length > 0),
    );
  }
  if (params.size !== catalog.length) {
    problems.push(`docs/reference.md: ${params.size} param tables, expected ${catalog.length}`);
  }
  problems.push(...setDrift('docs/reference.md param tables', params.keys(), live.keys()));
  for (const [name, names] of params) {
    const tool = live.get(name);
    if (!tool) continue;
    problems.push(...setDrift(`docs/reference.md params of "${name}"`, names, tool.params));
  }
  return problems;
}

/** Problems in README.md: its tool table, its input shape and its hint names. */
function lintReadme(text: string, catalog: readonly CatalogTool[]): string[] {
  const problems: string[] = [];
  const live = new Map(catalog.map((tool) => [tool.name, tool]));

  const rows = tableRows(text, ['Tool', 'What it does']);
  if (rows.length !== catalog.length) {
    problems.push(`README.md: tool table has ${rows.length} rows, expected ${catalog.length}`);
  }
  const names = rows.map((row) => unquote(row[0] ?? '')).filter((name) => name.length > 0);
  problems.push(...setDrift('README.md tool table', names, live.keys()));

  // The input shape: a row's FIRST inline code span, when that span is a brace
  // group. A row whose first code span is prose (`wait`, `personas[]`) carries
  // no shape and is skipped — the shape is what the row leads with.
  let shapes = 0;
  for (const row of rows) {
    const name = unquote(row[0] ?? '');
    const tool = live.get(name);
    if (!tool) continue;
    const group = braceGroup(firstCodeSpan(row[1] ?? ''));
    if (group === null) continue;
    shapes += 1;
    problems.push(
      ...setDrift(`README.md input shape of "${name}"`, shapeNames(group), tool.params),
    );
  }
  if (shapes === 0) problems.push('README.md: no row documents an input shape');

  const hints = readmeHintNames(text);
  if (hints.length === 0) problems.push('README.md: no MCP annotation names found');
  const declared = new Set(catalog.flatMap((tool) => Object.keys(tool.annotations)));
  problems.push(...setDrift('README.md annotation names', hints, declared));

  return problems;
}

/** Problems in docs/idea/mcp-tools.md: its outer-tool table and its Input column. */
function lintIdea(text: string, catalog: readonly CatalogTool[]): string[] {
  const problems: string[] = [];
  const live = new Map(catalog.map((tool) => [tool.name, tool]));

  const rows = tableRows(text, ['Tool', 'Input', 'Returns']);
  if (rows.length !== catalog.length) {
    problems.push(
      `docs/idea/mcp-tools.md: outer table has ${rows.length} rows, expected ${catalog.length}`,
    );
  }
  const names = rows.map((row) => unquote(row[0] ?? '')).filter((name) => name.length > 0);
  problems.push(...setDrift('docs/idea/mcp-tools.md outer table', names, live.keys()));

  for (const row of rows) {
    const name = unquote(row[0] ?? '');
    const tool = live.get(name);
    if (!tool) continue;
    problems.push(
      ...setDrift(
        `docs/idea/mcp-tools.md input of "${name}"`,
        cellShapeNames(row[1] ?? ''),
        tool.params,
      ),
    );
  }
  return problems;
}

// --- the guard ---------------------------------------------------------------

test('the live catalog exposes the five outer tools', () => {
  expect(CATALOG).toHaveLength(5);
});

test('docs/reference.md matches the live catalog', () => {
  expect(lintReference(REFERENCE_TEXT, CATALOG)).toEqual([]);
});

test('README.md matches the live catalog', () => {
  expect(lintReadme(README_TEXT, CATALOG)).toEqual([]);
});

test('docs/idea/mcp-tools.md matches the live catalog', () => {
  expect(lintIdea(IDEA_TEXT, CATALOG)).toEqual([]);
});

test('the guard parsed its anchors: 5 tool rows, 5 param tables', () => {
  expect(tableRows(REFERENCE_TEXT, ['Tool', 'Annotations'])).toHaveLength(CATALOG.length);
  expect(tableRows(README_TEXT, ['Tool', 'What it does'])).toHaveLength(CATALOG.length);
  expect(tableRows(IDEA_TEXT, ['Tool', 'Input', 'Returns'])).toHaveLength(CATALOG.length);

  const section = referenceSection(REFERENCE_TEXT);
  expect(section).not.toBeNull();
  const paramTables = referenceSubsections(section ?? '').filter(
    (subsection) =>
      tableRows(subsection.body, ['Param', 'Type', 'Required', 'Description']).length > 0,
  );
  expect(paramTables).toHaveLength(CATALOG.length);
});

test('a renamed tool in the reference annotations table is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace('| `describe` |', '| `describe_all` |');
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('describe_all');
});

test('a flipped annotation value in the reference table is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace(
    '| `describe` | `readOnlyHint: true` |',
    '| `describe` | `readOnlyHint: false` |',
  );
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('readOnlyHint');
});

test('a renamed parameter in a reference param table is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace(
    '| `target` | `string` | no | Narrow output to a single target by name. |',
    '| `tgt` | `string` | no | Narrow output to a single target by name. |',
  );
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('tgt');
});

test('a renamed tool in the README table is reported (mutation)', () => {
  const mutated = README_TEXT.replace('| `end_session` |', '| `end_run` |');
  expect(mutated).not.toBe(README_TEXT);

  const problems = lintReadme(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('end_run');
});

test('a renamed parameter in the README input shape is reported (mutation)', () => {
  const mutated = README_TEXT.replace(
    '{ target, goal, url?, as?, replace?, criteria?, timeout? }',
    '{ target, goal, url?, as?, replace?, criterias?, timeout? }',
  );
  expect(mutated).not.toBe(README_TEXT);

  const problems = lintReadme(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('criterias');
});

test('a missing annotation name in the README is reported (mutation)', () => {
  const mutated = README_TEXT.replace('`idempotentHint`, ', '');
  expect(mutated).not.toBe(README_TEXT);

  const problems = lintReadme(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('idempotentHint');
});

test('a renamed tool in the mcp-tools.md outer table is reported (mutation)', () => {
  const mutated = IDEA_TEXT.replace(/^\| `get_findings`/m, '| `get_results`');
  expect(mutated).not.toBe(IDEA_TEXT);

  const problems = lintIdea(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('get_results');
});

test('a renamed parameter in the mcp-tools.md Input column is reported (mutation)', () => {
  const mutated = IDEA_TEXT.replace(
    '{ session_id, wait?, fields? }',
    '{ session_id, wait?, keys? }',
  );
  expect(mutated).not.toBe(IDEA_TEXT);

  const problems = lintIdea(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('keys');
});

test('a missing row in the reference annotations table is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace('| `end_session` | `idempotentHint: true` |\n', '');
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain(
    `annotations table has ${CATALOG.length - 1} rows, expected ${CATALOG.length}`,
  );
});

test('an annotation the tool does not declare is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace(
    '| `describe` | `readOnlyHint: true` |',
    '| `describe` | `readOnlyHint: true`, `idempotentHint: true` |',
  );
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain(
    'documents annotation "idempotentHint", which it does not declare',
  );
});

test('a live annotation the reference row omits is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace(
    '| `describe` | `readOnlyHint: true` |',
    '| `describe` | |',
  );
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('omits live annotation "readOnlyHint"');
});

test('a missing param table in the reference is reported (mutation)', () => {
  const mutated = REFERENCE_TEXT.replace(
    '| Param | Type | Required | Description |',
    '| Param | Type | Required | Note |',
  );
  expect(mutated).not.toBe(REFERENCE_TEXT);

  const problems = lintReference(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain(
    `${CATALOG.length - 1} param tables, expected ${CATALOG.length}`,
  );
});

test('a README row that documents no input shape is reported (mutation)', () => {
  const mutated = README_TEXT.replace(
    '{ target, goal, url?, as?, replace?, criteria?, timeout? }',
    'target, goal, url?, as?, replace?, criteria?, timeout?',
  );
  expect(mutated).not.toBe(README_TEXT);

  const problems = lintReadme(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('no row documents an input shape');
});

test('a README without MCP annotation names is reported (mutation)', () => {
  const mutated = README_TEXT.replace('MCP annotations', 'MCP metadata');
  expect(mutated).not.toBe(README_TEXT);

  const problems = lintReadme(mutated, CATALOG);
  expect(problems.length).toBeGreaterThan(0);
  expect(problems.join('\n')).toContain('no MCP annotation names found');
});
