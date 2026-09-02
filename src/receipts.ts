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
import { join } from "node:path";
import { MIN_SECRET_CHARS, redact } from "./redact.js";
import type { BarResult } from "./types.js";

export type Receipt = {
  path: string;
  attempt: number;
  verdict: "accepted" | "refused" | "exhausted";
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
    this.dir = join(root, ".molt", "receipts");
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.jsonl");
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
    /** True for a question: the bar ran advisory and could not refuse. */
    ask?: boolean;
    /** Every file the turn changed, with the hashes that prove it. */
    changed?: { path: string; before: string | null; after: string }[];
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
    /** What the model ran and read, in order, as one line each. */
    did?: string[];
  }): Receipt {
    const iso = new Date().toISOString();
    const seq = this.nextSeq();
    const file = `${String(seq).padStart(4, "0")}-${args.verdict}.md`;
    const p = join(this.dir, file);

    // A receipt is read by someone asking "what did it do, and should I
    // believe it finished?" — so it answers in that order. It used to open
    // with a provider name and a token count, which answer neither question,
    // and put the work itself nowhere at all.
    const verdictLine =
      args.verdict === "accepted" && args.ask
        ? "molt recorded this answer. A question runs the bar advisory — a turn that wrote " +
          "nothing cannot have broken anything — so no check could refuse it, and nothing " +
          "here is a verified change."
        : args.verdict === "accepted"
        ? "molt accepted this claim: every check that can block a completion passed."
        : args.verdict === "refused"
          ? "molt refused this claim and sent the failures back to the model."
          : "molt reported failure: the attempt limit was reached with checks still failing.";

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
        for (const c of task.checks) asked.push(`- \`${c}\``);
        asked.push("");
      }
      if (task.notes.length) {
        asked.push(
          "**Recorded, not verified.** No machine checked these. They are stated here",
          "because they were asked for, and molt will not report them as met:",
          "",
        );
        for (const n of task.notes) asked.push(`- ${n}`);
        asked.push("");
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
        "Hashes are SHA-256, taken immediately before and after molt wrote the file.",
        "`work-landed` re-reads each path and fails if what is there now does not match.",
        "",
      );
    }

    const did = args.did ?? [];
    if (did.length > 0) {
      work.push("## What the model ran", "");
      for (const line of did.slice(0, 40)) work.push(`- ${line}`);
      if (did.length > 40) work.push(`- … and ${did.length - 40} more`);
      work.push("");
    }

    const head = [
      `# molt receipt ${String(seq).padStart(4, "0")} — ${args.verdict}`,
      "",
      verdictLine,
      "",
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
      const finding = r.output.trim().split("\n")[0]?.slice(0, 90) ?? "";
      const verdict = r.ok ? "pass" : r.advisory ? "warn" : "**FAIL**";
      return (
        `| ${r.name} | ${verdict}${r.cached ? " (reused)" : ""} | ` +
        `${finding.replace(/\|/g, "\\|") || "—"} | ${r.durationMs} |`
      );
    });

    const detail: string[] = ["", "## Output", ""];
    for (const r of args.result.results) {
      // Plain key: value lines so a stranger can `rg "exit:" .molt/receipts`
      // and reconstruct the claim without parsing a markdown table.
      detail.push(
        `### ${r.name} — ${r.ok ? "pass" : "FAIL"}`,
        "",
        `check: ${r.name}`,
        `kind: ${r.kind}`,
        `command: ${r.detail}`,
        `exit: ${r.exitCode ?? "n/a"}`,
        `result: ${r.ok ? "pass" : "fail"}`,
        // Evidence of a different kind, and the receipt is the document handed
        // to someone who was not there to watch it run.
        `ran: ${r.cached ? "no — reused, nothing it watches had changed" : "yes"}`,
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
      `- attempt: ${args.attempt}`,
      `- provider: ${args.provider}`,
      `- model: ${args.model}`,
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
          ? "molt refused the completion claim and returned the failures to the model."
          : "The attempt limit was reached with checks still failing. molt reported failure rather than success.",
      "",
    ];

    // Redacted once, over the whole document, rather than field by field: the
    // claim, a command, and a check's stdout are three different ways for the
    // same key to arrive, and a filter with three entry points has three
    // chances to miss one.
    writeFileSync(p, redact([...head, ...rows, ...detail, ...foot].join("\n"), this.secrets), "utf8");

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
      // Only when the caller said what changed. A row with no count is
      // unknown, and unknown is not zero — it is counted as a change, which is
      // what every row written before this field existed already was.
      ...(args.changed === undefined ? {} : { changed: changed.length }),
      shedBatches: args.shedBatches,
      barMs: args.result.durationMs,
      failed: args.result.results.filter((r) => !r.ok).map((r) => r.name),
      file,
    };
    appendFileSync(this.indexPath, redact(JSON.stringify(record), this.secrets) + "\n", "utf8");

    return { path: p, attempt: args.attempt, verdict: args.verdict };
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
      verifiedChanges,
      answered,
      unchanged,
      falseClaimRate: presentRows.length ? (refused + exhausted) / presentRows.length : 0,
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
   * and the index lists both under it. This project's own `.molt` reached 26
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
