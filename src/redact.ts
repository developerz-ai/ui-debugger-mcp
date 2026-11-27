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
 * never reaches the durable trail. Form-encoded and JSON-escaped spellings are
 * redacted too — a password with an `@` rides a form POST as `%40`, and matching
 * only the plain text would leave the real body in `logs/network.log`. Both
 * percent-encoders (`encodeURIComponent` and the stricter `<form>` serializer)
 * and ASCII-only `\uXXXX` JSON are covered.
 *
 * Hex digits INSIDE a generated escape (`%2F`, `\u00e9`) match in either case —
 * both are case-insensitive by spec and encoders/loggers disagree — while the
 * secret's literal characters stay case-sensitive. Escapes are recognised by
 * tokenizing each encoded spelling, never by scanning it for a pattern, so a
 * secret that literally contains `%2F` or `\u0041` keeps them literal.
 *
 * One pass over the ORIGINAL line: every occurrence of every spelling is
 * located first, overlapping spans are merged, and each merged span is replaced
 * once. Replacing value by value instead leaked the tail of a secret that
 * overlapped an already-blanked one, and let a short secret re-match inside an
 * earlier `<redacted, N chars>` label.
 */
export function createSecretRedactor(secrets: readonly string[]): Redactor {
  const patterns = new Map<string, number>(); // regex source → match length
  const add = (source: string, length: number) => patterns.set(source, length);
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    add(literal(secret), secret.length);
    // A lone surrogate has no UTF-8 form: `encodeURIComponent` throws on it, so
    // that spelling can never occur on the wire — skip it deliberately. The
    // `<form>` serializer below still covers what a browser actually sends (U+FFFD).
    if (!/\p{Cs}/u.test(secret)) {
      const encoded = encodeURIComponent(secret);
      add(percentPattern(encoded), encoded.length);
      const plus = encoded.replaceAll('%20', '+'); // hand-built form body: space as `+`
      add(percentPattern(plus), plus.length);
    }
    // A browser `<form>` POST (the urlencoded serializer) ALSO escapes `!'()~`,
    // which `encodeURIComponent` leaves bare — without it such a password ships in clear.
    const form = new URLSearchParams({ v: secret }).toString().slice(2);
    add(percentPattern(form), form.length);
    const json = JSON.stringify(secret).slice(1, -1);
    add(jsonPattern(json), json.length); // JSON body escaping
    // ASCII-only JSON (`é` — e.g. Python's `json.dumps` default) in a response
    // body. Python escapes everything outside space..`~`, so DEL (U+007F) too.
    const ascii = json.replace(/\\.|[\u007f-￿]/g, (c) =>
      c.length === 2 ? c : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
    add(jsonPattern(ascii), ascii.length);
  }
  if (patterns.size === 0) return (line) => line;
  // Every pattern matches a FIXED length (an escape is fixed-width in either case).
  const lengths = [...patterns.values()];
  const regexes = [...patterns.keys()].map((source) => new RegExp(source, 'g'));
  return (line) => {
    // A k-way merge over each pattern's NEXT match, in offset order: no per-match
    // allocation, and matches wholly inside the current span are skipped.
    const find = (j: number, from: number): number => {
      const re = regexes[j] as RegExp;
      re.lastIndex = from;
      return re.exec(line)?.index ?? -1;
    };
    const next = regexes.map((_, j) => find(j, 0));
    let out = '';
    let cursor = 0;
    let start = -1;
    let end = -1;
    for (;;) {
      let k = -1;
      for (let j = 0; j < next.length; j++) {
        const at = next[j] as number;
        if (at !== -1 && (k === -1 || at < (next[k] as number))) k = j;
      }
      if (k === -1) break;
      const at = next[k] as number;
      const length = lengths[k] as number;
      if (at < end) {
        end = Math.max(end, at + length);
      } else {
        if (start !== -1) {
          out += `${line.slice(cursor, start)}<redacted, ${end - start} chars>`;
          cursor = end;
        }
        start = at;
        end = at + length;
      }
      // A later match starting before `end - length` would end inside the span.
      next[k] = find(k, Math.max(at + 1, end - length + 1));
    }
    if (start === -1) return line;
    return `${out}${line.slice(cursor, start)}<redacted, ${end - start} chars>${line.slice(end)}`;
  };
}

/**
 * Regex source matching `text` exactly. Every non-alphanumeric code unit is
 * written as a `\uXXXX` escape — no metacharacter list to get wrong.
 */
function literal(text: string): string {
  return text.replace(
    /[^0-9A-Za-z]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

/** Hex digits of an escape, either case. */
function hexDigits(hex: string): string {
  return [...hex]
    .map((d) => (/[0-9]/.test(d) ? d : `[${d.toLowerCase()}${d.toUpperCase()}]`))
    .join('');
}

/** A percent-encoded spelling: every `%` there IS an escape (a literal `%` is `%25`). */
function percentPattern(encoded: string): string {
  return encoded
    .split(/(%[0-9A-Fa-f]{2})/)
    .map((part, i) => (i % 2 === 1 ? `%${hexDigits(part.slice(1))}` : literal(part)))
    .join('');
}

/** A JSON-escaped spelling, tokenized left to right so `\\` never starts a `\u`. */
function jsonPattern(json: string): string {
  return json
    .split(/(\\u[0-9A-Fa-f]{4}|\\.)/)
    .map((part, i) =>
      i % 2 === 1 && part.startsWith('\\u')
        ? `${literal('\\u')}${hexDigits(part.slice(2))}`
        : literal(part),
    )
    .join('');
}
