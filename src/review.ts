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
import { checkMutates } from "./checkwrites.js";
import { diagnoseFailure } from "./bar.js";

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
export type Review = {
  confirmed: boolean;
  votes: string;
  violations: Violation[];
  /**
   * Executable mode only: every grounded objection from every vote, with its
   * command and what running it showed. Only "demonstrated" ones were counted.
   */
  objections?: Objection[];
};

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

/** The receipt as evidence: everything above its raw output section, capped. */
export function receiptEvidence(receipt: string, cap = 14_000): string {
  return receipt.split("## Output")[0]!.slice(0, cap);
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
  /**
   * Executable objections: each must carry a command that demonstrates it,
   * and only those whose command ran and showed the failure are counted.
   * Absent, the review is exactly what it always was.
   */
  executable?: ExecutableReview;
}): Promise<Review | null> {
  const votes = Math.max(1, opts.votes ?? 3);
  const prompt = `TASK TEXT:\n${opts.task}\n\nRECEIPT:\n${receiptEvidence(opts.receipt)}`;
  const system = opts.executable ? REVIEW_SYSTEM_EXECUTABLE : REVIEW_SYSTEM;
  const replies = await Promise.all(
    Array.from({ length: votes }, () =>
      askModel({ ...opts.ask, system, prompt, maxTokens: 2_000, what: "reviewing the claim" }),
    ),
  );
  const ok = replies.filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  if (!ok.length) return null;
  if (opts.executable) {
    const judged = await substantiate(
      ok.map((r) => groundedObjections(r.text, opts.task)),
      opts.executable,
    );
    const counted = judged.map((list) => list.filter((o) => o.result === "demonstrated"));
    const flagged = counted.filter((v) => v.length > 0);
    const confirmed = flagged.length * 2 <= ok.length;
    return {
      confirmed,
      votes: `${flagged.length}/${ok.length}`,
      // The evidence a person (and the worker, if nudged) reads names the command that showed it.
      violations: confirmed ? [] : flagged[0]!.map((o) => ({ quote: o.quote, evidence: `${o.evidence} [shown by \`${o.command}\`: ${o.exit !== 0 ? `exited ${o.exit}` : "printed the offending value"}]` })),
      objections: judged.flat(),
    };
  }
  const found = ok.map((r) => groundedViolations(r.text, opts.task));
  const flagged = found.filter((v) => v.length > 0);
  const confirmed = flagged.length * 2 <= ok.length;
  return { confirmed, votes: `${flagged.length}/${ok.length}`, violations: confirmed ? [] : flagged[0]! };
}

/*
 * Executable objections (`--review-executable`, MAAT_REVIEW_EXECUTABLE=1).
 *
 * Measured 2026-10-07 (Grok worker, a 30B judge, 20 tasks): 18 runs passed
 * the hidden grader, 2 were verified, and in 5 of the 16 unverified passes
 * the review's objection was false — "tests were failing but now pass", a
 * misread right-aligned column, an email rule the task never stated. A weak
 * reviewer's prose vetoed correct work. With this option each objection must
 * come with a read-only shell command that demonstrates it on the work as it
 * stands, and Maat runs it: an objection counts only when its command ran and
 * exited non-zero, or printed the offending value it named. Everything else
 * is a note — an unsubstantiated objection — and vetoes nothing.
 *
 * Same discipline as everywhere: the model finds, something mechanical judges.
 */

export const REVIEW_SYSTEM_EXECUTABLE = [
  ...REVIEW_SYSTEM.split("\n").slice(0, -4),
  "",
  "Every violation must come with a COMMAND that demonstrates it: one read-only shell",
  "command, run from the project root on the work as it stands now, that either EXITS",
  "NON-ZERO because of the violation (for example: test \"$(wc -l < out.txt)\" -eq 365),",
  "or PRINTS the offending value, which you then copy verbatim, as one whole output",
  'line, into "shows". The command must not change anything: no writes into the',
  "project, no rm, mv, sed -i, git checkout/commit/reset, no installs. It is run, and an",
  "objection whose command is missing, does not run, or passes on the work is recorded",
  "as unsubstantiated and counts for nothing. If you cannot write such a command, the",
  "receipt does not show a violation. A command that cannot find or open what it reads",
  "shows nothing; to show a required file is missing, use: test -e PATH.",
  "",
  "Reply with JSON only:",
  '{"violations": [{"quote": "exact phrase from the task", "evidence": "what contradicts it", "command": "the shell command", "shows": "the offending output line, or empty when the command exits non-zero"}]}',
  'Return {"violations": []} if nothing in the receipt contradicts the task.',
].join("\n");

/** What running an objection's command established. Only "demonstrated" counts. */
export type ObjectionResult =
  | "demonstrated"
  /** No command came with it. */
  | "no-command"
  /** The command would change the work (lint L15, src/checkwrites.ts); never run. */
  | "lint"
  /** It ran and exited 0 without printing the offending value it named. */
  | "passed"
  /** It did not run: not found, could not open its input, timed out, killed. */
  | "did-not-run"
  /** Over the per-review command budget; never run. */
  | "not-run";

export type Objection = Violation & {
  /** Which reviewer (1-based) raised it. */
  vote: number;
  command?: string;
  shows?: string;
  result: ObjectionResult;
  exit?: number | null;
  /** The command's output, cut short. */
  output?: string;
  /** Why it does not count, in words, when it does not. */
  why?: string;
};

export type ObjectionRun = { code: number | null; stdout: string; stderr: string; timedOut?: boolean };

/** How an executable review runs a command: on a throwaway copy of the tree (src/scratch.ts). */
export type ExecutableReview = {
  run: (command: string) => Promise<ObjectionRun>;
  /** Most distinct commands one review runs; the rest are notes. Default 12. */
  maxCommands?: number;
};

/** One reply's grounded objections, with their command and shown value. */
export function groundedObjections(reply: string, task: string): (Violation & { command?: string; shows?: string })[] {
  const o = jsonIn(reply);
  const list = Array.isArray(o?.violations) ? o!.violations : [];
  const t = norm(task);
  return list
    .filter((v): v is Record<string, unknown> => !!v && typeof v === "object")
    .map((v) => {
      const command = typeof v.command === "string" && v.command.trim() ? v.command.trim() : undefined;
      const shows = typeof v.shows === "string" && v.shows.trim() ? v.shows : undefined;
      return {
        quote: String(v.quote ?? ""),
        evidence: String(v.evidence ?? ""),
        ...(command ? { command } : {}),
        ...(shows ? { shows } : {}),
      };
    })
    .filter((v) => norm(v.quote).length >= 4 && t.includes(norm(v.quote)));
}

const OUTPUT_CAP = 600;

/** Judge one ran command: did it demonstrate the objection? */
export function judgeObjectionRun(
  r: ObjectionRun,
  shows: string | undefined,
): { result: ObjectionResult; why?: string } {
  if (r.timedOut) return { result: "did-not-run", why: "the command timed out" };
  if (r.code === null) return { result: "did-not-run", why: "the command was killed" };
  if (r.code !== 0) {
    const d = diagnoseFailure(r.code, r.stdout, r.stderr);
    // A command that could not find or open what it reads demonstrates nothing
    // about the work: the objection names a path the reviewer guessed.
    if (d.didNotRun || d.hint) return { result: "did-not-run", why: d.hint ?? "the command did not run" };
    return { result: "demonstrated" };
  }
  if (shows !== undefined) {
    const want = shows.trim();
    const lines = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim());
    if (want && lines.includes(want)) return { result: "demonstrated" };
    return { result: "passed", why: `the command exited 0 and did not print the line it named (${JSON.stringify(shows.slice(0, 120))})` };
  }
  return { result: "passed", why: "the command exited 0 on the work" };
}

/**
 * Run every objection's command (each distinct command once) and judge it.
 * Exported for tests; reviewClaim calls it when `executable` is given.
 */
export async function substantiate(
  perVote: (Violation & { command?: string; shows?: string })[][],
  exec: ExecutableReview,
): Promise<Objection[][]> {
  const cap = Math.max(0, exec.maxCommands ?? 12);
  const ran = new Map<string, Promise<ObjectionRun | null>>();
  const out: Objection[][] = [];
  for (let i = 0; i < perVote.length; i++) {
    const list: Objection[] = [];
    for (const v of perVote[i]!) {
      const base = { quote: v.quote, evidence: v.evidence, vote: i + 1, ...(v.command ? { command: v.command } : {}), ...(v.shows ? { shows: v.shows } : {}) };
      if (!v.command) {
        list.push({ ...base, result: "no-command", why: "no command came with it" });
        continue;
      }
      const mutates = checkMutates(v.command);
      if (mutates) {
        list.push({ ...base, result: "lint", why: `L15-mutates: ${mutates}` });
        continue;
      }
      let p = ran.get(v.command);
      if (!p) {
        if (ran.size >= cap) {
          list.push({ ...base, result: "not-run", why: `over the review's budget of ${cap} command(s)` });
          continue;
        }
        p = exec.run(v.command).catch(() => null);
        ran.set(v.command, p);
      }
      const r = await p;
      if (!r) {
        list.push({ ...base, result: "did-not-run", why: "the command could not be started" });
        continue;
      }
      const j = judgeObjectionRun(r, v.shows);
      const output = `${r.stdout}${r.stderr}`;
      list.push({
        ...base,
        result: j.result,
        exit: r.code,
        ...(output ? { output: output.length > OUTPUT_CAP ? `${output.slice(0, OUTPUT_CAP)}…` : output } : {}),
        ...(j.why ? { why: j.why } : {}),
      });
    }
    out.push(list);
  }
  return out;
}

/** One objection as a line for a person: what was claimed, what was run, what it showed. */
export function objectionLine(o: Objection): string {
  const cmd = o.command ? ` — \`${o.command}\`` : "";
  const res =
    o.result === "demonstrated"
      ? o.exit !== undefined && o.exit !== 0
        ? `exited ${o.exit}`
        : "printed the offending value"
      : o.why ?? o.result;
  return `"${o.quote}" — ${o.evidence}${cmd} → ${o.result === "demonstrated" ? "demonstrated" : "unsubstantiated"}: ${res}`;
}
