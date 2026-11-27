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
 * One pass over the ORIGINAL line: every occurrence of every spelling is
 * located first, overlapping spans are merged, and each merged span is replaced
 * once. Replacing value by value instead leaked the tail of a secret that
 * overlapped an already-blanked one, and let a short secret re-match inside an
 * earlier `<redacted, N chars>` label.
 */
export function createSecretRedactor(secrets: readonly string[]): Redactor {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    spellings.add(secret);
    // A lone surrogate has no UTF-8 form: `encodeURIComponent` throws on it, so
    // that spelling can never occur on the wire — skip it deliberately. The
    // `<form>` serializer below still covers what a browser actually sends (U+FFFD).
    if (!/\p{Cs}/u.test(secret)) {
      const encoded = encodeURIComponent(secret);
      spellings.add(encoded);
      spellings.add(encoded.replaceAll('%20', '+')); // hand-built form body: space as `+`
    }
    // A browser `<form>` POST (the urlencoded serializer) ALSO escapes `!'()~`,
    // which `encodeURIComponent` leaves bare — without it such a password ships in clear.
    spellings.add(new URLSearchParams({ v: secret }).toString().slice(2));
    const json = JSON.stringify(secret).slice(1, -1);
    spellings.add(json); // JSON body escaping
    // ASCII-only JSON (`\u00e9` — e.g. Python's `json.dumps` default) in a response
    // body. Python escapes everything outside space..`~`, so DEL (U+007F) too.
    spellings.add(
      json.replace(
        /[\u007f-\uffff]/g,
        (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
      ),
    );
  }
  const values = [...spellings];
  if (values.length === 0) return (line) => line;
  return (line) => {
    // `indexOf`, not a regex: a credential is arbitrary text and escaping it for a
    // pattern is one missed metacharacter away from not redacting at all.
    // A k-way merge over each spelling's NEXT match, in offset order: no per-match
    // allocation, and matches wholly inside the current span are skipped.
    const next = values.map((value) => line.indexOf(value));
    let out = '';
    let cursor = 0;
    let start = -1;
    let end = -1;
    for (;;) {
      let k = -1;
      for (let j = 0; j < values.length; j++) {
        const at = next[j] as number;
        if (at !== -1 && (k === -1 || at < (next[k] as number))) k = j;
      }
      if (k === -1) break;
      const at = next[k] as number;
      const value = values[k] as string;
      if (at < end) {
        end = Math.max(end, at + value.length);
      } else {
        if (start !== -1) {
          out += `${line.slice(cursor, start)}<redacted, ${end - start} chars>`;
          cursor = end;
        }
        start = at;
        end = at + value.length;
      }
      // A later match of this spelling starting before `end - length` ends inside the span.
      next[k] = line.indexOf(value, Math.max(at + 1, end - value.length + 1));
    }
    if (start === -1) return line;
    return `${out}${line.slice(cursor, start)}<redacted, ${end - start} chars>${line.slice(end)}`;
  };
}
