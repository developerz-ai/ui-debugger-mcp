/**
 * Source-level guard for the `satisfies` pins on the output schemas.
 *
 * Every schema in `output.ts` is pinned to the service interface it mirrors
 * with `satisfies z.ZodType<...>`, so a rename in `debug-service.ts` fails
 * typecheck AT the schema that drifted. The pins are compile-time only — they
 * change no runtime shape — so this guard reads the source and checks that
 * each schema carries its OWN pin on its own declaration, the nested ones
 * included: the enclosing schema's pin says nothing about the schemas nested
 * inside it.
 *
 * The source is a PARAMETER, so a test can feed the guard a mutated copy and
 * prove it fails: a removed pin, a renamed declaration, a wrong type
 * argument, a schema added without a pin. A declaration the guard cannot
 * locate is an ERROR — never a skipped assertion.
 */
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as output from './output.js';

const source = readFileSync(new URL('./output.ts', import.meta.url), 'utf8');

/** The schemas this module declares, and the service interface each pins to. */
const EXPECTED_PINS: ReadonlyArray<readonly [schema: string, pinnedType: string]> = [
  ['TargetInfoSchema', 'TargetInfo'],
  ['RunInfoSchema', 'RunInfo'],
  ['StartResultSchema', 'StartResult'],
  ['AckSchema', 'Ack'],
  ['DescribeResultSchema', 'DescribeResult'],
];

/**
 * The index of the `;` that ends the statement starting at `from`, or -1.
 *
 * Bracket depth decides: the `;` closing the schema's object literal is not
 * the end of the declaration. Quoted text and comments are skipped, so a `;`
 * inside a `.describe('…')` string cannot end the statement early.
 */
function statementEnd(text: string, from: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === undefined) break;
    if (quote !== null) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      const newline = text.indexOf('\n', i);
      if (newline === -1) break;
      i = newline;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (ch === '(' || ch === '{' || ch === '[') {
      depth++;
    } else if (ch === ')' || ch === '}' || ch === ']') {
      depth--;
    } else if (ch === ';' && depth === 0) {
      return i;
    }
  }
  return -1;
}

/**
 * The declaration statement of `name` in `text`, or '' when it cannot be
 * located. '' makes the caller FAIL — a guard that skips its own assertions
 * is worse than no guard.
 */
function declarationOf(text: string, name: string): string {
  const marker = new RegExp(`(?:^|\\n)(?:export\\s+)?const\\s+${name}\\s*=`);
  const match = marker.exec(text);
  if (!match) return '';
  const start = match.index + match[0].length;
  const end = statementEnd(text, start);
  if (end === -1) return '';
  return text.slice(start, end);
}

/** The interface a declaration's own pin names, or null when it has no pin. */
function pinTypeOf(declaration: string): string | null {
  const match = /satisfies\s+z\.ZodType<\s*([A-Za-z_$][\w$]*)\s*>\s*$/.exec(declaration);
  return match?.[1] ?? null;
}

/** Every `const <name>Schema =` declaration in `text`. */
function declaredSchemas(text: string): string[] {
  const names: string[] = [];
  const marker = /(?:^|\n)\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*Schema)\s*=/g;
  for (const match of text.matchAll(marker)) {
    const name = match[1];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * Assert every schema declaration in `text` carries its OWN direct
 * `satisfies z.ZodType<...>` pin.
 *
 * Throws on any drift: a declaration it cannot locate, a schema with no pin,
 * or a pin naming the wrong interface. The text is a PARAMETER, so a test can
 * feed it a mutated copy and prove the guard fails.
 */
function assertSchemaPins(text: string): void {
  const problems: string[] = [];

  for (const [schema, pinnedType] of EXPECTED_PINS) {
    const declaration = declarationOf(text, schema);
    if (declaration === '') {
      problems.push(`${schema}: the declaration cannot be located`);
      continue;
    }
    const actual = pinTypeOf(declaration);
    if (actual === null) {
      problems.push(`${schema}: it carries no direct \`satisfies z.ZodType<...>\` pin`);
    } else if (actual !== pinnedType) {
      problems.push(`${schema}: it is pinned to ${actual}, not ${pinnedType}`);
    }
  }

  // A schema nobody named above still has to carry a pin of its own.
  for (const schema of declaredSchemas(text)) {
    if (EXPECTED_PINS.some(([name]) => name === schema)) continue;
    if (pinTypeOf(declarationOf(text, schema)) === null) {
      problems.push(`${schema}: it carries no direct \`satisfies z.ZodType<...>\` pin`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`output.ts schema pins are wrong:\n  - ${problems.join('\n  - ')}`);
  }
}

test('every output schema carries its own direct satisfies pin', () => {
  assertSchemaPins(source);
});

test('the pin guard rejects a source with a pin removed', () => {
  for (const [schema, pinnedType] of EXPECTED_PINS) {
    const mutated = source.replace(`}) satisfies z.ZodType<${pinnedType}>;`, '});');
    expect(mutated).not.toBe(source); // the mutation actually applied
    expect(() => assertSchemaPins(mutated)).toThrow(new RegExp(schema));
  }
});

test('the pin guard fails when a declaration cannot be located', () => {
  const mutated = source.replace('const TargetInfoSchema =', 'const RenamedTargetInfoSchema =');
  expect(mutated).not.toBe(source);
  expect(() => assertSchemaPins(mutated)).toThrow(
    /TargetInfoSchema: the declaration cannot be located/,
  );
});

test('the pin guard rejects a pin that names the wrong interface', () => {
  const mutated = source.replace('satisfies z.ZodType<TargetInfo>', 'satisfies z.ZodType<RunInfo>');
  expect(mutated).not.toBe(source);
  expect(() => assertSchemaPins(mutated)).toThrow(
    /TargetInfoSchema: it is pinned to RunInfo, not TargetInfo/,
  );
});

test('the pin guard rejects a schema declaration that carries no pin', () => {
  const mutated = `${source}\nconst ExtraSchema = z.object({ a: z.string() });\n`;
  expect(() => assertSchemaPins(mutated)).toThrow(
    /ExtraSchema: it carries no direct `satisfies z\.ZodType<\.\.\.>` pin/,
  );
});

test('the nested schemas stay module-private', () => {
  expect('TargetInfoSchema' in output).toBe(false);
  expect('RunInfoSchema' in output).toBe(false);
  expect('StartResultSchema' in output).toBe(true);
  expect('AckSchema' in output).toBe(true);
  expect('DescribeResultSchema' in output).toBe(true);
});

test('the describe output still parses a target and a run', () => {
  const parsed = output.DescribeResultSchema.parse({
    targets: [
      {
        name: 'web',
        adapter: 'browser',
        mode: 'managed',
        operational: true,
        url: 'http://localhost:3000',
        headless: true,
      },
    ],
    models: { driver: 'deepseek', vision: 'qwen', summary: 'qwen' },
    workspace: '/tmp/ui-debugger-mcp',
    session: { id: '2026-07-27_14-30-05-0001', status: 'running', goal: 'make it work' },
  });
  expect(parsed.targets[0]?.adapter).toBe('browser');
  expect(parsed.session?.status).toBe('running');
});
