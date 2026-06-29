/**
 * Findings store — the session's evidence locker on disk.
 *
 * Persists everything the small agent produces during a run, under the session
 * paths from `workspace.ts`:
 *   - `findings.json`            structured verdict, Zod-validated on write + read
 *   - `logs/{console,network,agent}.log`  appended trails (caller owns the format)
 *   - `screenshots/NNN-step.png` ordered frames, auto-numbered for the replay video
 *
 * Every write returns the absolute path it wrote, so findings can reference
 * evidence by path instead of inlining blobs into the smart agent's context.
 * Directories are created lazily (idempotent); bad findings fail loud via
 * `FindingsError` — never a silent fallback.
 */

import { access, appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FindingsError } from '../errors.js';
import type { Findings } from '../findings/schema.js';
import { FindingsSchema } from '../findings/schema.js';
import type { SessionPaths } from './workspace.js';

/** Append-only log channels backing `logs/<channel>.log`. */
export type LogChannel = 'console' | 'network' | 'agent';

/** Max slug length — keeps `NNN-<slug>.png` well under the 255-byte filename limit. */
const SLUG_MAX = 60;

/**
 * Make a label filesystem-safe for a screenshot name; `step` if it empties out.
 * Capped at {@link SLUG_MAX} chars — a long `look` question must never overflow the
 * filename limit (`ENAMETOOLONG`) and sink the screenshot write.
 */
function slug(label: string): string {
  const s = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return s || 'step';
}

export class FindingsStore {
  readonly #paths: SessionPaths;
  /** Cached mkdir promise — directories are ensured once per instance. */
  #dirsReady: Promise<void> | null = null;
  /** Highest screenshot sequence seen; lazily seeded from disk (resume-safe). */
  #screenshotSeq: number | null = null;

  constructor(paths: SessionPaths) {
    this.#paths = paths;
  }

  /** Validate + write `findings.json` (overwrites). Returns its path. */
  async writeFindings(findings: Findings): Promise<string> {
    const result = FindingsSchema.safeParse(findings);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new FindingsError(`Refusing to write invalid findings: ${issues}`);
    }
    await this.#ensureDirs();
    await writeFile(this.#paths.findingsJson, `${JSON.stringify(result.data, null, 2)}\n`, 'utf8');
    return this.#paths.findingsJson;
  }

  /** Read + validate `findings.json`. Throws `FindingsError` if missing/corrupt. */
  async readFindings(): Promise<Findings> {
    let raw: string;
    try {
      raw = await readFile(this.#paths.findingsJson, 'utf8');
    } catch (e) {
      throw new FindingsError(
        `Failed to read findings.json: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      throw new FindingsError(
        `findings.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const result = FindingsSchema.safeParse(data);
    if (!result.success) {
      const issues = result.error.issues
        .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      throw new FindingsError(`findings.json is invalid: ${issues}`);
    }
    return result.data;
  }

  /**
   * Read + validate `findings.json` if it exists yet; `null` if the agent has
   * not written one. Absence is normal (early in a run); a present-but-corrupt
   * file still throws `FindingsError` via `readFindings` — never swallowed.
   */
  async tryReadFindings(): Promise<Findings | null> {
    try {
      await access(this.#paths.findingsJson);
    } catch {
      return null;
    }
    return this.readFindings();
  }

  /** Append a line to `logs/<channel>.log` (newline added if absent). Returns its path. */
  async appendLog(channel: LogChannel, line: string): Promise<string> {
    await this.#ensureDirs();
    const file = join(this.#paths.logs, `${channel}.log`);
    await appendFile(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8');
    return file;
  }

  /** Save a PNG as `screenshots/NNN-<label>.png` (auto-numbered). Returns its path. */
  async saveScreenshot(label: string, data: Uint8Array): Promise<string> {
    await this.#ensureDirs();
    const seq = await this.#nextSeq();
    const file = join(
      this.#paths.screenshots,
      `${String(seq).padStart(3, '0')}-${slug(label)}.png`,
    );
    await writeFile(file, data);
    return file;
  }

  /** Create `screenshots/` + `logs/` (and the session root) once; idempotent. */
  #ensureDirs(): Promise<void> {
    if (this.#dirsReady === null) {
      this.#dirsReady = Promise.all([
        mkdir(this.#paths.screenshots, { recursive: true }),
        mkdir(this.#paths.logs, { recursive: true }),
      ]).then(() => undefined);
    }
    return this.#dirsReady;
  }

  /** Next screenshot index, seeding from existing files so resume never overwrites. */
  async #nextSeq(): Promise<number> {
    if (this.#screenshotSeq === null) {
      this.#screenshotSeq = await this.#scanMaxSeq();
    }
    this.#screenshotSeq += 1;
    return this.#screenshotSeq;
  }

  /** Highest `NNN-` prefix already in `screenshots/`, or 0 if none/missing. */
  async #scanMaxSeq(): Promise<number> {
    let entries: string[];
    try {
      entries = await readdir(this.#paths.screenshots);
    } catch {
      return 0;
    }
    let max = 0;
    for (const entry of entries) {
      const num = /^(\d+)-/.exec(entry)?.[1];
      if (num !== undefined) max = Math.max(max, Number(num));
    }
    return max;
  }
}
