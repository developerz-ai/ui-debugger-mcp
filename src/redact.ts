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
 * only the plain text would leave the real body in `logs/network.log`.
 *
 * Longest first, so a value that contains another still redacts whole.
 */
export function createSecretRedactor(secrets: readonly string[]): Redactor {
  const spellings = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    spellings.add(secret);
    const encoded = encodeURIComponent(secret);
    spellings.add(encoded);
    spellings.add(encoded.replaceAll('%20', '+')); // form encoding spells a space `+`
    spellings.add(JSON.stringify(secret).slice(1, -1)); // JSON body escaping
  }
  const values = [...spellings].sort((a, b) => b.length - a.length);
  if (values.length === 0) return (line) => line;
  return (line) => {
    let out = line;
    for (const value of values) {
      // `split`/`join`, not a regex: a credential is arbitrary text and escaping it
      // for a pattern is one missed metacharacter away from not redacting at all.
      if (out.includes(value)) out = out.split(value).join(`<redacted, ${value.length} chars>`);
    }
    return out;
  };
}
