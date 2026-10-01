/**
 * Judgment: the claims the scale could not settle, and the person's ruling.
 *
 * In the weighing, a heart that balances against the feather passes. Some
 * claims do not settle: a check a person wrote refused the work ("not
 * proven"), Maat's own drafted checks disagreed with it, nothing could check
 * it at all ("unverified"), or it passed its checks and the independent
 * reviewers still found the task contradicted. Those are not failures — on
 * the local suite most of them were good work — and they are not passes
 * either. They go to the one who presides: the person.
 *
 * Every such job opens a case here. A ruling closes it:
 *
 *   accepted     the work is right; Maat's warning was false
 *   sent back    the work is wrong; the warning was true
 *   check wrong  the work is right and the check that refused it was wrong
 *
 * A ruling never turns a case into "verified". Maat did not prove the work;
 * a person judged it, and the record says exactly that.
 *
 * The rulings are also the only way to measure, on real work rather than a
 * benchmark, whether Maat's warnings are true — the one gate it has not
 * met — and "check wrong" rulings are fed back to the check drafter so the
 * same mistake is not sealed again in this project.
 *
 * Storage is one append-only, hash-chained file, `.maat/judgment.jsonl`, in
 * the same shape as the journal: change or remove a line and `verify` names
 * the line where the chain broke.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { redact } from "./redact.js";
import { stateFile } from "./statedir.js";
import type { JobOutcome } from "./types.js";

export const JUDGMENT_FILE = "judgment.jsonl";

/** Why the scale did not settle, in Maat's terms. */
export type CaseReason =
  /** A check a person wrote refused the work. */
  | "not proven"
  /** Refused only by checks Maat drafted for itself. */
  | "drafted checks disagree"
  /** Every check was retired by an upheld dispute. */
  | "checks retired"
  /** Nothing could check the work. */
  | "nothing checked it"
  /** It passed its checks; a majority of independent reviewers found a violation. */
  | "reviewers disagree";

export type Ruling = "accepted" | "sent back" | "check wrong";
export const RULINGS: readonly Ruling[] = ["accepted", "sent back", "check wrong"];

export type CaseCheck = {
  name: string;
  /** The command, or the builtin's identifier. */
  detail: string;
  /** Truncated output. */
  output: string;
  /** Drafted by Maat and hidden from the working model. */
  drafted: boolean;
};

export type CaseRecord = {
  type: "case";
  n: number;
  iso: string;
  session?: string;
  job: number;
  model?: string;
  task: string;
  outcome: JobOutcome;
  reason: CaseReason;
  checks: CaseCheck[];
  violations?: { quote: string; evidence: string }[];
  /** Project-relative path of the attempt's receipt, when one was written. */
  receipt?: string;
  /** Project-relative paths the job wrote. */
  files: string[];
  /** The work was put back by `--revert`: accepting it cannot restore it. */
  restored?: boolean;
};

export type RulingRecord = {
  type: "ruling";
  case: number;
  iso: string;
  ruling: Ruling;
  note?: string;
  /** For "check wrong": which checks. Defaults to every check on the case. */
  checks?: string[];
};

type Line = (CaseRecord | RulingRecord) & { prev: string; hash: string };

const GENESIS = "0".repeat(64);
const MAX_TASK = 4000;
const MAX_OUTPUT = 2000;

function hashLine(l: Omit<Line, "hash">): string {
  return createHash("sha256").update(JSON.stringify(l)).digest("hex");
}

/** Plain words for a reason, as a person reads it. */
export function reasonText(r: CaseReason): string {
  switch (r) {
    case "not proven":
      return "a check you wrote refused the work";
    case "drafted checks disagree":
      return "Maat's own drafted checks disagreed with the work";
    case "checks retired":
      return "every check was retired by dispute; nothing was left to judge it";
    case "nothing checked it":
      return "no check could tell either way";
    case "reviewers disagree":
      return "it passed its checks, but independent reviewers found the task contradicted";
  }
}

/** Plain words for a ruling. */
export function rulingText(r: Ruling): string {
  return r === "accepted" ? "accepted — the work is right" : r === "sent back" ? "sent back — the work is wrong" : "the check was wrong — the work is right";
}

export function isRuling(s: string): s is Ruling {
  return (RULINGS as readonly string[]).includes(s);
}

/**
 * Which finished jobs open a case, and why. Null for jobs the scale settled
 * (verified and confirmed, or answered), for jobs that are not claims
 * (cancelled, error, stopped), and for an unverified turn that wrote nothing:
 * that is an unchecked answer, not work on disk to judge.
 */
export function caseReason(ev: {
  outcome: JobOutcome;
  checksDisagree?: string[];
  review?: { confirmed: boolean };
  wrote: boolean;
  allRetired?: boolean;
}): CaseReason | null {
  if (ev.outcome === "not proven") return "not proven";
  if (ev.outcome === "unverified") {
    if (ev.checksDisagree?.length) return "drafted checks disagree";
    if (!ev.wrote) return null;
    return ev.allRetired ? "checks retired" : "nothing checked it";
  }
  if (ev.outcome === "verified" && ev.review && !ev.review.confirmed) return "reviewers disagree";
  return null;
}

export type OpenCase = Omit<CaseRecord, "type" | "n" | "iso">;

export type CaseView = CaseRecord & {
  /** Every ruling on this case, oldest first; the last one stands. */
  rulings: RulingRecord[];
  ruling?: RulingRecord;
};

export class Judgments {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** Where the file is, or would be. A `.molt/` project keeps its own. */
  get path(): string {
    return stateFile(this.root, JUDGMENT_FILE);
  }

  private lines(): Line[] {
    const p = this.path;
    if (!existsSync(p)) return [];
    const out: Line[] = [];
    for (const raw of readFileSync(p, "utf8").split("\n")) {
      if (!raw.trim()) continue;
      try {
        out.push(JSON.parse(raw) as Line);
      } catch {
        // A torn last line from a crash mid-write. `verify` reports it.
      }
    }
    return out;
  }

  private append(rec: CaseRecord | RulingRecord): void {
    const all = this.lines();
    const prev = all.length ? all[all.length - 1].hash : GENESIS;
    const body = { ...rec, prev } as Omit<Line, "hash">;
    const line: Line = { ...body, hash: hashLine(body) } as Line;
    const p = this.path;
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(line) + "\n");
  }

  /** Open a case. Returns its number. */
  open(c: OpenCase): CaseRecord {
    const n = this.lines().filter((l) => l.type === "case").length + 1;
    const rel = (p: string) => {
      const r = relative(this.root, p);
      return r.startsWith("..") ? p : r;
    };
    const rec: CaseRecord = {
      type: "case",
      n,
      iso: new Date().toISOString(),
      ...c,
      task: redact(c.task).slice(0, MAX_TASK),
      checks: c.checks.map((k) => ({ ...k, output: redact(k.output).slice(-MAX_OUTPUT) })),
      files: [...new Set(c.files.map(rel))].sort(),
      ...(c.receipt ? { receipt: rel(c.receipt) } : {}),
    };
    this.append(rec);
    return rec;
  }

  /** Rule on a case. Throws when there is no such case. */
  rule(n: number, ruling: Ruling, opts: { note?: string; checks?: string[] } = {}): RulingRecord {
    const c = this.get(n);
    if (!c) throw new Error(`no case ${n}`);
    const note = opts.note?.trim();
    const rec: RulingRecord = {
      type: "ruling",
      case: n,
      iso: new Date().toISOString(),
      ruling,
      ...(note ? { note: redact(note).slice(0, MAX_TASK) } : {}),
      ...(ruling === "check wrong" ? { checks: opts.checks?.length ? opts.checks : c.checks.map((k) => k.name) } : {}),
    };
    this.append(rec);
    return rec;
  }

  /** Every case with its rulings, newest first. */
  all(): CaseView[] {
    const cases = new Map<number, CaseView>();
    for (const l of this.lines()) {
      if (l.type === "case") {
        const { prev: _p, hash: _h, ...rec } = l;
        cases.set(l.n, { ...(rec as CaseRecord), rulings: [] });
      } else {
        const c = cases.get(l.case);
        if (!c) continue;
        const { prev: _p, hash: _h, ...rec } = l;
        c.rulings.push(rec as RulingRecord);
        c.ruling = rec as RulingRecord;
      }
    }
    return [...cases.values()].sort((a, b) => b.n - a.n);
  }

  get(n: number): CaseView | undefined {
    return this.all().find((c) => c.n === n);
  }

  /** Cases awaiting judgment, oldest first: the order to judge them in. */
  pending(): CaseView[] {
    return this.all()
      .filter((c) => !c.ruling)
      .reverse();
  }

  /**
   * How often Maat's warnings were true, from the person's rulings.
   *
   * A warning is true when the work was sent back. "accepted" and "check
   * wrong" both mean the work was right and the warning false.
   */
  stats(): JudgmentStats {
    const all = this.all();
    const ruled = all.filter((c) => c.ruling);
    const byReason: JudgmentStats["byReason"] = {};
    for (const c of ruled) {
      const r = (byReason[c.reason] ??= { ruled: 0, sentBack: 0 });
      r.ruled += 1;
      if (c.ruling!.ruling === "sent back") r.sentBack += 1;
    }
    const sentBack = ruled.filter((c) => c.ruling!.ruling === "sent back").length;
    return {
      cases: all.length,
      pending: all.length - ruled.length,
      ruled: ruled.length,
      accepted: ruled.filter((c) => c.ruling!.ruling === "accepted").length,
      sentBack,
      checkWrong: ruled.filter((c) => c.ruling!.ruling === "check wrong").length,
      warningsTrue: ruled.length ? sentBack / ruled.length : null,
      byReason,
    };
  }

  /**
   * Checks a person ruled wrong in this project, newest first, as lines for
   * the check drafter: what the check ran and what the person said. Only
   * drafted checks — a check a person wrote is theirs to change in done.yml.
   */
  lessons(limit = 5): string[] {
    const out: string[] = [];
    for (const c of this.all()) {
      if (c.ruling?.ruling !== "check wrong") continue;
      for (const name of c.ruling.checks ?? []) {
        const k = c.checks.find((x) => x.name === name);
        if (!k || !k.drafted) continue;
        const why = c.ruling.note ? ` — the person said: "${c.ruling.note.slice(0, 300)}"` : "";
        out.push(`For "${c.task.slice(0, 160).replace(/\s+/g, " ")}", the check ${name} (${k.detail.slice(0, 200)}) refused work that was right${why}`);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /** Recompute the chain. `brokeAt` is the 1-based line where it broke. */
  verify(): { ok: boolean; lines: number; brokeAt?: number } {
    const p = this.path;
    if (!existsSync(p)) return { ok: true, lines: 0 };
    const raw = readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
    let prev = GENESIS;
    for (let i = 0; i < raw.length; i++) {
      let l: Line;
      try {
        l = JSON.parse(raw[i]) as Line;
      } catch {
        return { ok: false, lines: raw.length, brokeAt: i + 1 };
      }
      const { hash, ...body } = l;
      if (l.prev !== prev || hashLine(body) !== hash) return { ok: false, lines: raw.length, brokeAt: i + 1 };
      prev = hash;
    }
    return { ok: true, lines: raw.length };
  }
}

export type JudgmentStats = {
  cases: number;
  pending: number;
  ruled: number;
  accepted: number;
  sentBack: number;
  checkWrong: number;
  /** Sent back ÷ ruled; null before the first ruling. */
  warningsTrue: number | null;
  byReason: Partial<Record<CaseReason, { ruled: number; sentBack: number }>>;
};

/**
 * The follow-up a "sent back" ruling hands to the next run: the original
 * task and what the person found. Never sent on its own — a surface puts it
 * where the person can read it first.
 */
export function sendBackPrompt(c: CaseRecord, note?: string): string {
  return [
    `A person reviewed your earlier attempt at this task and sent it back${note?.trim() ? `: ${note.trim()}` : "."}`,
    "",
    `The task was: ${c.task}`,
  ].join("\n");
}
