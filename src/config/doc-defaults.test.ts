/**
 * Doc-drift guard: the default models the DOCS promise must be the ones the
 * code ships.
 *
 * `DEFAULT_MODELS` (`src/config/load.ts`) is the single source of truth for the
 * driver / vision / summary defaults. The README and `docs/idea/` repeat those
 * defaults in prose, tables and config examples — and a stale repeat is worse
 * than no repeat: a reader copies the id the docs name into their project
 * config, and the shipped default has already moved on.
 *
 * So the guard reads the corpus from disk and checks every model reference it
 * documents against `DEFAULT_MODELS`:
 *
 *  - a FULL id must equal the default exactly (`vendor/model`) — a near-miss
 *    id (`deepseek/deepseek-v4`) is a DIFFERENT model and must fail; the one
 *    `/` shorthand is a `vendor/vendor` PAIR (`deepseek/qwen`), two defaults
 *    named at once;
 *  - a shorthand must name the default's provider (`vendor`) or its model
 *    (`vendor-model`, or a prefix of it);
 *  - a reference scoped to ONE role must name THAT role's default — the
 *    driver is blind and text-only, the vision model sees pixels. A line that
 *    names no role inherits the role its BLOCK names: the docs name the role
 *    once and keep talking about it (`… the driver. … Default: deepseek.`);
 *  - a `default:` label puts the token it names in the DEFAULT slot, and a
 *    role key (`"driver": …`) puts its value in that ROLE's slot. Slot
 *    values are model references whatever their spelling: a foreign id with
 *    no digits (`anthropic/claude-sonnet`) is drift, not skipped prose.
 *
 * The ids are never written out here: they are read from `DEFAULT_MODELS`, so
 * a default change fails this guard instead of being copied into the docs by
 * hand.
 */

import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_MODELS } from './load.js';

/** The repo root — the docs that document the defaults live at its top. */
const ROOT = join(import.meta.dir, '../..');

/** The documents that document the default models. */
const CORPUS = [
  'README.md',
  'docs/idea/config.md',
  'docs/idea/models.md',
  'docs/idea/architecture.md',
] as const;

/** The roles a default model is documented for. */
const ROLES = ['driver', 'vision', 'summary'] as const;

type Role = (typeof ROLES)[number];

/** The default id per role — read from the code, never written out here. */
const DEFAULT_BY_ROLE: Record<Role, string> = {
  driver: DEFAULT_MODELS.driver,
  vision: DEFAULT_MODELS.vision,
  summary: DEFAULT_MODELS.summary,
};

/** Every default id, in role order. */
const DEFAULT_IDS: readonly string[] = ROLES.map((role) => DEFAULT_BY_ROLE[role]);

/** The provider + model segments of a default id (`vendor` + `vendor-model`). */
function segments(id: string): readonly [string, string] {
  const [provider = '', model = ''] = id.split('/');
  return [provider, model];
}

/**
 * Every known provider + model segment, as a model id writes it (lowercase) —
 * a doc may name a vendor alone instead of the full id.
 *
 * The case matters: a capitalised brand in prose (`… also works: z.ai,
 * DeepSeek, …`) is a provider list, not a documented default.
 */
const KNOWN_SEGMENTS = new Set(DEFAULT_IDS.flatMap((id) => segments(id)));

/**
 * Every default's VENDOR (provider) segment — the half of a `vendor/vendor`
 * pair a doc may name.
 */
const VENDOR_SEGMENTS = new Set(DEFAULT_IDS.map((id) => segments(id)[0].toLowerCase()));

/**
 * Does `token` name the model behind `id`? The provider alone, the model
 * alone, or any prefix of the model.
 *
 * Case-insensitive: a doc that capitalises a vendor still names that model.
 */
function namesDefault(token: string, id: string): boolean {
  const [provider, model] = segments(id);
  const low = token.toLowerCase();
  return (
    low === provider.toLowerCase() ||
    low === model.toLowerCase() ||
    model.toLowerCase().startsWith(low)
  );
}

/** Does `token` name ANY default model? */
function namesAnyDefault(token: string): boolean {
  return DEFAULT_IDS.some((id) => namesDefault(token, id));
}

/**
 * Does `token` name a default model — as a full id, or as a shorthand?
 *
 * A full id must equal a default EXACTLY: `deepseek/deepseek-v4` is a
 * DIFFERENT model from `deepseek/deepseek-v4-flash`, and a doc that names
 * it must fail. The one `/` form that is not a full id is a `vendor/vendor`
 * PAIR — two defaults named at once (`deepseek/qwen`), each side an exact
 * vendor segment.
 */
function namesADefault(token: string): boolean {
  if (!token.includes('/')) return namesAnyDefault(token);
  if (DEFAULT_IDS.includes(token)) return true;
  const parts = token.split('/');
  return parts.length === 2 && parts.every((part) => VENDOR_SEGMENTS.has(part.toLowerCase()));
}

/**
 * Does `token` name the model behind `id` — as a full id or as a shorthand?
 *
 * The role-scoped twin of {@link namesADefault}: the driver default may not
 * be satisfied by the vision model, however well that model is spelled. A
 * `/` token must be that role's id, or its vendor spelled on both sides.
 */
function namesRoleDefault(token: string, id: string): boolean {
  if (!token.includes('/')) return namesDefault(token, id);
  if (token === id) return true;
  const vendor = segments(id)[0].toLowerCase();
  const parts = token.split('/');
  return parts.length === 2 && parts.every((part) => part.toLowerCase() === vendor);
}

/** A word, optionally joined by `-`, `.` or `/` — `vendor/model`. */
const TOKEN = /[A-Za-z0-9_]+(?:[-./][A-Za-z0-9_]+)*/g;

/** A role named by a line — `driver`, `vision`, `summary`. */
const ROLE = /\b(driver|vision|summary)\b/gi;

/** A markdown list item — `- `, `* ` or `1. `. */
const LIST_ITEM = /^\s*(?:[-*]|\d+\.)\s/;

/** A fenced code block's fence. */
const FENCE = /^\s*```/;

/**
 * A block that talks about models at all — the only blocks the guard scans.
 * Prose that never mentions a role, a model or a default cannot drift.
 */
const TALKS_MODELS = /\b(?:driver|vision|summary|models?|defaults?)\b/i;

/**
 * A `default:` label — how the docs name the default model in prose.
 *
 * The word and the colon, nothing in between: a label with a qualifier
 * (`Default base URL:`) names something else entirely.
 */
const DEFAULT_LABEL = /\bdefaults?\s*:\s*$/i;

/**
 * A model name — what a `default:` label or a role key names.
 *
 * A label cannot name a duration (`Default: 300s`), so the name starts with
 * a letter. `/` joins a full id's segments: a slot names A MODEL whatever
 * its spelling, digits or none.
 */
const MODEL_NAME = /^[A-Za-z][A-Za-z0-9]*(?:[./-][A-Za-z0-9]+)*$/;

/**
 * A role slot — the value a `"driver":` / `vision:` key names.
 *
 * The config examples assign each role its model this way; the value is a
 * model reference whatever it looks like. The role word must sit right
 * before the colon, so a prose label (`Summary: the run …`) stops at its
 * colon and never swallows the words after it.
 */
const ROLE_SLOT = /["']?\b(?:driver|vision|summary)\b["']?\s*:\s*["']?$/i;

/** A segment that mixes letters and digits (`v4`, `model3`, `4o`). */
function mixesLettersAndDigits(segment: string): boolean {
  return /[a-z]/i.test(segment) && /[0-9]/.test(segment);
}

/**
 * Is this token a MODEL reference (rather than prose, a path, a port)?
 *
 * A hyphenated name that mixes letters and digits (`vendor-model`) is one; a
 * bare vendor is one only when it is a known default's segment. `X11`, `a11y`
 * and `emulator-5554` are not models, and neither is the `provider/model`
 * shape placeholder.
 */
function isModelReference(token: string): boolean {
  if (token.includes('-') && token.split(/[-./]/).some(mixesLettersAndDigits)) return true;
  const parts = token.split('/');
  if (parts.length > 1) return parts.every((part) => KNOWN_SEGMENTS.has(part));
  return KNOWN_SEGMENTS.has(token);
}

/**
 * Markdown dressing a slot check must see through — quotes, emphasis, code.
 */
const SLOT_MARKUP = /["'`*_]/g;

/**
 * Does this token sit in the DEFAULT slot — the one a `default:` label names?
 *
 * A foreign vendor written there (`Default: openai.`) is drift, not prose:
 * it is not a known segment, so the reference checks would skip it entirely.
 * The label puts the token in the slot the guard is about.
 *
 * `gap` is the text from the PREVIOUS token up to this one — the label is
 * the last thing before the token (`Default: `), so the gap ends with it.
 */
function namesDefaultSlot(gap: string, token: string): boolean {
  if (!DEFAULT_LABEL.test(gap.replace(SLOT_MARKUP, ''))) return false;
  return MODEL_NAME.test(token);
}

/**
 * Does this token sit in a ROLE slot — the value a role key names?
 *
 * A foreign model written there (`"driver": "anthropic/claude-sonnet"`) is
 * drift even though no heuristic calls its spelling a model: the key names
 * the role, and the value is that role's model reference, full stop.
 */
function namesRoleSlot(gap: string, token: string): boolean {
  if (!ROLE_SLOT.test(gap.replace(SLOT_MARKUP, ''))) return false;
  return MODEL_NAME.test(token);
}

/** A run of lines the guard scans as one unit. */
interface Block {
  /** 1-based number of the block's first line. */
  start: number;
  /** The block's lines. */
  lines: readonly string[];
}

/** A line that continues the current paragraph (not blank, not a new block). */
function isParagraphLine(line: string): boolean {
  if (line.trim() === '') return false;
  if (line.trim().startsWith('|')) return false;
  if (FENCE.test(line)) return false;
  if (LIST_ITEM.test(line)) return false;
  return true;
}

/** A line that continues the current list item — indented, non-blank. */
function isContinuation(line: string): boolean {
  return line.trim() !== '' && /^\s/.test(line) && !FENCE.test(line);
}

/**
 * Split a markdown document into blocks — the unit the guard scans.
 *
 * A fenced code block is one block, a table row is one, a list item is one
 * (with its continuation lines); everything else is a paragraph. Splitting
 * this way keeps a config example's many rows from merging into one blob.
 */
function blocks(text: string): Block[] {
  const lines = text.split('\n');
  const out: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (FENCE.test(line)) {
      const start = index;
      index += 1;
      while (index < lines.length && !FENCE.test(lines[index] ?? '')) index += 1;
      index += 1; // the closing fence
      out.push({ start: start + 1, lines: lines.slice(start, index) });
      continue;
    }
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    if (line.trim().startsWith('|')) {
      out.push({ start: index + 1, lines: [line] });
      index += 1;
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const start = index;
      index += 1;
      while (index < lines.length && isContinuation(lines[index] ?? '')) index += 1;
      out.push({ start: start + 1, lines: lines.slice(start, index) });
      continue;
    }
    const start = index;
    while (index < lines.length && isParagraphLine(lines[index] ?? '')) index += 1;
    out.push({ start: start + 1, lines: lines.slice(start, index) });
  }
  return out;
}

/** Is this string one of the roles a default model is documented for? */
function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

/** The roles a text names — one role means the model on it is THAT role's. */
function rolesIn(line: string): Role[] {
  const found = new Set<Role>();
  for (const match of line.matchAll(ROLE)) {
    const role = match[1]?.toLowerCase();
    if (role !== undefined && isRole(role)) found.add(role);
  }
  return [...found];
}

/** A model reference a document makes, with where it made it. */
interface Reference {
  /** The token as written. */
  token: string;
  /** 1-based line the token sits on. */
  line: number;
  /** The role the reference is scoped to — at most one. */
  roles: readonly Role[];
}

/**
 * The role a reference is scoped to — the line's role, else the block's.
 *
 * A line that names no role inherits the role its BLOCK names: the docs name
 * a role once and keep talking about it (`… the driver. … Default:
 * deepseek.`). Without that fallback the driver's default was never checked.
 */
function scopedRoles(lineRoles: readonly Role[], blockRoles: readonly Role[]): readonly Role[] {
  if (lineRoles.length === 1) return lineRoles;
  if (blockRoles.length === 1) return blockRoles;
  return [];
}

/** Every model reference the document makes. */
function references(text: string): Reference[] {
  const out: Reference[] = [];
  for (const block of blocks(text)) {
    const blockText = block.lines.join('\n');
    if (!TALKS_MODELS.test(blockText)) continue;
    const blockRoles = rolesIn(blockText);
    block.lines.forEach((line, offset) => {
      const roles = scopedRoles(rolesIn(line), blockRoles);
      let previousStart = 0;
      for (const match of line.matchAll(TOKEN)) {
        const token = match[0];
        const gap = line.slice(previousStart, match.index);
        previousStart = match.index;
        if (
          !isModelReference(token) &&
          !namesDefaultSlot(gap, token) &&
          !namesRoleSlot(gap, token)
        ) {
          continue;
        }
        out.push({ token, line: block.start + offset, roles });
      }
    });
  }
  return out;
}

/**
 * Assert every model the document documents is a default model.
 *
 * Throws on drift: a reference that names no default at all, or one that
 * names the WRONG role's default. The document text is a PARAMETER, so a
 * test can feed this a mutated copy and watch it throw.
 */
function assertDocumentedDefaults(file: string, text: string): void {
  const found = references(text);
  if (found.length === 0) {
    throw new Error(
      `${file}: documents no default model — the guard would check nothing (a doc edit emptied it)`,
    );
  }
  for (const reference of found) {
    if (!namesADefault(reference.token)) {
      throw new Error(
        `${file}:${reference.line} documents "${reference.token}", which is not a default model`,
      );
    }
    const role = reference.roles.length === 1 ? reference.roles[0] : undefined;
    if (role === undefined) continue;
    const id = DEFAULT_BY_ROLE[role];
    if (!namesRoleDefault(reference.token, id)) {
      throw new Error(
        `${file}:${reference.line} documents "${reference.token}" as the ${role} default, ` +
          `which is not ${id}`,
      );
    }
  }
}

/**
 * Assert the corpus pins the EXACT default ids — a full id, not a shorthand.
 *
 * Without this the guard could pass with nothing to compare against: a doc
 * edit that replaced every mention with a foreign model would leave the
 * per-document check with no reference at all.
 */
function assertCorpusPinsDefaults(files: ReadonlyMap<string, string>): void {
  for (const role of ['driver', 'vision'] as const) {
    const id = DEFAULT_BY_ROLE[role];
    const pinned = [...files.values()].filter((text) => text.includes(id));
    if (pinned.length === 0) {
      throw new Error(`no document pins the exact ${role} default (${id})`);
    }
  }
}

/** Read a corpus document from disk. */
function read(file: string): string {
  return readFileSync(join(ROOT, file), 'utf8');
}

/**
 * Model references that are deliberately NOT a default — the drift probes.
 *
 * Each one replaces the documented driver id in the README, so the guard has
 * to reject the reference it finds there: a full id of another model, the
 * same model spelled bare, the default's vendor paired with another model, and
 * the default's own vendor paired with a model that is not the default.
 */
const DRIFTED_REFERENCES = [
  'openai/gpt-4o-mini',
  'gpt-4o-mini',
  'deepseek/deepseek-v3',
  'deepseek/gpt-4o-mini',
] as const;

/**
 * Foreign vendor/model ids with NO mixed letter-digit segment — spellings
 * {@link isModelReference} cannot recognise. Each replaces a slot's value in
 * the rejection tests: the slot must extract the value anyway, and the guard
 * must reject it, however plain the id looks.
 */
const FOREIGN_IDS = ['anthropic/claude-sonnet', 'google/gemini-pro'] as const;

/**
 * A near-miss id: the default's vendor + the model WITHOUT its last part.
 *
 * `deepseek/deepseek-v4` is NOT `deepseek/deepseek-v4-flash` — a doc that
 * documents it has drifted, and the guard must say so.
 */
function nearMissId(id: string): string {
  const [vendor = '', model = ''] = id.split('/');
  const parts = model.split('-');
  return `${vendor}/${parts.slice(0, -1).join('-')}`;
}

test('every documented default model is the one the code ships', () => {
  for (const file of CORPUS) {
    expect(() => assertDocumentedDefaults(file, read(file))).not.toThrow();
  }
});

test('the corpus pins the exact driver + vision default ids', () => {
  const files = new Map(CORPUS.map((file): [string, string] => [file, read(file)]));
  expect(() => assertCorpusPinsDefaults(files)).not.toThrow();
});

test('the guard rejects a document that names a model which is not a default', () => {
  const text = read('README.md');
  for (const drifted of DRIFTED_REFERENCES) {
    const mutated = text.replace(DEFAULT_MODELS.driver, drifted);
    expect(mutated).not.toBe(text);
    expect(() => assertDocumentedDefaults('README.md', mutated)).toThrow(/is not a default model/);
  }
});

test('the guard rejects a vendor shorthand that names another model', () => {
  const text = read('README.md');
  const vendor = segments(DEFAULT_MODELS.driver)[0];
  const mutated = text.replace(`Default: ${vendor}.`, `Default: ${vendor}-v9.`);
  expect(mutated).not.toBe(text);
  expect(() => assertDocumentedDefaults('README.md', mutated)).toThrow(/is not a default model/);
});

test('the guard rejects a driver default that names the vision model', () => {
  const text = read('docs/idea/config.md');
  const mutated = text.replace(
    `"driver": "${DEFAULT_MODELS.driver}"`,
    `"driver": "${DEFAULT_MODELS.vision}"`,
  );
  expect(mutated).not.toBe(text);
  expect(() => assertDocumentedDefaults('docs/idea/config.md', mutated)).toThrow(
    /as the driver default/,
  );
});

test('the guard fails loud when a document documents no model at all', () => {
  expect(() => assertDocumentedDefaults('README.md', 'nothing to see here')).toThrow(
    /documents no default model/,
  );
});

test('the guard rejects a full id that is not the default model', () => {
  const text = read('docs/idea/config.md');
  const mutated = text.replace(
    `"driver": "${DEFAULT_MODELS.driver}"`,
    `"driver": "${nearMissId(DEFAULT_MODELS.driver)}"`,
  );
  expect(mutated).not.toBe(text);
  expect(() => assertDocumentedDefaults('docs/idea/config.md', mutated)).toThrow(
    /is not a default model/,
  );
});

test('the guard rejects a driver default that names another vendor', () => {
  const text = read('README.md');
  const driver = segments(DEFAULT_BY_ROLE.driver)[0];
  const vision = segments(DEFAULT_BY_ROLE.vision)[0];
  const mutated = text.replace(`Default: ${driver}.`, `Default: ${vision}.`);
  expect(mutated).not.toBe(text);
  expect(() => assertDocumentedDefaults('README.md', mutated)).toThrow(/as the driver default/);
});

test('the guard rejects a foreign vendor written as the default', () => {
  const text = read('README.md');
  const driver = segments(DEFAULT_BY_ROLE.driver)[0];
  const mutated = text.replace(`Default: ${driver}.`, 'Default: openai.');
  expect(mutated).not.toBe(text);
  expect(() => assertDocumentedDefaults('README.md', mutated)).toThrow(/is not a default model/);
});

test('the guard rejects a role slot that names a foreign vendor model', () => {
  const text = read('docs/idea/config.md');
  for (const foreign of FOREIGN_IDS) {
    const mutated = text.replace(`"driver": "${DEFAULT_MODELS.driver}"`, `"driver": "${foreign}"`);
    expect(mutated).not.toBe(text);
    expect(() => assertDocumentedDefaults('docs/idea/config.md', mutated)).toThrow(
      /is not a default model/,
    );
  }
});

test('the guard rejects a foreign vendor/model id written as the default', () => {
  const text = read('README.md');
  const driver = segments(DEFAULT_BY_ROLE.driver)[0];
  for (const foreign of FOREIGN_IDS) {
    const mutated = text.replace(`Default: ${driver}.`, `Default: ${foreign}.`);
    expect(mutated).not.toBe(text);
    expect(() => assertDocumentedDefaults('README.md', mutated)).toThrow(/is not a default model/);
  }
});
