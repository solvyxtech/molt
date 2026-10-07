/**
 * What kind of evidence a passing check is, and when that earns "verified".
 *
 * Measured over Mercury, Nemotron and Qwen runs, the word "verified" was right
 * 20-88% of the time depending on the model. Claims backed by a check that RAN
 * the deliverable and ASSERTED a value, with no reviewer contradiction and a
 * model that said done, were 7/7 right; everything else was right 28/50. A
 * word that means one thing on one model and another on the next is not a
 * label, so it is earned by the evidence, mechanically, the same way on every
 * model.
 *
 * Three classes, strongest last:
 *   surface  the critic read the check as only looking (`surface` tag)
 *   runs     it runs the deliverable (the critic did not mark it surface)
 *   value    its command asserts a concrete expected value (`value` tag)
 * "verified" needs a passing check that is runs AND value.
 */
import type { CheckResult } from "./types.js";

/** An operand that is a literal: a number, a quoted string without a variable in it, a list/dict opener, or a keyword value. */
const LIT_AFTER = /^(?:\\?["'](?![^"']*\$)[^"']|-?\d|[[{]|(?:True|False|None|true|false|null)\b)/;
/** The operand just before an operator, when it is wholly a literal and not the tail of a name like `x2`. */
const LIT_BEFORE = /(?:(?<![\w.$)\]])-?\d+(?:\.\d+)?|\\?"[^"$]*\\?"|'[^']*')\s*$/;
/** A number that stands alone (`42`, `3.5`), not the 3 in `python3` or `x2`. */
const STANDALONE_NUMBER = /(?<![\w.])\d+(?:\.\d+)?(?!\w)/;
const LIT_ARG = String.raw`(?:-?\d|\\?["'](?![^"']*\$)|[[{])`;
/** An equality helper whose first or last argument is a literal: `assertEqual(f(2), 4)`, `a.strictEqual(x, "ok")`. */
const ASSERT_EQUAL = new RegExp(
  String.raw`(?:\bassert_?[Ee]qual|\bassert_eq|\.(?:deep|strict|deepStrict)?[Ee]qual)\w*\s*\((?:[^\n]*,\s*${LIT_ARG}[^,()]*\)|\s*${LIT_ARG}[^()]*,)`,
);

/** True when the operator at `at` in `s` has a literal on either side. */
function literalAround(s: string, at: number, len: number): boolean {
  const after = s.slice(at + len, at + len + 60).trimStart();
  const before = s.slice(Math.max(0, at - 60), at);
  return LIT_AFTER.test(after) || LIT_BEFORE.test(before);
}

/** A short-flag cluster (`-q`, `-qx`, `-Eq`) that holds one of `letters`; long options never match. */
function hasFlag(flags: string[], letters: string): boolean {
  return flags.some((f) => /^-[A-Za-z]+$/.test(f) && [...letters].some((l) => f.includes(l)));
}

/**
 * Does this command assert a concrete expected value?
 *
 * The rule, exactly. True when any of these holds:
 *  1. `==`, `!=`, `-eq`, `-ne`, or a single `=` inside a `[ ]`/`[[ ]]`/`test`
 *     comparison, with a literal on either side: a number, a quoted string
 *     with no `$` in it, a list/dict opener, or true/false/null/None. `[ "$a"
 *     = "$b" ]` and `assert x == y` compare two unknowns and do not count; an
 *     `assert` counts through this rule, when it compares to a literal.
 *  2. `assertEqual`/`assert_equal`/`assert_eq`/`assert.(deep|strict)Equal`
 *     handed a literal argument.
 *  3. `diff` or `cmp` against an expected file (a name with expect, golden,
 *     want, answer, baseline or correct in it) or against a heredoc, here
 *     string or `<(...)` written in the command. `diff out.txt in.txt` does
 *     not count: two files are not a value.
 *  4. `grep` with `-q` or `-x` whose pattern is a literal holding a
 *     standalone number, a whole expected line (`-x`), or anchored at both
 *     ends (`^...$`). `grep -q "def main"` does not count.
 * Conservative on purpose: a check missed here costs one claim the word
 * "verified"; a check counted wrongly costs the word its meaning.
 */
export function assertsValue(run: string): boolean {
  const ops = /(==|!=|(?<=\s)-eq(?=\s)|(?<=\s)-ne(?=\s)|(?<=\s)=(?=\s))/g;
  for (const m of run.matchAll(ops)) {
    const at = m.index ?? 0;
    if (m[1] === "=") {
      // A lone `=` is an assignment unless it sits in a test bracket.
      const segment = run.slice(0, at).split(/[;\n]|&&|\|\|/).pop() ?? "";
      if (!/(?:^|\s)(?:\[\[?|test)\s/.test(segment)) continue;
    }
    if (literalAround(run, at, m[1]!.length)) return true;
  }
  if (ASSERT_EQUAL.test(run)) return true;
  for (const m of run.matchAll(/\b(?:diff|cmp)\b([^\n|;&]*)/g)) {
    const args = m[1] ?? "";
    if (/<<|<\(/.test(args)) return true;
    if (/(?:^|[\s/'"])[\w.-]*(?:expect|golden|want|answer|baseline|correct)/i.test(args)) return true;
  }
  for (const m of run.matchAll(/\bgrep\b([^\n|;&]*)/g)) {
    const words: string[] = (m[1] ?? "").match(/"(?:[^"\\]|\\.)*"|'[^']*'|\S+/g) ?? [];
    const flags = words.filter((w) => w.startsWith("-"));
    if (!hasFlag(flags, "qx")) continue;
    const e = words.indexOf("-e");
    const pat = e >= 0 ? words[e + 1] : words.find((w) => !w.startsWith("-"));
    if (!pat) continue;
    const body = pat.replace(/^(["'])(.*)\1$/s, "$2");
    if (!body || /\$[\w{(]/.test(body)) continue;
    if (STANDALONE_NUMBER.test(body) || /^\^.{3,}\$$/s.test(body) || (hasFlag(flags, "x") && /\S/.test(body))) return true;
  }
  return false;
}

/** The tags a drafted check carries: surface from the critic, value from the command. */
export function evidenceTags(run: string, surface: boolean | undefined): string[] {
  return ["task", ...(surface ? ["surface"] : []), ...(assertsValue(run) ? ["value"] : [])];
}

export type Tier = "verified" | "passed-checks";
export type TierVerdict = {
  tier: Tier;
  reason?: string;
  /** The strongest class among the passing checks. */
  evidence: "person" | "runs+value" | "runs" | "surface" | "none";
  /** Advisory review mode only: what the review said, recorded on the receipt instead of gating. */
  reviewNote?: string;
};

/**
 * The verdict words for a turn that passed its checks without earning
 * "verified". One phrase on every surface, so the same turn reads the same
 * whichever model ran it.
 */
export function passedChecksWords(reason: string | undefined): string {
  return `passed its checks (not verified: ${reason ?? "no check asserted an expected value"})`;
}

/** How many reviewers found a contradiction ("2/3" is 2); the violations list is the fallback. */
export function contradictions(review: { votes: string; violations: unknown[] } | null | undefined): number {
  if (!review) return 0;
  const n = Number.parseInt(review.votes, 10);
  return Number.isFinite(n) ? n : review.violations.length;
}

/**
 * The tier a passing turn has earned. "verified" needs (a) a passing check a
 * person wrote, or a passing drafted check that runs the deliverable (not
 * surface) AND asserts a value, and (b) an independent review, when one ran,
 * that found no contradiction. (c) — the turn not ended by the clock or the
 * provider — is decided before this, by `passedAtEnd`.
 *
 * A person's check is not Maat's to second-guess: a passing check from the
 * project's done.yml (not hidden) carries "verified" as it always did.
 */
export function tierOf(args: {
  results: readonly (Pick<CheckResult, "ok" | "hidden" | "advisory" | "skipped" | "tags"> & { name?: string })[];
  review?: { votes: string; violations: unknown[] } | null;
  /** An independent review was asked for and did not run: it cannot have found nothing. */
  unreviewed?: boolean;
  /**
   * Experimental (MAAT_REVIEW_ADVISORY=1, `--review-advisory`): the review is
   * recorded but gates nothing, and the evidence rule is stricter in return —
   * the passing runs+value drafted check must also have FAILED on the untouched
   * project, i.e. not be in `guards` (the checks that passed before the work).
   * reports/checkquality-2026-10-06.md §2.5 measured the 3-vote review as a
   * likelihood ratio of about 1.
   */
  reviewAdvisory?: boolean;
  /** Names (as in `results`) of checks that already passed before the work. */
  guards?: ReadonlySet<string>;
}): TierVerdict {
  const passing = args.results.filter((r) => r.ok && !r.advisory && !r.skipped);
  // A mission's assertions are its contract, written before the work and
  // sealed with it (mission.ts): they are the person's bar, not a model's
  // guess at one, so they carry the word as a done.yml check does.
  const person = passing.some((r) => r.hidden !== true || r.tags?.includes("mission"));
  const drafted = passing.filter((r) => r.hidden === true && r.tags?.includes("task"));
  const strong = drafted.some(
    (r) => !r.tags?.includes("surface") && r.tags?.includes("value") && !(args.reviewAdvisory && args.guards?.has(r.name ?? "")),
  );
  const evidence: TierVerdict["evidence"] = person
    ? "person"
    : strong
      ? "runs+value"
      : drafted.some((r) => !r.tags?.includes("surface"))
        ? "runs"
        : drafted.length
          ? "surface"
          : "none";
  if (args.reviewAdvisory) {
    const n = contradictions(args.review);
    const reviewNote = n > 0 ? `advisory: the independent review found ${args.review!.votes} contradicting the task` : args.unreviewed ? "advisory: the independent review did not run" : undefined;
    if (person || strong) return { tier: "verified", evidence, ...(reviewNote ? { reviewNote } : {}) };
    return {
      tier: "passed-checks",
      evidence,
      reason: drafted.some((r) => !r.tags?.includes("surface") && r.tags?.includes("value"))
        ? "the only passing value check also passed before the work began"
        : evidence === "runs"
          ? "no check that ran the work asserted an expected value"
          : "no passing check ran the work and asserted an expected value",
      ...(reviewNote ? { reviewNote } : {}),
    };
  }
  if (contradictions(args.review) > 0) {
    return { tier: "passed-checks", evidence, reason: `the independent review found ${args.review!.votes} contradicting the task` };
  }
  if (args.unreviewed && !person) return { tier: "passed-checks", evidence, reason: "the independent review did not run" };
  if (person || strong) return { tier: "verified", evidence };
  return {
    tier: "passed-checks",
    evidence,
    reason:
      evidence === "runs"
        ? "no check that ran the work asserted an expected value"
        : "no passing check ran the work and asserted an expected value",
  };
}
