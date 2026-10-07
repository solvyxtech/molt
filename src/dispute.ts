/**
 * Disputing a drafted check that contradicts the task.
 *
 * molt drafts checks from the task text before any work exists, seals them,
 * and hides them from the model doing the work. The drafting model can be
 * wrong. Of the 29 Terminal-Bench 2.0 claims molt "verified" that the grader
 * failed (two full passes, Space Bunny Alpha), about ten were a wrong check
 * that the work was bent to fit: an invented `-checkend` for "valid for 365
 * days", "exactly 32000 lines" for "<32,000 lines", a guessed answer
 * hard-coded as the expected value, a wrong library call the model then
 * patched site-packages to satisfy. Twice the model said so in its claim —
 * "the counts were taken from the check's expected values" — and complied
 * anyway, because the refusal told it to make the checks pass and gave it no
 * other way out.
 *
 * This is the other way out. A model that believes a failing drafted check
 * contradicts the task writes one line:
 *
 *     DISPUTE <check name>: "<exact words from the task>" — <why>
 *
 * and claims done again. Independent reviews, which did not do the work,
 * read the task text, the check's command, its output and the dispute, and
 * rule. A check is retired only when a majority find it contradicts the
 * task AND quote the task text that shows it — quotes are string-matched
 * against the task, so a ruling cannot rest on a requirement nobody stated.
 * Retiring is recorded; a check a person wrote is never disputable; each
 * check can be disputed once.
 */
import { askModel, jsonIn, type AskOptions } from "./ask.js";

export type Dispute = { name: string; quote: string; why: string };
export type Ruling = { name: string; upheld: boolean; votes: string; quote?: string; reason?: string };

/** `DISPUTE name: "quote" — why`, one per line, anywhere in the reply. */
const DISPUTE_LINE = /^\s*[*_`>-]*\s*DISPUTE\s+`?([\w.:@/-]+?)`?\s*:\s*["“](.+?)["”]\s*(?:[—–-]+\s*(.*))?$/gim;

export function parseDisputes(text: string): Dispute[] {
  const out: Dispute[] = [];
  const seen = new Set<string>();
  for (const m of (text ?? "").matchAll(DISPUTE_LINE)) {
    const name = m[1]!.replace(/^task:/, "");
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, quote: m[2]!.trim(), why: (m[3] ?? "").trim() });
  }
  return out;
}

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Is `quote` really in `task` — whitespace and case aside, and long enough to mean something? */
export function quotedIn(quote: string, task: string): boolean {
  const q = norm(quote);
  return q.length >= 4 && norm(task).includes(q);
}

export const ARBITER_SYSTEM = [
  "You settle a disagreement between a coding agent and a check. You did not write either.",
  "Before the work began, a model read the task text and wrote a shell check for it. The check",
  "failed, and the agent disputes it. You get the task text, the check's command, its output,",
  "and the agent's dispute.",
  "",
  "Decide one thing: does the CHECK contradict or go beyond what the task text states? It does",
  "if it demands something the task does not ask for (a stricter or different limit, format,",
  "path or value), asserts an answer the task does not give and the checker could only have",
  "guessed, or tests the task's requirement wrongly (an off-by-one, a wrong API). It does NOT",
  "if the check is a fair reading of the task and the work simply fails it — then the agent",
  "must fix the work. When unsure, the check stands.",
  "",
  "Reply with JSON only:",
  '{"contradicts": true|false, "quote": "the exact task words the check gets wrong (verbatim)", "reason": "one sentence"}',
].join("\n");

/**
 * Rule on one dispute with `votes` independent asks (one by default). Upheld only when more
 * than half say the check contradicts the task with a quote that really is in
 * the task text. Null when no ask could be made at all.
 */
export async function arbitrate(opts: {
  task: string;
  check: { name: string; run: string };
  output: string;
  dispute: Dispute;
  votes?: number;
  ask: Omit<AskOptions, "system" | "prompt" | "maxTokens" | "what">;
}): Promise<Ruling | null> {
  const votes = Math.max(1, opts.votes ?? 1);
  const prompt =
    `TASK TEXT:\n${opts.task}\n\nCHECK "${opts.check.name}":\n${opts.check.run}\n\n` +
    `CHECK OUTPUT (it failed):\n${opts.output.slice(0, 4000)}\n\n` +
    // The task words the agent points at, and not its argument: a persuasive
    // explanation moves a judge whether or not it is right (people judged
    // wrong assertions at chance, and explanations made them more confident —
    // arXiv 2607.08885). The ruling rests on the task, the check and its output.
    `THE AGENT SAYS THE CHECK CONTRADICTS THESE TASK WORDS:\n"${opts.dispute.quote}"`;
  const replies = await Promise.all(
    Array.from({ length: votes }, () =>
      askModel({ ...opts.ask, system: ARBITER_SYSTEM, prompt, maxTokens: 1_500, what: "ruling on a disputed check" }),
    ),
  );
  const ok = replies.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  if (!ok.length) return null;
  const yes = ok
    .map((r) => jsonIn(r.text))
    .filter((o) => o && o.contradicts === true && typeof o.quote === "string" && quotedIn(o.quote, opts.task));
  const upheld = yes.length * 2 > ok.length;
  return {
    name: opts.check.name,
    upheld,
    votes: `${yes.length}/${ok.length}`,
    ...(upheld ? { quote: String(yes[0]!.quote), reason: String(yes[0]!.reason ?? "") } : {}),
  };
}

/** What a refused claim is told when a drafted check is among the failures. */
export const DISPUTE_HINT = [
  "The checks marked (command withheld) were drafted by a model from the task text before the",
  "work began, and a drafted check can be wrong. Never change work you believe is correct just",
  "to satisfy one, and never change the environment to make one pass: not /bin/sh or other",
  "system binaries, not site-packages or other installed packages, not .maat/, not the test or",
  "check files, not the clock. If you are confident a check contradicts the task, write this line",
  "in your reply and claim done again:",
  '  DISPUTE <check name>: "<exact words from the task>" — <why the check is wrong>',
  "Independent reviewers compare the check with the task. A check that contradicts the task is",
  "retired and recorded; one that is a fair reading of it stands, and the work must meet it.",
  "Each check can be disputed once.",
].join("\n");
