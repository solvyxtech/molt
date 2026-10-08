/**
 * Keeping hidden checks out of every file the worker can read while it works.
 *
 * A hidden check's command is withheld from the model: shown the command, a
 * model makes the work equal the check. That held for what was SENT to the
 * model and for nothing Maat wrote to disk. On 2026-10-07 a Grok worker,
 * refused once, grepped the filesystem for the check names it had been
 * given and found every command in full: in `.maat/receipts/0000-refused.md`,
 * in the journal's `bar_run` entries, and in Maat's own copy of its grep's
 * output under `.maat/out/`. The worker and Maat run as the same user, so no
 * file permission can keep one from reading what the other writes.
 *
 * So the commands are not written while the job runs. Every record Maat
 * writes during the job — receipts, journal entries, tool-output copies, the
 * event stream — carries the check's name and this mask instead. The full
 * text is held in memory and written when the job ends: the journal gets
 * the commands, and each receipt gets a full twin under `receipts/full/`.
 * The seal published before the work is a hash over the full commands, so
 * the released text can be checked against it: the checks still provably
 * predate the work, without being readable during it.
 */
import { createHash } from "node:crypto";

export const WITHHELD = "[withheld until the job ends]";

/**
 * Shorter commands are not masked. A two-letter command masked everywhere
 * would shred every record for no protection: there is nothing to copy.
 */
export const WITHHELD_MIN_CHARS = 6;

/** The commands of the hidden command checks among these. */
export function hiddenCommands(checks: readonly { kind: string; hidden?: boolean; run?: string }[]): string[] {
  return checks
    .filter((c) => c.hidden === true && c.kind === "command" && typeof c.run === "string")
    .map((c) => c.run!)
    .filter((r) => r.length >= WITHHELD_MIN_CHARS);
}

/** Longest first, so a command that contains another is masked whole. */
function ordered(list: readonly string[]): string[] {
  return [...new Set(list)].filter((s) => s.length >= WITHHELD_MIN_CHARS).sort((a, b) => b.length - a.length);
}

/**
 * Masking is by exact substring (plus a trimmed and a markdown-`\|`-escaped
 * form). It catches a command written back verbatim, the common case, since
 * Maat echoes the command it ran. It does NOT catch a command a tool has
 * reformatted: re-quoted, re-indented, line-rewrapped, or split so no run of
 * it appears intact. Masking is a convenience for Maat's own records, not a
 * confidentiality boundary; the boundary is keeping the command off disk while
 * the job runs (this module), out of argv (`hideCommand`, src/run.ts: the
 * command arrives on fd 3) and, under `--worker-user`, behind a uid the worker
 * cannot cross.
 */
export function maskText(text: string, list: readonly string[]): string {
  if (!text || list.length === 0) return text;
  let out = text;
  for (const s of ordered(list)) {
    if (out.includes(s)) out = out.split(s).join(WITHHELD);
    // A multi-line command can be printed trimmed, or with its lines joined.
    const t = s.trim();
    if (t !== s && t.length >= WITHHELD_MIN_CHARS && out.includes(t)) out = out.split(t).join(WITHHELD);
    // In a markdown table cell a command's `|` is written `\|`.
    if (s.includes("|")) {
      const esc = s.replace(/\|/g, "\\|");
      if (out.includes(esc)) out = out.split(esc).join(WITHHELD);
    }
  }
  return out;
}

/** Every string inside a value, masked. Returns the same shape. */
export function maskDeep<T>(value: T, list: readonly string[]): T {
  if (list.length === 0) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskText(v, list);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(value) as T;
}

/** The sha256 of a command, as written beside its name when the full text is released. */
export function commandSha(run: string): string {
  return createHash("sha256").update(run, "utf8").digest("hex");
}
