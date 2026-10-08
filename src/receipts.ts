/**
 * Receipts: what the agent claimed, what was checked, and what the check
 * actually printed.
 *
 * A receipt is written for every completion attempt — including refused
 * ones. Refusals are the interesting record: they are the proof that molt
 * did not take the model's word for it. Deleting them would leave only the
 * successes, which is exactly the shape of evidence nobody should trust.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { MIN_SECRET_CHARS, redact } from "./redact.js";
import type { BarResult, CheckAuthor } from "./types.js";
import { authorWords, claimLabel, noteCoverage, resultAuthorWords, UNTESTED_CLAIM, type Tier } from "./tiers.js";
import { stateDir } from "./statedir.js";
import { WITHHELD, maskDeep, maskText } from "./withhold.js";

/** Where a receipt's full text goes when hidden commands were masked in it (src/withhold.ts). */
export const FULL_DIR = "full";

export type Receipt = {
  path: string;
  attempt: number;
  verdict: "accepted" | "refused" | "exhausted" | "undetermined";
};

/** One machine-readable line per receipt, for stats and for grepping. */
export type ReceiptRecord = {
  seq: number;
  iso: string;
  verdict: Receipt["verdict"];
  attempt: number;
  provider: string;
  model: string;
  sessionTokens: number;
  /**
   * Which session this attempt belongs to.
   *
   * Session totals climb across the attempts inside one session, so the
   * largest reading for a session is that session's spend. Without a way to
   * tell sessions apart, stats took the largest reading across ALL of them and
   * reported one session's spend as the project's — five sessions of real work
   * reported as whichever was biggest. Absent on receipts written before this
   * existed, which is why the fallback below infers boundaries instead.
   */
  session?: string;
  /** USD spent by the session when this claim was made, when a price is known. */
  costUsd?: number;
  shedBatches: number;
  barMs: number;
  failed: string[];
  file: string;
  /** How many files the turn changed. Absent on rows written before this existed. */
  changed?: number;
  /**
   * True for a question. The bar ran advisory because the turn wrote
   * nothing, so no check could refuse it — and an accepted answer is not a
   * verified change. Five of this project's sixteen "verified changes" were
   * questions before this field existed.
   */
  ask?: boolean;
  /** Set when the model was stopped and the tree judged as it stood. */
  endedBy?: "deadline" | "provider";
  /** True when the cost rests on molt's own token estimate anywhere in the session. */
  costEstimated?: boolean;
  /**
   * Set when the receipt file is gone but the index row remains.
   *
   * The record of a receipt is itself evidence. Repair marks a ghost rather
   * than deleting it — silently dropping the row would be the tool editing
   * its own audit trail.
   */
  missing?: boolean;
  /** Required checks this attempt never ran. Present only on `undetermined`. */
  notRun?: string[];
  /** The commit the judged tree sat on; `dirty` when it differed from it. */
  head?: string;
  dirty?: boolean;
  /** Hidden checks whose commands were shown to the model after a repeat failure. */
  revealed?: string[];
  /**
   * What the passing checks earned (src/tiers.ts): "verified", or
   * "passed-checks" with `tierReason` saying why not. Set on accepted claims;
   * the independent review can lower it after the receipt is written
   * (`amendTier`), so the index row is the last word and the receipt file,
   * hash-bound when it was written, is never rewritten.
   */
  tier?: Tier;
  tierReason?: string;
  /** The claim in words (src/tiers.ts claimLabel), e.g. "verified (independent checks: m)". */
  claim?: string;
  /** The strongest evidence class among the passing checks. */
  evidence?: string;
};

/** What `repair()` changed, and what it left alone. */
export type RepairReport = {
  /** Rows newly marked missing this run. */
  marked: number;
  /** Rows whose files exist, left exactly as recorded. */
  kept: number;
  /** Rows already marked missing, left alone. */
  alreadyMissing: number;
  /**
   * Rows that recorded no change count and whose receipt body says how many
   * files changed. The count is copied in, so stats can tell an accepted
   * change from an accepted answer on receipts written before the field
   * existed — five of this project's sixteen "verified changes" were
   * questions that changed nothing, and their receipts said so all along.
   */
  backfilled: number;
};

/**
 * How many files a receipt body says the turn changed, or undefined when the
 * body has no such section (a receipt from before the table existed).
 */
export function changedCountIn(body: string): number | undefined {
  const section = body.split("## What the model changed")[1]?.split("\n## ")[0];
  if (section === undefined) return undefined;
  if (/Nothing\. No file was modified/.test(section)) return 0;
  return (section.match(/^\| `/gm) ?? []).length;
}

/**
 * The headline number, and the one that needs its denominator said out loud.
 *
 * A harness that accepts a false claim on turn one spends fewer tokens per
 * CLAIM. molt spends more, and produces a change you can actually trust.
 * Reported per verified change, never per attempt.
 */
export type Stats = {
  /** Every index row — including receipts whose files are gone. */
  attempts: number;
  /** Index rows whose receipt file still exists on disk. */
  present: number;
  accepted: number;
  refused: number;
  exhausted: number;
  /** Claims neither accepted nor refused: required checks were not run. */
  undetermined: number;
  /**
   * Share of *present* completion claims that did not survive the bar.
   *
   * Computed only over receipts still on disk. A rate over files that are
   * gone is a number nobody can check.
   */
  falseClaimRate: number;
  totalTokens: number;
  /**
   * Accepted claims that changed something. The denominator of both ratios
   * below: an accepted question changed nothing and is counted in `answered`
   * instead. A row written before `changed` was recorded is counted here —
   * unknown is not zero.
   */
  verifiedChanges: number;
  /** Accepted answers to questions. Recorded, never counted as changes. */
  answered: number;
  /**
   * Accepted claims whose receipt records no file changed and that were not
   * marked as questions — receipts from before `ask` was recorded, mostly.
   * Not verified changes either.
   */
  unchanged: number;
  /** Tokens spent per verified change. Undefined with none. */
  tokensPerVerifiedChange?: number;
  /** USD spent across these sessions, when a price was known. */
  totalUsd?: number;
  /** True when any priced session's figure rests on molt's own token estimate. */
  costEstimated: boolean;
  /**
   * Dollars per ACCEPTED completion — the number to compare harnesses on, and
   * the one molt's own pitch stands or falls by. Same denominator caveat as
   * tokens: per verified change, never per attempt.
   */
  usdPerVerifiedChange?: number;
  byModel: Record<string, { attempts: number; accepted: number; refused: number }>;
};

/** The same digest the ledger records, so the two can be compared. */
function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** No receipt is worth reading if you have to scroll a thousand lines to it. */
const WROTE_MAX_LINES = 120;
const WROTE_MAX_PER_FILE = 40;

/**
 * The lines this turn actually wrote, on the receipt.
 *
 * A receipt used to prove a change happened — two hashes and a path — and then
 * say "read the diff". The diff it meant was `git diff`, which is the wrong
 * instrument twice over: it shows the working tree, not this turn, and on
 * 2026-09-07 this repository had three agents writing to it at once, so what
 * git showed was not attributable to anybody.
 *
 * molt has what git cannot supply here. The ledger records which lines each
 * tool call wrote, so the receipt can show this turn's work and nobody else's.
 *
 * It exists because of a specific miss. A turn was accepted at 11 of 11 checks
 * having quietly made a message less specific than the evidence allowed —
 * every check passed, and no check could have seen it. That class is only ever
 * caught by a person reading the change, so the reading is what got cheaper.
 * This does not judge the work; it puts it where it can be judged.
 */
function wroteSection(
  cwd: string,
  changed: { path: string; after: string; lines?: number[] }[],
): string[] {
  const withLines = changed.filter((c) => (c.lines?.length ?? 0) > 0);
  if (withLines.length === 0) return [];

  const out: string[] = ["## What the model wrote", ""];
  let budget = WROTE_MAX_LINES;
  let elided = 0;
  for (const c of withLines) {
    if (budget <= 0) {
      elided += 1;
      continue;
    }
    let text: string;
    try {
      text = readFileSync(join(cwd, c.path), "utf8");
    } catch {
      out.push(`\`${c.path}\` — gone from disk; nothing to show.`, "");
      continue;
    }
    /**
     * Only where the file still is what molt wrote.
     *
     * Line numbers are indices into the file as it stood at the write. If
     * something has changed it since — a later tool call, another session,
     * a formatter — those indices point at text this turn did not write, and
     * printing it under "what the model wrote" would be a fabrication of
     * exactly the kind this file exists to prevent.
     */
    if (sha256(text) !== c.after) {
      out.push(
        `\`${c.path}\` — changed since Maat wrote it, so its lines are not shown; the hashes ` +
          "above are what can still be proven.",
        "",
      );
      continue;
    }
    const all = text.split("\n");
    const want = [...new Set(c.lines ?? [])].sort((a, b) => a - b);
    const show = want.slice(0, Math.min(WROTE_MAX_PER_FILE, budget));
    budget -= show.length;
    const width = String(show.at(-1) ?? 0).length;
    out.push(`\`${c.path}\``, "", "```");
    let prev = 0;
    for (const n of show) {
      // A gap in the numbers is a gap in the file; say so rather than letting
      // two distant edits read as adjacent lines.
      if (prev && n > prev + 1) out.push("…");
      out.push(`${String(n).padStart(width)} │ ${all[n - 1] ?? ""}`);
      prev = n;
    }
    out.push("```");
    const rest = want.length - show.length;
    out.push(rest > 0 ? `… and ${rest} more changed line(s) in this file.` : "", "");
  }
  if (elided > 0) {
    out.push(`… and ${elided} more changed file(s), not shown.`, "");
  }
  out.push(
    "Substantive lines only — blank and comment-only lines are not listed. These are the",
    "lines Maat's own tools wrote this turn, which is narrower than `git diff` and is the",
    "only view that stays attributable when more than one thing is editing the tree.",
    "",
  );
  return out;
}

export class Receipts {
  readonly dir: string;
  private indexPath: string;
  /**
   * Values masked before anything is written.
   *
   * A receipt is meant to be handed to someone who does not trust you, which
   * is precisely the document a credential must not be inside. The claim is
   * model output and the check output is a command's stdout — either can
   * quote a key that was on screen.
   */
  private secrets: (string | undefined)[] = [];

  constructor(root: string) {
    this.dir = stateDir(root, "receipts");
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.jsonl");
  }

  /**
   * Hidden check commands, masked in every receipt written until `release`
   * (src/withhold.ts). The full text of each receipt written meanwhile is
   * held here, in memory, and written to `full/` when the job ends: the
   * worker can read this folder while it works.
   */
  private withheld: string[] = [];
  private pending: { file: string; full: string }[] = [];

  /** Mask these commands in every receipt from here until `release()`. */
  withhold(commands: readonly string[]): void {
    for (const c of commands) if (c && !this.withheld.includes(c)) this.withheld.push(c);
  }

  /**
   * Stop masking, and write the full text of every receipt that was masked to
   * `full/<file>`. Each receipt on disk stays byte for byte as written (it is
   * hash-bound in the integrity ledger); the full twin is a new file. Returns
   * what was written, relative to the receipts folder.
   */
  release(): { file: string; of: string; path: string }[] {
    const out: { file: string; of: string; path: string }[] = [];
    if (this.pending.length) {
      const dir = join(this.dir, FULL_DIR);
      mkdirSync(dir, { recursive: true });
      for (const p of this.pending) {
        const path = join(dir, p.file);
        const [title, ...rest] = p.full.split("\n");
        const text = [
          title,
          "",
          `> The full text of \`${p.file}\`, written when the job ended. While the job ran, that file`,
          `> carried each hidden check's command as \`${WITHHELD}\`; nothing else differs.`,
          ...rest,
        ].join("\n");
        try {
          writeFileSync(path, text, "utf8");
          out.push({ file: `${FULL_DIR}/${p.file}`, of: p.file, path });
        } catch {
          // A full twin that could not be written leaves the masked receipt and
          // the journal's released commands; the record is thinner, not wrong.
        }
      }
    }
    this.pending = [];
    this.withheld = [];
    return out;
  }

  /** The full twin of a receipt, once released; otherwise the receipt itself. */
  fullPath(receiptPath: string): string {
    const name = receiptPath.replace(/^.*[\\/]/, "");
    const twin = join(this.dir, FULL_DIR, name);
    return existsSync(twin) ? twin : receiptPath;
  }

  /** Register a value to mask in every receipt from here on. */
  protect(...values: (string | undefined)[]): void {
    for (const v of values) {
      if (v && v.length >= MIN_SECRET_CHARS && !this.secrets.includes(v)) this.secrets.push(v);
    }
  }

  write(args: {
    claim: string;
    result: BarResult;
    attempt: number;
    verdict: Receipt["verdict"];
    model: string;
    provider: string;
    sessionTokens: number;
    shedBatches: number;
    /** Which session this attempt belongs to, for honest totals. */
    session?: string;
    /** What the session had cost when this claim was made. */
    costUsd?: number;
    /** True when that figure rests on molt's own token estimate. */
    costEstimated?: boolean;
    /** The tier the passing checks earned, before any independent review (src/tiers.ts). */
    tier?: { tier: Tier; reason?: string; evidence: string; basis?: "person" | "independent" | "own"; by?: string[]; worker?: string };
    /**
     * Who wrote each check, by check name, recorded at seal time: the worker
     * model, a separate judge, a person, or the reference writer. A check not
     * named here is printed as unrecorded.
     */
    authors?: Record<string, CheckAuthor>;
    /** True for a question: the bar ran advisory and could not refuse. */
    ask?: boolean;
    /** The model was stopped (clock, provider) and the tree was judged as it stood. */
    endedBy?: "deadline" | "provider";
    /**
     * Every file the turn changed, with the hashes that prove it — and which
     * lines it wrote, so the receipt can show the work rather than describe it.
     */
    changed?: { path: string; before: string | null; after: string; lines?: number[] }[];
    /** Where those paths are rooted. Needed to read the lines back. */
    cwd?: string;
    /**
     * This task's own criteria, and the seal taken before work began.
     *
     * Separated into checked and recorded because conflating them is the one
     * dishonesty a receipt cannot afford. A command that ran and exited zero is
     * evidence. A sentence someone wrote down is intent. Both belong on the
     * document; only one of them is proof, and the reader must never have to
     * work out which is which.
     */
    task?: { seal: string; checks: string[]; notes: string[] };
    /**
     * Hidden checks whose commands were shown to the model after they failed
     * the same way twice. A pass after that is a pass against a check the
     * model had read, and the receipt says so.
     */
    revealed?: string[];
    /** What the model ran and read, in order, as one line each. */
    did?: string[];
    /** The requirement sign-out put to the model before this claim (src/signout.ts). */
    signout?: { requirements: string[]; matched: { requirement: string; calls: string[] }[]; unexercised: string[] };
    /**
     * The commit the tree sat on when the bar ran, and whether the tree
     * differed from it.
     *
     * A receipt is evidence about one tree at one moment. Without this it
     * read as evidence about "the project", and a summary written hours
     * later — "still in progress", "done" — could not be checked against it.
     * With it, anyone can ask git whether the tree they are looking at is the
     * one that was judged. `null` means not a repository, or no commits yet.
     */
    head?: { sha: string; dirty: boolean } | null;
  }): Receipt {
    const iso = new Date().toISOString();
    const seq = this.nextSeq();
    const file = `${String(seq).padStart(4, "0")}-${args.verdict}.md`;
    const p = join(this.dir, file);

    // A receipt is read by someone asking "what did it do, and should I
    // believe it finished?" — so it answers in that order. It used to open
    // with a provider name and a token count, which answer neither question,
    // and put the work itself nowhere at all.
    let verdictLine =
      args.verdict === "accepted" && args.ask
        ? "Maat recorded this answer. A question runs the bar advisory — a turn that wrote " +
          "nothing cannot have broken anything — so no check could refuse it, and nothing " +
          "here is a verified change."
        : args.verdict === "accepted"
        ? "Maat accepted this claim: every check that can block a completion passed."
        : args.verdict === "refused"
          ? "Maat refused this claim and sent the failures back to the model."
          : args.verdict === "undetermined"
            ? "Maat did not accept this claim: every check that ran passed, but checks " +
              "done.yml requires were not run. Nothing failed, and nothing established the rest."
            : "Maat reported failure: the attempt limit was reached with checks still failing.";

    if (args.verdict === "accepted" && !args.ask && args.tier) {
      verdictLine += args.tier.tier === "verified"
        ? `\n\nEvidence: ${args.tier.evidence}. A passing check of this class earns the word "verified".`
        : args.tier.tier === "passed-own-checks"
          ? `\n\nPassed own checks, not verified: ${args.tier.reason}. A model never judges its own work; a check from a person or another model is needed for "verified".`
          : args.tier.tier === "passed-untested"
            ? `\n\nPassed checks that did not test this work, not verified: ${args.tier.reason}. A check that passes on the tree as it was before the work cannot tell this work from none; "verified" needs one that failed before the work and passes now.`
            : `\n\nPassed its checks, not verified: ${args.tier.reason}. The strongest passing check is ${args.tier.evidence}.`;
      verdictLine += `\n\nClaim: ${
        args.tier.tier === "passed-checks"
          ? "passed its checks, not verified"
          : args.tier.tier === "passed-untested"
            ? UNTESTED_CLAIM
            : claimLabel("verified", args.tier)
      }.`;
    }
    if (args.revealed?.length) {
      verdictLine += `\n\nThe command of ${args.revealed.map((n) => `\`${n}\``).join(", ")} was shown to the model after it failed the same way twice; the work was judged against a check the model had read.`;
    }

    const changed = args.changed ?? [];
    // The task's own criteria go above what changed, because they are what the
    // change was supposed to achieve — a reader who sees the diff first has
    // already started judging it against nothing in particular.
    const task = args.task;
    const asked: string[] = [];
    if (task && (task.checks.length || task.notes.length)) {
      asked.push("## What this task had to satisfy", "");
      asked.push(
        `Set before the work began and sealed as \`${task.seal}\`. The seal is written to`,
        "the session journal before the first request, so these can be shown to predate",
        "the work rather than to claim they did.",
        "",
      );
      if (task.checks.length) {
        asked.push("**Machine-checked.** These ran with the bar and could refuse the claim:", "");
        for (const c of task.checks) {
          const name = c.slice(0, c.indexOf(": ") >= 0 ? c.indexOf(": ") : c.length);
          const a = args.authors?.[name] ?? args.authors?.[`task:${name}`];
          const guard = args.result.results.some((r) => (r.name === name || r.name === `task:${name}`) && r.tags?.includes("guard"));
          asked.push(`- \`${c}\` — written by ${authorWords(a)}${guard ? " · refuse-only guard: it can refuse this claim, never verify it" : ""}`);
        }
        asked.push("");
      }
      if (task.notes.length) {
        asked.push(
          "**Recorded, not verified.** No machine checked these. They are stated here",
          "because they were asked for, and Maat will not report them as met:",
          "",
        );
        // Coverage, display only: which of these a check that failed before
        // the work and passes now plausibly speaks to, matched by shared words.
        const disc = args.result.results.filter((r) => r.ok && r.beforeWork === "failed");
        const commandOf = (name: string) => {
          const bare = name.replace(/^task:/, "");
          const line = task.checks.find((c) => c === bare || c.startsWith(`${bare}: `) || c === name || c.startsWith(`${name}: `));
          return line ? line.slice(line.indexOf(": ") + 2) : "";
        };
        const cover = noteCoverage(task.notes, disc.map((r) => ({ name: r.name, text: `${commandOf(r.name)} ${r.detail ?? ""}` })));
        for (const c of cover) {
          asked.push(
            `- ${c.note} — ${
              c.by.length
                ? `plausibly covered by ${c.by.map((b) => `\`${b}\``).join(", ")}, which failed before the work and passes now`
                : "not matched to any check that failed before the work and passes now"
            }`,
          );
        }
        asked.push(
          "",
          "Coverage is matched by shared words, for the reader only; it gates nothing.",
          "",
        );
      }
    }

    const work: string[] = [...asked, "## What the model changed", ""];
    if (changed.length === 0) {
      work.push("Nothing. No file was modified during this turn.", "");
    } else {
      work.push("| file | before | after |", "|---|---|---|");
      for (const c of changed) {
        work.push(
          `| \`${c.path}\` | ${c.before === null ? "did not exist" : `\`${c.before.slice(0, 12)}\``} | ` +
            `\`${c.after.slice(0, 12)}\` |`,
        );
      }
      work.push(
        "",
        "Hashes are SHA-256, taken immediately before and after Maat wrote the file.",
        "`work-landed` re-reads each path and fails if what is there now does not match.",
        "",
      );
      work.push(...wroteSection(args.cwd ?? process.cwd(), changed));
    }

    const so = args.signout;
    if (so && so.requirements.length) {
      work.push("## Requirement sign-out", "");
      work.push(
        "Before this claim was judged, each stated requirement was put to the model beside the",
        "commands it ran that touch it. Matching is by keyword and path, not proof.",
        "",
      );
      for (const r of so.requirements) {
        const calls = so.matched.find((m) => m.requirement === r)?.calls;
        work.push(calls ? `- "${r}" — ran: ${calls.slice(-3).map((c) => `\`${c.slice(0, 110)}\``).join("; ")}` : `- "${r}" — not run before the sign-out`);
      }
      work.push("");
    }

    const did = args.did ?? [];
    if (did.length > 0) {
      work.push("## What the model ran", "");
      for (const line of did.slice(0, 40)) work.push(`- ${line}`);
      if (did.length > 40) work.push(`- … and ${did.length - 40} more`);
      work.push("");
    }

    const head = [
      `# Maat receipt ${String(seq).padStart(4, "0")} — ${args.verdict}`,
      "",
      verdictLine,
      "",
      ...(args.endedBy
        ? [
            args.endedBy === "deadline"
              ? "The turn's time budget ran out before the model said it was done; the sealed checks ran on the tree as it stood."
              : "The provider failed after work had been done; the sealed checks ran on the tree as it stood.",
            "",
          ]
        : []),
      "## What the model claimed",
      "",
      "> " + (args.claim.trim() || "(no final message)").split("\n").join("\n> "),
      "",
      ...work,
      "## What was checked, and what it established",
      "",
      "| check | verdict | what it established | ms |",
      "|---|---|---|---|",
    ];

    const rows = args.result.results.map((r) => {
      // The finding, not the label. "pass" is a header; "2 files modified and
      // verified byte-for-byte on disk" is the reason to believe it.
      // Masked before it is cut and escaped: a cut command is a prefix, and an
      // escaped `\|` is not the command's `|`; neither matches the mask after.
      const finding = maskText(r.output.trim(), this.withheld).split("\n")[0]?.slice(0, 90) ?? "";
      // "did not run" is not a softer FAIL, it is a different fact: the
      // command was never executed, so this row is evidence of nothing. A
      // receipt that prints it as a failure invites the reader to believe
      // something was tried and found wanting.
      // A pass that established nothing is not the same fact as a pass that
      // looked and found nothing wrong, and printing both as "pass" is how a
      // check that has never examined anything reads as a check that keeps
      // clearing the work.
      const verdict = r.skipped
        ? r.ok
          ? "n/a"
          : "**not run**"
        : r.ok
        ? r.established === false
          ? "pass (nothing to establish)"
          : "pass"
        : r.didNotRun
          ? "**did not run**"
          : r.advisory
            ? "warn"
            : "**FAIL**";
      return (
        `| ${r.name} | ${verdict}${r.cached ? " (reused)" : ""} | ` +
        `${finding.replace(/\|/g, "\\|") || "—"} | ${r.durationMs} |`
      );
    });

    const detail: string[] = ["", "## Output", ""];
    for (const r of args.result.results) {
      // Plain key: value lines so a stranger can `rg "exit:" .maat/receipts`
      // and reconstruct the claim without parsing a markdown table.
      detail.push(
        `### ${r.name} — ${
          r.skipped
            ? r.ok
              ? "not applicable"
              : "not run"
            : r.ok
            ? r.established === false
              ? "pass (nothing to establish)"
              : "pass"
            : r.didNotRun
              ? "did not run"
              : "FAIL"
        }`,
        "",
        `check: ${r.name}`,
        `kind: ${r.kind}`,
        `written by: ${resultAuthorWords(r, args.authors?.[r.name])}`,
        ...(r.tags?.includes("guard")
          ? ["role: refuse-only guard (it passed before the work: it can refuse this claim, never count toward verified)"]
          : []),
        ...(r.beforeWork
          ? [
              `before the work: ${
                r.beforeWork === "failed"
                  ? "failed (this check can tell the work from none)"
                  : r.beforeWork === "passed"
                    ? "passed (a guard: it cannot tell the work from none)"
                    : "not tried (it could not run then, or joined later), so it cannot tell the work from none"
              }`,
            ]
          : []),
        `command: ${r.detail}`,
        ...(r.ranInPlace ? [`ran in place: no throwaway copy of the tree — ${r.ranInPlace}`] : []),
        `exit: ${r.exitCode ?? "n/a"}`,
        `result: ${
          r.skipped
            ? r.ok
              ? "not-applicable"
              : "not-run"
            : r.ok ? (r.established === false ? "pass-vacuous" : "pass") : r.didNotRun ? "did-not-run" : "fail"
        }`,
        // Evidence of a different kind, and the receipt is the document handed
        // to someone who was not there to watch it run.
        `ran: ${
          r.skipped ? `no — ${r.skipped}` : r.cached ? "no — reused, nothing it watches had changed" : "yes"
        }`,
        `duration_ms: ${r.durationMs}`,
        "",
        "```",
        r.output.trim() || "(no output)",
        "```",
        "",
      );
    }

    const foot = [
      "---",
      "",
      "## Session",
      "",
      `- when: ${iso}`,
      ...(args.head === undefined
        ? []
        : [
            `- judged tree: ${
              args.head === null
                ? "not a git commit (no repository, or no commits yet)"
                : `${args.head.sha}${args.head.dirty ? " + uncommitted changes" : " (clean)"}`
            }`,
          ]),
      `- attempt: ${args.attempt}`,
      `- provider: ${args.provider}`,
      `- model: ${args.model}`,
      // Who wrote and reviewed the checks, when that is not the worker (judge.ts).
      ...(process.env.MAAT_JUDGE_MODEL?.trim() ? [`- judge: ${process.env.MAAT_JUDGE_MODEL.trim()}${process.env.MAAT_JUDGE_URL?.trim() ? ` at ${process.env.MAAT_JUDGE_URL.trim()}` : ""}`] : []),
      `- session tokens: ${args.sessionTokens}`,
      ...(args.costUsd === undefined
        ? []
        : [`- session cost: ${args.costEstimated ? "~" : ""}$${args.costUsd.toFixed(4)}`]),
      `- shed batches archived: ${args.shedBatches}`,
      `- bar duration: ${args.result.durationMs}ms`,
      "",
      args.verdict === "accepted"
        ? "Every check passed. This is the evidence behind that claim."
        : args.verdict === "refused"
          ? "Maat refused the completion claim and returned the failures to the model."
          : args.verdict === "undetermined"
            ? "Required checks were not run. Maat neither accepted nor refused the claim."
            : "The attempt limit was reached with checks still failing. Maat reported failure rather than success.",
      "",
    ];

    // Redacted once, over the whole document, rather than field by field: the
    // claim, a command, and a check's stdout are three different ways for the
    // same key to arrive, and a filter with three entry points has three
    // chances to miss one.
    const full = redact([...head, ...rows, ...detail, ...foot].join("\n"), this.secrets);
    const shown = maskText(full, this.withheld);
    if (shown !== full) {
      this.pending.push({ file, full });
      writeFileSync(
        p,
        shown +
          `\nHidden check commands are withheld from this file while the job runs; the seal above is a\n` +
          `hash over them. The full receipt is written to \`${FULL_DIR}/${file}\` when the job ends.\n`,
        "utf8",
      );
    } else {
      writeFileSync(p, full, "utf8");
    }

    const record: ReceiptRecord = {
      seq,
      iso,
      verdict: args.verdict,
      attempt: args.attempt,
      provider: args.provider,
      model: args.model,
      sessionTokens: args.sessionTokens,
      ...(args.session ? { session: args.session } : {}),
      ...(args.costUsd === undefined ? {} : { costUsd: args.costUsd }),
      ...(args.costEstimated ? { costEstimated: true } : {}),
      ...(args.ask ? { ask: true } : {}),
      ...(args.revealed?.length ? { revealed: [...args.revealed] } : {}),
      ...(args.endedBy ? { endedBy: args.endedBy } : {}),
      ...(args.verdict === "accepted" && !args.ask && args.tier
        ? {
            tier: args.tier.tier,
            evidence: args.tier.evidence,
            ...(args.tier.reason ? { tierReason: args.tier.reason } : {}),
            ...(args.tier.tier !== "passed-checks" ? { claim: claimLabel("verified", args.tier) } : {}),
          }
        : {}),
      // Only when the caller said what changed. A row with no count is
      // unknown, and unknown is not zero — it is counted as a change, which is
      // what every row written before this field existed already was.
      ...(args.changed === undefined ? {} : { changed: changed.length }),
      shedBatches: args.shedBatches,
      barMs: args.result.durationMs,
      failed: args.result.results.filter((r) => !r.ok && !r.skipped).map((r) => r.name),
      ...(args.result.undetermined?.length ? { notRun: [...args.result.undetermined] } : {}),
      ...(args.head ? { head: args.head.sha, ...(args.head.dirty ? { dirty: true } : {}) } : {}),
      file,
    };
    appendFileSync(this.indexPath, redact(JSON.stringify(maskDeep(record, this.withheld)), this.secrets) + "\n", "utf8");

    return { path: p, attempt: args.attempt, verdict: args.verdict };
  }

  /**
   * Lower a receipt's recorded tier once the whole turn has been judged.
   *
   * The independent review reads the receipt, so it cannot be in it: a claim
   * that passed on strong checks and was then contradicted would otherwise sit
   * in the index as "verified". Only the index row changes; the receipt file
   * is hash-bound and stays byte for byte as written. A row that is not
   * there, or an index that cannot be read, is left alone.
   */
  amendTier(file: string, tier: { tier: Tier; reason?: string; claim?: string }): boolean {
    try {
      if (!existsSync(this.indexPath)) return false;
      let hit = false;
      const out = readFileSync(this.indexPath, "utf8")
        .split("\n")
        .map((l) => {
          if (!l.trim()) return l;
          try {
            const r = JSON.parse(l) as ReceiptRecord;
            if (r.file !== file) return l;
            hit = true;
            const { tierReason: _drop, claim: _was, ...rest } = r;
            return JSON.stringify({
              ...rest,
              tier: tier.tier,
              ...(tier.reason ? { tierReason: redact(tier.reason, this.secrets) } : {}),
              ...(tier.claim ? { claim: tier.claim } : {}),
            });
          } catch {
            return l;
          }
        });
      if (hit) writeFileSync(this.indexPath, out.join("\n"), "utf8");
      return hit;
    } catch {
      return false;
    }
  }

  /**
   * Reconcile the index against the files on disk.
   *
   * A row whose file exists is left exactly as it is. A row whose file is
   * gone is marked missing rather than deleted: the record of a receipt is
   * itself evidence, and silently dropping it would be the tool editing its
   * own audit trail. Safe to run twice — the second pass finds nothing to
   * change.
   */
  repair(): RepairReport {
    if (!existsSync(this.indexPath)) return { marked: 0, kept: 0, alreadyMissing: 0, backfilled: 0 };
    const lines = readFileSync(this.indexPath, "utf8").split("\n").filter((l) => l.trim());
    const out: string[] = [];
    let marked = 0;
    let kept = 0;
    let alreadyMissing = 0;
    let backfilled = 0;
    let changed = false;
    for (const line of lines) {
      let row: ReceiptRecord;
      try {
        row = JSON.parse(line) as ReceiptRecord;
      } catch {
        // An unparseable line is not ours to "fix". Leave the bytes.
        out.push(line);
        continue;
      }
      // Existence is the only thing repair is allowed to notice. A present
      // file means the recorded row is still the receipt; a missing one
      // means the row becomes the evidence that it ever existed.
      const onDisk = typeof row.file === "string" && existsSync(join(this.dir, row.file));
      if (onDisk) {
        kept += 1;
        // The one fact repair may add: what the receipt itself says changed.
        // Nothing is invented — a body with no table leaves the row as it was.
        if (row.changed === undefined) {
          const n = changedCountIn(readFileSync(join(this.dir, row.file), "utf8"));
          if (n !== undefined) {
            backfilled += 1;
            changed = true;
            out.push(JSON.stringify({ ...row, changed: n }));
            continue;
          }
        }
        out.push(line);
        continue;
      }
      if (row.missing) {
        alreadyMissing += 1;
        out.push(line);
        continue;
      }
      marked += 1;
      changed = true;
      out.push(JSON.stringify({ ...row, missing: true }));
    }
    if (changed) writeFileSync(this.indexPath, out.join("\n") + "\n");
    return { marked, kept, alreadyMissing, backfilled };
  }

  records(): ReceiptRecord[] {
    if (!existsSync(this.indexPath)) return [];
    return readFileSync(this.indexPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as ReceiptRecord];
        } catch {
          return [];
        }
      });
  }

  stats(): Stats {
    const rows = this.records();
    // Verdicts, rates, and cost are computed over receipts still on disk.
    // Counting a gone file as a refused claim produces a rate nobody can
    // open; the index still records the attempt.
    // One receipt file, one row. Before `nextSeq` read the index, a deleted
    // receipt's number was reissued, so two rows can name the same file with
    // different facts in them; the later row is the one whose receipt is on
    // disk, and counting both made "still on disk" one larger than the
    // directory. This project's own index carried exactly that phantom.
    const byFile = new Map<string, ReceiptRecord>();
    for (const r of rows) {
      if (typeof r.file === "string" && existsSync(join(this.dir, r.file))) byFile.set(r.file, r);
    }
    const presentRows = [...byFile.values()];
    const byModel: Stats["byModel"] = {};
    let accepted = 0;
    let refused = 0;
    let exhausted = 0;
    let undetermined = 0;
    let verifiedChanges = 0;
    let answered = 0;
    let unchanged = 0;
    let totalTokens = 0;
    let totalUsd: number | undefined;

    for (const r of presentRows) {
      const m = (byModel[r.model] ??= { attempts: 0, accepted: 0, refused: 0 });
      m.attempts += 1;
      if (r.verdict === "accepted") {
        accepted += 1;
        m.accepted += 1;
        if (r.ask) answered += 1;
        else if (r.changed === 0) unchanged += 1;
        else verifiedChanges += 1;
      } else if (r.verdict === "undetermined") {
        // Not a false claim and not a verified one. Counted apart from both,
        // so an unasked check never moves the false-claim rate either way.
        undetermined += 1;
      } else {
        refused += r.verdict === "refused" ? 1 : 0;
        exhausted += r.verdict === "exhausted" ? 1 : 0;
        m.refused += 1;
      }
    }

    // A session's totals climb across its own attempts, so the largest reading
    // for a session is that session's spend — and the project's spend is the
    // sum of those, not the largest of them. Receipts written before sessions
    // were recorded are grouped by watching the counter reset: within a
    // session it only rises, so a drop is a new session.
    let group = 0;
    let previous = -1;
    const perSession = new Map<
      string,
      { tokens: number; usd?: number; verified: number; estimated: boolean }
    >();
    for (const r of presentRows) {
      if (r.session === undefined && r.sessionTokens < previous) group += 1;
      previous = r.session === undefined ? r.sessionTokens : -1;
      const key = r.session ?? `inferred-${group}`;
      const seen = perSession.get(key) ?? { tokens: 0, verified: 0, estimated: false };
      seen.tokens = Math.max(seen.tokens, r.sessionTokens);
      if (typeof r.costUsd === "number") seen.usd = Math.max(seen.usd ?? 0, r.costUsd);
      if (r.costEstimated) seen.estimated = true;
      if (r.verdict === "accepted" && !r.ask && (r.changed === undefined || r.changed > 0)) {
        seen.verified += 1;
      }
      perSession.set(key, seen);
    }
    // Dollars are divided only by the changes that were priced. Dividing the
    // priced sessions' dollars by every acceptance — four of this project's
    // sixteen came from sessions with no price — reported $0.68 where the
    // priced changes cost $0.90 each.
    let pricedVerified = 0;
    let costEstimated = false;
    for (const { tokens, usd, verified, estimated } of perSession.values()) {
      totalTokens += tokens;
      if (usd !== undefined) {
        totalUsd = (totalUsd ?? 0) + usd;
        pricedVerified += verified;
        if (estimated) costEstimated = true;
      }
    }

    return {
      attempts: rows.length,
      present: presentRows.length,
      accepted,
      refused,
      exhausted,
      undetermined,
      verifiedChanges,
      answered,
      unchanged,
      falseClaimRate:
        presentRows.length - undetermined > 0
          ? (refused + exhausted) / (presentRows.length - undetermined)
          : 0,
      totalTokens,
      tokensPerVerifiedChange: verifiedChanges ? Math.round(totalTokens / verifiedChanges) : undefined,
      totalUsd,
      usdPerVerifiedChange:
        pricedVerified && totalUsd !== undefined ? totalUsd / pricedVerified : undefined,
      costEstimated,
      byModel,
    };
  }

  /** Search receipt bodies. Returns the file and the matching section. */
  grep(pattern: string): { file: string; excerpt: string }[] {
    const re = new RegExp(pattern, "i");
    const hits: { file: string; excerpt: string }[] = [];
    for (const file of this.list()) {
      const body = readFileSync(join(this.dir, file), "utf8");
      for (const section of body.split(/^#{2,3} /m).slice(1)) {
        if (re.test(section)) hits.push({ file, excerpt: "## " + section.trim() });
      }
    }
    return hits;
  }

  read(file: string): string {
    return readFileSync(join(this.dir, file), "utf8");
  }

  count(): number {
    if (!existsSync(this.dir)) return 0;
    return readdirSync(this.dir).filter((f) => /^\d{4}-.*\.md$/.test(f)).length;
  }

  /**
   * The next receipt number: one past the highest ever issued.
   *
   * It used to be `count()` — how many receipt files exist *now* — which is
   * only the same thing while nobody deletes one. Delete `0000` and the next
   * write is numbered `0001` again, so two different receipts share a number
   * and the index lists both under it. This project's own `.maat` reached 26
   * index rows over 9 files with sequences 0000–0008 each duplicated, and
   * `molt receipts --show 0000-refused.md` reported no match for something the
   * listing had just printed.
   *
   * A receipt is the document you hand to someone who does not trust you.
   * Reusing its number is not a cosmetic problem.
   *
   * Taken from the index as well as the directory, because the index is the
   * part that remembers what was deleted — that is the whole point of it.
   */
  private nextSeq(): number {
    const seqOf = (name: string): number => {
      const m = /^(\d{4})-/.exec(name);
      return m ? Number(m[1]) : -1;
    };
    let highest = -1;
    if (existsSync(this.dir)) {
      for (const f of readdirSync(this.dir)) highest = Math.max(highest, seqOf(f));
    }
    for (const row of this.records()) highest = Math.max(highest, seqOf(row.file ?? ""));
    return highest + 1;
  }

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
  }
}

/**
 * A receipt's number and verdict, read from its file name.
 *
 * Any verdict the name carries. The window's listing matched only the three
 * that existed when it was written, and turned a fourth (`undetermined`)
 * into receipt 0, verdict "unknown": a real record shown as a malformed one.
 */
export function receiptName(file: string): { n: number; verdict: string } {
  const m = /^(\d+)-([a-z]+)\.md$/.exec(file);
  return { n: m ? Number(m[1]) : 0, verdict: m?.[2] ?? "unknown" };
}
