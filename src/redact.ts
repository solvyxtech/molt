/**
 * Keeping credentials out of the files whose whole purpose is to be shared.
 *
 * molt's pitch is an auditable record: commit the log, hand someone a receipt,
 * let them check the work without trusting you. Every one of those sentences
 * is an argument for a file leaving the machine it was written on — which
 * makes that file exactly where a leaked key does the most damage.
 *
 * The journal already refuses to log message content for this reason. It did
 * not refuse to log a *command*, and `curl -H "authorization: Bearer sk-live-…"`
 * is a command. This closes that.
 *
 * Two kinds of pattern, in order of confidence:
 *
 *  1. **The values molt actually holds.** An API key in the session
 *     configuration is a known string; every occurrence of it can be masked
 *     exactly, with no false positives and no false negatives. This is the
 *     precise half and it is the half that matters most.
 *  2. **Shapes that are only ever secrets.** Provider key prefixes, private
 *     key blocks, bearer headers, assignments to something named "token".
 *     Heuristic, so it errs toward masking: a redacted string that was not a
 *     secret costs a reader one lookup, and the reverse costs a rotation.
 *
 * Nothing here is a guarantee. It is a filter with a stated shape, and the
 * durable protection is still not to paste a key into a prompt.
 */

export const MASK = "[redacted]";

/**
 * The shortest string worth masking exactly.
 *
 * Below this, masking shreds ordinary prose to no purpose — and a secret this
 * short is not one. Exported because the journal and the receipts apply the
 * same rule when they decide what to protect, and a threshold living in three
 * files is a threshold that will eventually differ in three files.
 */
export const MIN_SECRET_CHARS = 8;

/**
 * Patterns that are secrets by their shape.
 *
 * Each is anchored on something structural — a provider prefix, a header
 * name, a key-ish assignment — rather than on entropy, because "looks
 * random" also describes a hash, a build id, and a UUID, none of which are
 * worth hiding from an audit log.
 *
 * Every pattern carries /g and is used only with String.replace, which resets
 * lastIndex on entry — so redact() is stateless across calls, and there is a
 * test that says so. Reach for .test() or .exec() with one of these and that
 * stops being true: a global regex remembers where it stopped, and the second
 * call silently skips the first match.
 *
 * A capturing group here means one thing and one thing only: "keep this part,
 * it names the field". Every other group must be non-capturing. Getting that
 * wrong appends the mask to the secret instead of replacing it, which is a
 * leak that looks like a redaction — caught by a test, not by reading.
 */
const SHAPES: RegExp[] = [
  // Provider key prefixes. The tail is deliberately greedy about length.
  /\b(?:sk-ant-[A-Za-z0-9._-]{8,}|sk-[A-Za-z0-9._-]{16,})/g,
  /\bxai-[A-Za-z0-9._-]{16,}/g,
  /\bgsk_[A-Za-z0-9._-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bAIza[A-Za-z0-9._-]{20,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  // A JWT: three base64url segments, the first two of which decode to JSON.
  /\beyJ[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}\.[A-Za-z0-9._-]{10,}/g,
  // An authorization header, however it is spelled.
  /((?:authorization|x-api-key|api-key)\s*[:=]\s*(?:"|')?(?:bearer\s+|token\s+)?)[^\s"']{8,}/gi,
  // An assignment to something that says it is a secret.
  /((?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password|passwd|pwd)\s*[:=]\s*(?:"|')?)[^\s"',;)}]{6,}/gi,
  // A private key block, however long.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/**
 * Mask credentials in text bound for a file that may be shared.
 *
 * `known` carries values molt holds — the session's API key, anything else
 * exact. Short values are ignored: masking a three-character string would
 * shred ordinary prose, and a three-character secret is not one.
 */
export function redact(text: string, known: (string | undefined)[] = []): string {
  if (!text) return text;
  let out = text;

  for (const secret of known) {
    if (!secret || secret.length < MIN_SECRET_CHARS) continue;
    out = out.split(secret).join(MASK);
  }

  for (const re of SHAPES) {
    out = out.replace(re, (_match, prefix?: string) =>
      // A pattern with a capture group keeps the part that names the field, so
      // the record still says WHAT was redacted — "authorization: [redacted]"
      // is auditable in a way that a bare mask is not.
      typeof prefix === "string" ? `${prefix}${MASK}` : MASK,
    );
  }
  return out;
}

/** Redact every string value in a record, recursively. Used on log entries. */
export function redactData(
  data: Record<string, unknown>,
  known: (string | undefined)[] = [],
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return redact(v, known);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(data) as Record<string, unknown>;
}
