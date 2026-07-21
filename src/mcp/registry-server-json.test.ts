/**
 * `server.json` (repo root) — the MCP Registry metadata file `mcp-publisher publish`
 * submits — must validate against its own declared `$schema`. Registry submission
 * fails loud on drift there, not at `bun test` time, so this pins a fetched schema
 * fixture (`fixtures/server.schema.json`, draft-07, MCP Registry `2025-12-11`) and
 * validates the real file against it on every run.
 *
 * Keep the fixture and `server.json`'s `$schema` field in sync: if the registry
 * ships a new schema version, refetch the fixture and bump both.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const REPO_ROOT = join(import.meta.dirname, '../..');

const serverJson = JSON.parse(readFileSync(join(REPO_ROOT, 'server.json'), 'utf8'));
const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures/server.schema.json'), 'utf8'),
);

/** Draft-07 validator with the `uri`/`email`/etc. formats the schema relies on. */
function schemaValidator(): Ajv {
  const ajv = new Ajv({ strict: false });
  addFormats(ajv);
  return ajv;
}

test('server.json declares the pinned schema fixture', () => {
  expect(serverJson.$schema).toBe(schema.$id);
});

test('server.json validates against its $schema', () => {
  const validate = schemaValidator().compile(schema);
  const valid = validate(serverJson);

  expect(validate.errors, JSON.stringify(validate.errors, null, 2)).toBeNull();
  expect(valid).toBe(true);
});

test('a malformed server.json fails the same validator (fixture is not a rubber stamp)', () => {
  const validate = schemaValidator().compile(schema);

  // Missing required `version`, and `name` without the required reverse-DNS slash.
  const bad = { name: 'not-reverse-dns', description: 'x' };
  expect(validate(bad)).toBe(false);
});

test('a description over the 100-char cap fails validation', () => {
  const validate = schemaValidator().compile(schema);
  const bad = { ...serverJson, description: 'x'.repeat(101) };
  expect(validate(bad)).toBe(false);
});
