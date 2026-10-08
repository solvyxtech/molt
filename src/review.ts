/**
 * An independent review of a "done" claim, as a label — never a gate.
 *
 * molt's checks decide whether a claim is accepted. They are drafted by the
 * model that does the work, and on Terminal-Bench 2.0 a "verified" claim was
 * true only 63% of the time: the checks rarely failed to notice that work had
 * happened, they missed which requirement it got wrong. An offline replay of
 * 63 verified claims showed a fresh reviewer, reading only the task text and
 * the receipt, catches most of those. Used as a gate it also refused more than
 * half of the correct work, so it is not one: it changes what molt SAYS about
 * the work — "verified" or "passed its checks, unconfirmed" — and never what
 * molt does. No retry, no refusal, no lost score.
 *
 * The same discipline as everywhere else in molt: the model finds, something
 * mechanical judges. A reported violation must quote the task text verbatim
 * (checked by string match — an invented requirement is dropped), and a claim
 * is unconfirmed only when a majority of independent reviews found a
 * grounded violation.
 */
import { askModel, jsonIn, type AskOptions } from "./ask.js";

export const REVIEW_SYSTEM = [
  "You review a coding agent's claim that it finished a task. You did not do the work.",
  "You get the task text and a receipt: what the agent claimed, the lines it wrote,",
  "the commands it ran and their results, and the checks that passed.",
  "",
  "Report a requirement ONLY if the receipt shows it is VIOLATED: a written line,",
  "a command's output, or the claim itself contradicts something the task text",
  "states (a wrong value, a wrong path or format, a missing required file, an",
  "explicit constraint broken, a stated case not handled by the code shown).",
  "Do NOT report a requirement just because the receipt does not mention it —",
  "absence of evidence is not a violation. Quote the task text verbatim, and name",
  "the receipt evidence that contradicts it.",
  "",
  "Reply with JSON only:",
  '{"violations": [{"quote": "exact phrase from the task", "evidence": "what in the receipt contradicts it"}]}',
  'Return {"violations": []} if nothing in the receipt contradicts the task.',
].join("\n");

export type Violation = { quote: string; evidence: string };
export type Review = { confirmed: boolean; votes: string; violations: Violation[] };

/** Lower-case, whitespace-collapsed, for the verbatim-quote check. */
function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Violations in one reply whose quote really is in the task text. */
export function groundedViolations(reply: string, task: string): Violation[] {
  const o = jsonIn(reply);
  const list = Array.isArray(o?.violations) ? o!.violations : [];
  const t = norm(task);
  return list
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => ({ quote: String(v.quote ?? ""), evidence: String(v.evidence ?? "") }))
    .filter((v) => norm(v.quote).length >= 4 && t.includes(norm(v.quote)));
}

/**
 * The receipt as evidence: everything above its raw output section, capped.
 *
 * The worker writes part of the receipt — its claim is quoted near the top,
 * and the lines it wrote are shown — so neither the cut nor the cap may be
 * steerable by that text. The cut is at the receipt's own `## Output`
 * heading: a whole line, found only after the check table's heading (a claim
 * is quoted with "> ", so a "## Output" inside it is never a whole-line
 * heading, and nothing before the check table can end the evidence early).
 * The cap trims from the worker-influenced part above the check table, never
 * the check table itself: a long claim must not push the check results out of
 * what the reviewer reads.
 */
export function receiptEvidence(receipt: string, cap = 14_000): string {
  const checkedAt = receipt.search(/^## What was checked/m);
  const from = checkedAt >= 0 ? checkedAt : 0;
  const outAt = receipt.slice(from).search(/^## Output[ \t]*$/m);
  const end = outAt >= 0 ? from + outAt : receipt.length;
  const head = receipt.slice(0, from);
  const checks = receipt.slice(from, end).slice(0, cap);
  if (head.length + checks.length <= cap) return head + checks;
  const room = cap - checks.length;
  const marker = "\n… (receipt shortened here to fit; the check results follow)\n\n";
  return (room > marker.length ? head.slice(0, room - marker.length) + marker : "") + checks;
}

/**
 * Review a claim with `votes` independent asks. Unconfirmed only when more
 * than half found a grounded violation. A review that could not be run at all
 * returns null: molt then reports the claim as it would have without one,
 * and says the review did not happen.
 */
export async function reviewClaim(opts: {
  task: string;
  receipt: string;
  votes?: number;
  ask: Omit<AskOptions, "system" | "prompt" | "maxTokens" | "what">;
}): Promise<Review | null> {
  const votes = Math.max(1, opts.votes ?? 3);
  const prompt = `TASK TEXT:\n${opts.task}\n\nRECEIPT:\n${receiptEvidence(opts.receipt)}`;
  const replies = await Promise.all(
    Array.from({ length: votes }, () =>
      askModel({ ...opts.ask, system: REVIEW_SYSTEM, prompt, maxTokens: 2_000, what: "reviewing the claim" }),
    ),
  );
  const ok = replies.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  if (!ok.length) return null;
  const found = ok.map((r) => groundedViolations(r.text, opts.task));
  const flagged = found.filter((v) => v.length > 0);
  const confirmed = flagged.length * 2 <= ok.length;
  return { confirmed, votes: `${flagged.length}/${ok.length}`, violations: confirmed ? [] : flagged[0]! };
}
