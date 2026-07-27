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
import { writeFileAtomic } from './atomic-write.js';
import type { SessionPaths } from './workspace.js';

/** Append-only log channels backing `logs/<channel>.log`. */
export type LogChannel = 'console' | 'network' | 'agent';

/** One ordered screenshot frame — the raw material for the replay video. */
export interface ScreenshotFrame {
  /** The `NNN` sequence parsed from the filename (ascending = capture order). */
  seq: number;
  /** Absolute path to the PNG. */
  path: string;
  /** Step label de-slugged from the filename (`001-clicked-login.png` → `clicked login`). */
  label: string;
}

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
  /** Cached seed scan — the disk is scanned once per instance (resume-safe). */
  #seqReady: Promise<void> | null = null;
  /** Highest screenshot sequence handed out; valid once `#seqReady` settles. */
  #screenshotSeq = 0;

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
    // Write-then-rename so a concurrent reader (get_findings, CLI `status`) never
    // sees a torn/empty findings.json — rename is atomic on the same filesystem.
    await writeFileAtomic(this.#paths.findingsJson, `${JSON.stringify(result.data, null, 2)}\n`);
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

  /**
   * Save a frame as `screenshots/NNN-<label>.<ext>` (auto-numbered). Returns its path.
   * `extension` defaults to `png`; `look` passes `jpg` when it fell back to JPEG for a
   * photo-heavy frame, so the file on disk matches the bytes the model actually saw.
   */
  async saveScreenshot(label: string, data: Uint8Array, extension = 'png'): Promise<string> {
    await this.#ensureDirs();
    const seq = await this.#nextSeq();
    const file = join(
      this.#paths.screenshots,
      `${String(seq).padStart(3, '0')}-${slug(label)}.${extension}`,
    );
    await writeFile(file, data);
    return file;
  }

  /**
   * List saved screenshots as ordered frames (`NNN-<label>.<png|jpg>`), ascending
   * by sequence — the capture order the replay video stitches. Returns `[]` when
   * none were saved yet (or the dir is missing); files that don't match the pattern
   * are skipped. Decodes the step label back from the filename slug.
   *
   * BOTH extensions, not just `.png`: `look` re-captures a photo-heavy frame as
   * JPEG (`saveScreenshot(..., 'jpg')`), and a png-only match silently dropped
   * exactly those frames from the replay — the run's most visual evidence, gone
   * from the clip with nothing to say why.
   */
  async listScreenshots(): Promise<ScreenshotFrame[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#paths.screenshots);
    } catch {
      return [];
    }
    const frames: ScreenshotFrame[] = [];
    for (const entry of entries) {
      const match = /^(\d+)-(.*)\.(?:png|jpe?g)$/.exec(entry);
      const digits = match?.[1];
      const slug = match?.[2];
      if (digits === undefined || slug === undefined) continue;
      frames.push({
        seq: Number(digits),
        path: join(this.#paths.screenshots, entry),
        label: slug.replace(/-+/g, ' ').trim() || 'step',
      });
    }
    return frames.sort((a, b) => a.seq - b.seq);
  }

  /**
   * Create `screenshots/` + `logs/` (and the session root) once; idempotent.
   *
   * A FAILED attempt is not cached: one transient `EMFILE`/`ENOSPC` would
   * otherwise poison every later `writeFindings`/`appendLog`/`saveScreenshot` on
   * this store — including the driver's terminal `report` — long after the
   * condition cleared, ending the run with no `findings.json` at all.
   */
  #ensureDirs(): Promise<void> {
    if (this.#dirsReady === null) {
      const attempt = Promise.all([
        mkdir(this.#paths.screenshots, { recursive: true }),
        mkdir(this.#paths.logs, { recursive: true }),
      ]).then(() => undefined);
      this.#dirsReady = attempt;
      this.#forgetOnFailure(attempt, 'dirs');
    }
    return this.#dirsReady;
  }

  /**
   * Drop a rejected cached attempt so the next call retries it. Guarded by
   * identity: a newer attempt already in the field is never cleared. The `catch`
   * here handles this branch only — the attempt itself is still returned to (and
   * awaited by) the caller, so the failure is never swallowed.
   */
  #forgetOnFailure(attempt: Promise<void>, field: 'dirs' | 'seq'): void {
    attempt.catch(() => {
      if (field === 'dirs') {
        if (this.#dirsReady === attempt) this.#dirsReady = null;
      } else if (this.#seqReady === attempt) {
        this.#seqReady = null;
      }
    });
  }

  /**
   * Next screenshot index, seeding from existing files so resume never overwrites.
   * The seed scan is cached as a promise (like `#ensureDirs`) so concurrent first
   * saves share one scan and still get distinct numbers — never a duplicate `001`.
   * A failed scan is dropped from the cache (same reason as `#ensureDirs`).
   */
  async #nextSeq(): Promise<number> {
    if (this.#seqReady === null) {
      const attempt = this.#scanMaxSeq().then((max) => {
        this.#screenshotSeq = max;
      });
      this.#seqReady = attempt;
      this.#forgetOnFailure(attempt, 'seq');
    }
    await this.#seqReady;
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
