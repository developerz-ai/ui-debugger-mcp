/**
 * Secret redaction — the value-keyed redactor a run binds to its auth persona.
 *
 * Neutral home (a sibling of `errors.ts`): the redactor is not a browser
 * concern — the belt, the summary service and the findings store all apply it —
 * so it lives here, with no adapter dependency.
 */

/** A redactor: a line in, the same line with the run's secret values masked. */
export type Redactor = (text: string) => string;

/**
 * Values a CONFIGURED auth persona types into the app (`targets.<t>.auth.<p>.fields`).
 *
 * The name-keyed redactors in `adapters/browser/log-format.ts` key off a NAME
 * they recognize (`authorization`, `?password=`). A persona's values have no such
 * tell: they land in a form POST body, in a `type` tool input on the agent
 * trail, in whatever an adapter error echoes back. So this one keys off the
 * VALUE — the only thing all three share — and is bound per run to the persona
 * the caller named.
 *
 * Same posture as the other two: presence stays diagnostic (`<redacted, N chars>`
 * still tells you a password of the right length was typed), the secret itself
 * never reaches the durable trail.
 *
 * Encoded spellings are matched as a CLASS, not as a list of encoders (every
 * encoder escapes a different subset: System.Text.Json writes `&` as `&`,
 * Python escapes all non-ASCII, PHP writes `\/`). Per secret, three patterns:
 *  - plain — the exact text;
 *  - JSON family — each character as itself, its short escape (`\"` `\\` `\/`
 *    `\b` `\f` `\n` `\r` `\t`), or `\u` + its UTF-16 code unit in hex;
 *  - percent family — each character as itself, or its UTF-8 bytes as `%XX`
 *    (a space also as `+`).
 * Escape hex digits match in either case; literal characters stay
 * case-sensitive. A literal `\` (JSON) or `%` (percent) is NOT an alternative
 * there — encoded text never carries one bare, and dropping it makes every
 * alternation decidable from its first two characters, so matching is linear
 * (no backtracking blow-up). The plain pattern still matches them bare.
 *
 * One pass over the ORIGINAL line: every match is located in offset order,
 * overlapping spans are merged, and each merged span is replaced once.
 * Replacing value by value instead leaked the tail of a secret that overlapped
 * an already-blanked one, and let a short secret re-match inside an earlier
 * `<redacted, N chars>` label.
 */
export function createSecretRedactor(secrets: readonly string[]): Redactor {
  const sources = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    // A lone surrogate reaches the app as U+FFFD (the browser replaces it), so
    // echoes of THAT value are the same secret. The Set drops the duplicate.
    for (const value of [secret, secret.replace(/\p{Cs}/gu, '\ufffd')]) {
      sources.add(literal(value));
      sources.add(jsonPattern(value));
    }
    sources.add(percentPattern(secret)); // already encodes a lone surrogate as U+FFFD
  }
  if (sources.size === 0) return (line) => line;
  const regexes = [...sources].map((source) => new RegExp(source, 'g'));
  return (line) => {
    // A k-way merge over each pattern's NEXT match, in offset order — no
    // per-match allocation. `end` of a match comes from the match itself:
    // escaped and bare characters differ in length.
    const find = (j: number, from: number): [number, number] => {
      const re = regexes[j] as RegExp;
      re.lastIndex = from;
      const m = re.exec(line);
      return m ? [m.index, m.index + m[0].length] : [-1, -1];
    };
    const next = regexes.map((_, j) => find(j, 0));
    let out = '';
    let cursor = 0;
    let start = -1;
    let end = -1;
    for (;;) {
      let k = -1;
      for (let j = 0; j < next.length; j++) {
        const at = (next[j] as [number, number])[0];
        if (at !== -1 && (k === -1 || at < (next[k] as [number, number])[0])) k = j;
      }
      if (k === -1) break;
      const [at, to] = next[k] as [number, number];
      if (at < end) {
        end = Math.max(end, to);
      } else {
        if (start !== -1) {
          out += `${line.slice(cursor, start)}<redacted, ${end - start} chars>`;
          cursor = end;
        }
        start = at;
        end = to;
      }
      next[k] = find(k, at + 1);
    }
    if (start === -1) return line;
    return `${out}${line.slice(cursor, start)}<redacted, ${end - start} chars>${line.slice(end)}`;
  };
}

/** JSON's two-character escapes. */
const JSON_SHORT: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '/': '\\/',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

/** Regex source for one UTF-16 code unit, literally — never a metacharacter. */
function unit(c: string): string {
  return /[0-9A-Za-z]/.test(c) ? c : `\\u${hex4(c.charCodeAt(0))}`;
}

/** Regex source matching `text` exactly, code unit by code unit. */
function literal(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) out += unit(text.charAt(i)); // code units, not points
  return out;
}

/** A code unit as four hex digits. */
function hex4(code: number): string {
  return code.toString(16).padStart(4, '0');
}

/** Hex digits of an escape, either case. */
function hexDigits(hex: string): string {
  return [...hex]
    .map((d) => (/[0-9]/.test(d) ? d : `[${d.toLowerCase()}${d.toUpperCase()}]`))
    .join('');
}

/** Each code unit: bare (not `\`), its short escape, or `\uXXXX` in either case. */
function jsonPattern(secret: string): string {
  let out = '';
  for (let i = 0; i < secret.length; i++) {
    const c = secret.charAt(i);
    const alts = [`${literal('\\u')}${hexDigits(hex4(c.charCodeAt(0)))}`];
    const short = JSON_SHORT[c];
    if (short !== undefined) alts.push(literal(short));
    if (c !== '\\') alts.push(unit(c));
    out += `(?:${alts.join('|')})`;
  }
  return out;
}

/**
 * Each code point: bare (not `%`), or its UTF-8 bytes as `%XX` in either case; a
 * space also as `+`. A lone surrogate has no UTF-8 form — a browser sends U+FFFD.
 */
function percentPattern(secret: string): string {
  const encoder = new TextEncoder();
  let out = '';
  for (const c of secret) {
    const bytes = encoder.encode(c); // a lone surrogate encodes as U+FFFD's bytes
    const alts = [[...bytes].map((b) => `%${hexDigits(b.toString(16).padStart(2, '0'))}`).join('')];
    if (c === ' ') alts.push('\\+');
    if (c !== '%') alts.push(literal(c));
    out += `(?:${alts.join('|')})`;
  }
  return out;
}
