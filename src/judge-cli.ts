/**
 * `maat judge`: rule on the claims the scale could not settle (judgment.ts).
 *
 *   maat judge                 step through every case awaiting judgment
 *   maat judge list            the cases awaiting judgment (--json)
 *   maat judge all             every case, ruled or not (--json)
 *   maat judge show <n>        one case in full
 *   maat judge accept <n>      the work is right             (--note "…")
 *   maat judge back <n>        the work is wrong; send it back (--note "…")
 *   maat judge check <n>       the check was wrong; the work is right (--note "…")
 *   maat judge prompt <n>      the follow-up task for a sent-back case
 *   maat judge stats           how often Maat's warnings were true (--json)
 *   maat judge verify          recompute the judgment record's hash chain
 *
 * Every ruling is also written to the session journal, so `maat verify`
 * covers it twice.
 */
import { Journal } from "./journal.js";
import {
  type CaseView,
  type Ruling,
  Judgments,
  reasonText,
  rulingText,
  sendBackPrompt,
} from "./judgment.js";

export type JudgeIO = {
  out: (s: string) => void;
  err: (s: string) => void;
  /** One line of input; null at end of input. Only the interactive form asks. */
  ask?: (prompt: string) => Promise<string | null>;
};

export type JudgeArgs = { cwd: string; task?: string; notes?: string[]; json?: boolean; version?: string };

export const JUDGE_USAGE = `maat judge — rule on the claims the scale could not settle

  maat judge                 step through every case awaiting judgment
  maat judge list            the cases awaiting judgment        (--json)
  maat judge all             every case, ruled or not          (--json)
  maat judge show <n>        one case in full
  maat judge accept <n>      the work is right                  (--note "…")
  maat judge back <n>        the work is wrong: send it back    (--note "what is wrong")
  maat judge check <n>       the check was wrong, the work right (--note "…")
  maat judge prompt <n>      the follow-up task for a case you sent back
  maat judge stats           how often Maat's warnings were true (--json)
  maat judge verify          recompute the judgment record's hash chain

A ruling never makes a claim "verified": Maat did not prove it, you judged it,
and the record says so. "check wrong" teaches Maat's check drafter in this
project not to seal the same mistake again.`;

const VERBS: Record<string, Ruling> = { accept: "accepted", back: "sent back", check: "check wrong" };

function when(iso: string): string {
  return iso.replace("T", " ").slice(0, 16);
}

function indent(text: string, pad: string): string {
  return text
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}

/** One case as a person reads it. `full` adds every check's output. */
export function formatCase(c: CaseView, full = false): string {
  const lines: string[] = [];
  lines.push(`case ${c.n} · ${when(c.iso)} · ${c.outcome}${c.ruling ? ` · ruled: ${rulingText(c.ruling.ruling)}` : " · awaiting your judgment"}`);
  const task = c.task.replace(/\s+/g, " ");
  lines.push(`  task      ${full || task.length <= 160 ? task : task.slice(0, 157) + "…"}`);
  lines.push(`  why       ${reasonText(c.reason)}`);
  for (const k of c.checks) {
    lines.push(`  check     ${k.name}${k.drafted ? " (drafted by Maat)" : " (yours)"} — ${k.detail}`);
    const out = k.output.trim();
    if (out) {
      const shown = full ? out : out.split("\n").slice(-6).join("\n");
      lines.push(indent(shown, "            │ "));
    }
  }
  for (const v of c.violations ?? []) lines.push(`  reviewers "${v.quote}" — ${v.evidence}`);
  lines.push(`  changed   ${c.files.length ? c.files.join(", ") : "(nothing recorded)"}`);
  if (c.receipt) lines.push(`  receipt   ${c.receipt}`);
  if (c.restored) lines.push("  note      --revert put this work back; accepting it does not restore it");
  for (const r of c.rulings) lines.push(`  ruling    ${when(r.iso)} ${rulingText(r.ruling)}${r.note ? ` — "${r.note}"` : ""}`);
  return lines.join("\n");
}

function journalFor(cwd: string, version?: string): Journal {
  const j = new Journal(cwd);
  j.append("session_start", { sessionId: j.sessionId, molt: version, cwd, judge: true });
  return j;
}

function record(j: Journal, n: number, ruling: Ruling, note?: string): void {
  j.append("judgment", { case: n, ruling, ...(note ? { note } : {}) });
}

function caseNumber(raw: string | undefined, io: JudgeIO): number | null {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) {
    io.err("maat: judge needs a case number, e.g. maat judge show 3\n");
    return null;
  }
  return n;
}

export async function cmdJudge(args: JudgeArgs, io: JudgeIO): Promise<number> {
  const store = new Judgments(args.cwd);
  const [sub = "", nRaw] = (args.task ?? "").trim().split(/\s+/);
  const note = args.notes?.join("\n").trim() || undefined;

  if (sub === "help" || sub === "--help") {
    io.out(JUDGE_USAGE + "\n");
    return 0;
  }

  if (sub === "list" || sub === "all" || (sub === "" && !io.ask)) {
    const cases = sub === "all" ? store.all() : store.pending();
    if (args.json) {
      io.out(JSON.stringify(cases, null, 2) + "\n");
      return 0;
    }
    if (!cases.length) {
      io.out(sub === "all" ? "no cases yet.\n" : "nothing awaits your judgment.\n");
      return 0;
    }
    if (sub !== "all") io.out(`${cases.length} awaiting your judgment\n\n`);
    io.out(cases.map((c) => formatCase(c)).join("\n\n") + "\n");
    return 0;
  }

  if (sub === "show" || sub === "prompt") {
    const n = caseNumber(nRaw, io);
    if (n === null) return 2;
    const c = store.get(n);
    if (!c) {
      io.err(`maat: no case ${n}\n`);
      return 2;
    }
    if (sub === "prompt") io.out(sendBackPrompt(c, c.ruling?.ruling === "sent back" ? c.ruling.note : note) + "\n");
    else io.out((args.json ? JSON.stringify(c, null, 2) : formatCase(c, true)) + "\n");
    return 0;
  }

  if (sub in VERBS) {
    const n = caseNumber(nRaw, io);
    if (n === null) return 2;
    const c = store.get(n);
    if (!c) {
      io.err(`maat: no case ${n}\n`);
      return 2;
    }
    const ruling = VERBS[sub];
    store.rule(n, ruling, { note });
    record(journalFor(args.cwd, args.version), n, ruling, note);
    io.out(`case ${n}: ${rulingText(ruling)}\n`);
    if (ruling === "sent back") io.out(`send it back to Maat:  maat run "$(maat judge prompt ${n})"\n`);
    return 0;
  }

  if (sub === "stats") {
    const s = store.stats();
    if (args.json) {
      io.out(JSON.stringify(s, null, 2) + "\n");
      return 0;
    }
    io.out(`${s.cases} case(s) · ${s.pending} awaiting judgment · ${s.ruled} ruled\n`);
    if (!s.ruled) {
      io.out("no rulings yet: how often Maat's warnings are true is not known until you rule.\n");
      return 0;
    }
    const pct = (x: number) => `${Math.round(x * 100)}%`;
    io.out(`its warnings were true ${pct(s.warningsTrue!)} of the time (${s.sentBack} sent back of ${s.ruled})\n`);
    io.out(`  accepted ${s.accepted} · sent back ${s.sentBack} · check wrong ${s.checkWrong}\n`);
    for (const [reason, r] of Object.entries(s.byReason)) {
      io.out(`  ${reason.padEnd(24)} ${r!.sentBack}/${r!.ruled} true\n`);
    }
    return 0;
  }

  if (sub === "verify") {
    const v = store.verify();
    if (v.ok) {
      io.out(`judgment record intact · ${v.lines} line(s)\n`);
      return 0;
    }
    io.out(`judgment record BROKEN at line ${v.brokeAt} of ${v.lines}\n`);
    return 1;
  }

  if (sub !== "") {
    io.err(`maat: unknown judge command "${sub}"\n\n${JUDGE_USAGE}\n`);
    return 2;
  }

  // Interactive: oldest first, one at a time.
  const pending = store.pending();
  if (!pending.length) {
    io.out("nothing awaits your judgment.\n");
    return 0;
  }
  io.out(`${pending.length} awaiting your judgment. You preside: the scale could not settle these.\n`);
  let journal: Journal | undefined;
  let ruled = 0;
  for (const c of pending) {
    io.out("\n" + formatCase(c) + "\n\n");
    let ruling: Ruling | null = null;
    for (;;) {
      const a = (await io.ask!("[a]ccept · [s]end back · [c]heck was wrong · [v]iew in full · [k] skip · [q]uit › "))?.trim().toLowerCase();
      if (a === null || a === undefined || a === "q") {
        io.out(`\n${ruled} ruled · ${store.pending().length} still awaiting judgment\n`);
        return 0;
      }
      if (a === "v") {
        io.out("\n" + formatCase(c, true) + "\n\n");
        continue;
      }
      if (a === "k" || a === "") break;
      if (a === "a") ruling = "accepted";
      else if (a === "s") ruling = "sent back";
      else if (a === "c") ruling = "check wrong";
      else continue;
      break;
    }
    if (!ruling) continue;
    const said = (await io.ask!(ruling === "sent back" ? "what is wrong? (sent back to the next run) › " : "note (optional) › "))?.trim() || undefined;
    store.rule(c.n, ruling, { note: said });
    record((journal ??= journalFor(args.cwd, args.version)), c.n, ruling, said);
    ruled += 1;
    io.out(`case ${c.n}: ${rulingText(ruling)}\n`);
    if (ruling === "sent back") io.out(`send it back to Maat:  maat run "$(maat judge prompt ${c.n})"\n`);
  }
  io.out(`\n${ruled} ruled · ${store.pending().length} still awaiting judgment\n`);
  return 0;
}
