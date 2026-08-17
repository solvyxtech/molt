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
  shedBatches: number;
  barMs: number;
  failed: string[];
  file: string;
};

/**
 * The headline number, and the one that needs its denominator said out loud.
 *
 * A harness that accepts a false claim on turn one spends fewer tokens per
 * CLAIM. molt spends more, and produces a change you can actually trust.
 * Reported per verified change, never per attempt.
 */
export type Stats = {
  attempts: number;
  accepted: number;
  refused: number;
  exhausted: number;
  /** Share of completion claims that did not survive the bar. */
  falseClaimRate: number;
  totalTokens: number;
  /** Tokens spent per ACCEPTED completion. Undefined with nothing accepted. */
  tokensPerVerifiedChange?: number;
  byModel: Record<string, { attempts: number; accepted: number; refused: number }>;
};

export class Receipts {
  readonly dir: string;
  private indexPath: string;

  constructor(root: string) {
    this.dir = join(root, ".molt", "receipts");
    mkdirSync(this.dir, { recursive: true });
    this.indexPath = join(this.dir, "index.jsonl");
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
  }): Receipt {
    const iso = new Date().toISOString();
    const seq = this.count();
    const file = `${String(seq).padStart(4, "0")}-${args.verdict}.md`;
    const p = join(this.dir, file);

    const head = [
      `# molt receipt ${String(seq).padStart(4, "0")} — ${args.verdict}`,
      "",
      `- when: ${iso}`,
      `- attempt: ${args.attempt}`,
      `- provider: ${args.provider}`,
      `- model: ${args.model}`,
      `- session tokens: ${args.sessionTokens}`,
      `- shed batches archived: ${args.shedBatches}`,
      `- bar duration: ${args.result.durationMs}ms`,
      "",
      "## Claim",
      "",
      "The model asserted the task was complete, saying:",
      "",
      "> " + (args.claim.trim() || "(no final message)").split("\n").join("\n> "),
      "",
      "## Checks",
      "",
      "| check | kind | detail | exit | result | ms |",
      "|---|---|---|---|---|---|",
    ];

    const rows = args.result.results.map(
      (r) =>
        `| ${r.name} | ${r.kind} | \`${r.detail.replace(/\|/g, "\\|").slice(0, 60)}\` | ` +
        `${r.exitCode ?? "—"} | ${r.ok ? "pass" : "**FAIL**"} | ${r.durationMs} |`,
    );

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
      args.verdict === "accepted"
        ? "Every check passed. This is the evidence behind that claim."
        : args.verdict === "refused"
          ? "molt refused the completion claim and returned the failures to the model."
          : "The attempt limit was reached with checks still failing. molt reported failure rather than success.",
      "",
    ];

    writeFileSync(p, [...head, ...rows, ...detail, ...foot].join("\n"), "utf8");

    const record: ReceiptRecord = {
      seq,
      iso,
      verdict: args.verdict,
      attempt: args.attempt,
      provider: args.provider,
      model: args.model,
      sessionTokens: args.sessionTokens,
      shedBatches: args.shedBatches,
      barMs: args.result.durationMs,
      failed: args.result.results.filter((r) => !r.ok).map((r) => r.name),
      file,
    };
    appendFileSync(this.indexPath, JSON.stringify(record) + "\n", "utf8");

    return { path: p, attempt: args.attempt, verdict: args.verdict };
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
    const byModel: Stats["byModel"] = {};
    let accepted = 0;
    let refused = 0;
    let exhausted = 0;
    let totalTokens = 0;

    for (const r of rows) {
      const m = (byModel[r.model] ??= { attempts: 0, accepted: 0, refused: 0 });
      m.attempts += 1;
      if (r.verdict === "accepted") {
        accepted += 1;
        m.accepted += 1;
      } else {
        refused += r.verdict === "refused" ? 1 : 0;
        exhausted += r.verdict === "exhausted" ? 1 : 0;
        m.refused += 1;
      }
      totalTokens = Math.max(totalTokens, r.sessionTokens);
    }

    return {
      attempts: rows.length,
      accepted,
      refused,
      exhausted,
      falseClaimRate: rows.length ? (refused + exhausted) / rows.length : 0,
      totalTokens,
      tokensPerVerifiedChange: accepted ? Math.round(totalTokens / accepted) : undefined,
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

  list(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => /^\d{4}-.*\.md$/.test(f))
      .sort();
  }
}
