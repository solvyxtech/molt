/**
 * The post-work audit (`--post-work-audit`, MAAT_POST_WORK_AUDIT=1).
 *
 * "verified" normally rests on hidden checks an independent judge drafted
 * before the work, from a frozen snapshot. That is safe and misses a lot: a
 * check written before the deliverable exists cannot know its interface, and
 * a weak judge's checks are often screened out because they could not fail.
 * This adds checks drafted AFTER the work, without letting the judge confirm
 * whatever the worker produced:
 *
 *  1. The judge (MAAT_JUDGE_*, never the worker's model) sees the task text
 *     and an interface view of the work (src/interface-view.ts): names,
 *     signatures, usage. Never the transcript, the claim, or the outputs.
 *  2. Every check quotes the task words its expected value comes from; a
 *     quote that is not in the task drops the check (dispute.ts quotedIn).
 *  3. A check counts only when it clears every gate:
 *       (a) it passes on the work;
 *       (b) it fails on the copy taken before the work (criteria.ts
 *           preWorkScreen, the seal-time screen);
 *       (c) mutation: Maat breaks the changed files 3-5 ways (flip a
 *           comparison, nudge a number, delete a statement, swap two
 *           branches) and the check must fail on at least one mutant that
 *           still runs (compiles, and did not just crash);
 *       (d) the standing lints: it must not change the work (L15), must be
 *           able to fail (L16), and must assert a value (tiers.ts).
 *  4. One check through every gate earns "verified (post-work audit: J)".
 *
 * Every run is on a throwaway copy (src/scratch.ts); the work is never touched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { askModel, type AskOptions } from "./ask.js";
import { diagnoseFailure } from "./bar.js";
import { reportsFailure } from "./evidence.js";
import { cannotFail } from "./checklint.js";
import { checkMutates } from "./checkwrites.js";
import { CRITERIA_MAX_NAME, CRITERIA_MAX_RUN, preWorkScreen, repairEscapes, SHELL_PARSE_ERROR } from "./criteria.js";
import { quotedIn } from "./dispute.js";
import { parseLenient } from "./lenient-json.js";
import { interfaceView, isCode, type Changed } from "./interface-view.js";
import { bashPath, runCommand } from "./run.js";
import { copyTree } from "./scratch.js";
import { assertsExact, assertsValue } from "./tiers.js";

export const AUDIT_MAX_CHECKS = 4;
export const AUDIT_MIN_QUOTE = 8;
export const AUDIT_MAX_MUTANTS = 5;
export const AUDIT_CHECK_TIMEOUT_MS = 10_000;

export const AUDIT_SYSTEM = [
  "You audit finished work on one coding task. You did not do the work and you will not see what",
  "it printed or wrote. You get the task text and the INTERFACE of the finished work: which files",
  "it added or changed, their signatures, how to run them, and the project listing.",
  "",
  "Write 2 to 4 shell checks. Each runs the deliverable (a script, a function, a query) on an input",
  "and compares what it produces with the EXACT expected output, exiting non-zero on a mismatch:",
  "equality with a literal, a diff against a heredoc, or grep -x of a whole expected line. A count,",
  "an order, a format, a prefix or two runs agreeing is a property wrong output also has: such a",
  "check is dropped. Each requirement the task states gets at least one exact check. Almost",
  "every task states something checkable: an output for a given input, a format, a count, a rule",
  "(\"blank lines are ignored\", \"sorted by total, highest first\"), a file it must write.",
  "Return an empty list only when the task states nothing a command could test.",
  "",
  "The expected value must come from the task text: either stated outright, or the result of",
  "applying a rule the task states to a small input your check builds itself (write it under",
  "$(mktemp -d)). Pick inputs at the edges: a boundary, empty input, a value just outside a rule",
  "(1.2.3.4.5 for an IP rule), a start that is not on a step, and each side of an either/or rule.",
  "For each check give `quote`: the task words that state that value or rule,",
  "copied character for character from the task text (a short span is best, 5 to 20 words).",
  "A quote that is not word for word in the task, even a close paraphrase, drops the check. Never",
  "use a value you would only know by running the work or by guessing. When the value is derived,",
  "give the steps in `expect` (\"*/15 from 00:07: 00:15, 00:30, 00:45\").",
  "",
  "Rules: one line each, under 500 characters, run under bash from the project root on a",
  "throwaway copy. A check that only prints is useless: end every check in a comparison, e.g.",
  "  [ \"$(python3 tool.py 3 4)\" = \"7\" ]",
  "  python3 -c \"import json; d=json.load(open('out.json')); assert d['total'] == 12, d\"",
  "  python3 tool.py 'x y' | diff - <(printf 'x-y\\n')",
  "A wrong result must make the check exit non-zero: no `|| true`, no `|| echo`, no",
  "printing PASS/FAIL with exit 0. Do not write into the project; scratch files go under",
  "$(mktemp -d). Use the file names, flags and signatures shown; do not invent others.",
  "",
  "Reply with JSON only:",
  '{"checks":[{"name":"kebab-name","run":"shell command","quote":"verbatim task words","expect":"how the expected output follows"}]}',
].join("\n");

/** `expect`: how the expected output follows from the quote, when it is derived rather than stated. */
export type AuditCheck = { name: string; run: string; quote: string; expect?: string };
export type AuditDrop = { name: string; run: string; why: string };

/** The judge's reply as checks, with every ungrounded or malformed one dropped and said. */
export function parseAuditChecks(reply: string, task: string): { kept: AuditCheck[]; dropped: AuditDrop[] } | null {
  const body = reply.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  // Some judges answer with the bare list of checks.
  const array = body.startsWith("[");
  const start = body.indexOf(array ? "[" : "{");
  const end = body.lastIndexOf(array ? "]" : "}");
  if (start === -1 || end === -1) return null;
  const json = body.slice(start, end + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    try {
      raw = parseLenient(json);
    } catch {
      try {
        raw = JSON.parse(repairEscapes(json));
      } catch {
        return null;
      }
    }
  }
  const list = Array.isArray(raw) ? raw : (raw as { checks?: unknown }).checks;
  if (!Array.isArray(list)) return null;
  const kept: AuditCheck[] = [];
  const dropped: AuditDrop[] = [];
  const seen = new Set<string>();
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    let name = String(o.name ?? "").trim().replace(/\s+/g, "-").slice(0, CRITERIA_MAX_NAME) || `audit-${kept.length + dropped.length + 1}`;
    const run = String(o.run ?? "").trim();
    const quote = String(o.quote ?? "").trim();
    const expect = typeof o.expect === "string" ? o.expect.trim().slice(0, 300) : "";
    while (seen.has(name)) name = `${name}-2`;
    seen.add(name);
    if (!run) dropped.push({ name, run, why: "no command" });
    else if (run.length > CRITERIA_MAX_RUN) dropped.push({ name, run, why: `the command is over ${CRITERIA_MAX_RUN} characters` });
    else if (!quote) dropped.push({ name, run, why: "it quotes no task words for its expected value" });
    else if (quote.replace(/\s+/g, " ").length < AUDIT_MIN_QUOTE || !quotedIn(quote, task))
      dropped.push({ name, run, why: `its quote is not in the task text: "${quote.slice(0, 80)}"` });
    else if (kept.length >= AUDIT_MAX_CHECKS) dropped.push({ name, run, why: `over ${AUDIT_MAX_CHECKS} checks` });
    else kept.push({ name, run, quote, ...(expect ? { expect } : {}) });
  }
  return { kept, dropped };
}

// ---------------------------------------------------------------- mutants

export type Mutant = { path: string; line: number; operator: string; before: string; after: string; text: string };

/** Same length as the line, string literals and comments blanked, so operators inside them are left alone. */
function maskLine(line: string, ext: string): string {
  let out = "";
  let q = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (q) {
      if (c === "\\") {
        out += "__";
        i++;
        continue;
      }
      if (c === q) q = "";
      out += "_";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      q = c;
      out += "_";
      continue;
    }
    if ((c === "#" && [".py", ".sh", ".bash", ".rb", ".pl", ""].includes(ext)) || (c === "/" && line[i + 1] === "/" && ![".py", ".sh", ".bash"].includes(ext))) {
      out += "_".repeat(line.length - i);
      break;
    }
    out += c;
  }
  return out;
}

/** Replace `len` characters at `at` in `s`. */
function splice(s: string, at: number, len: number, by: string): string {
  return s.slice(0, at) + by + s.slice(at + len);
}

const FLIPS: { find: RegExp; to: string; shell?: true }[] = [
  { find: /(?<![<>=!])<=(?!=)/, to: ">" },
  { find: /(?<![<>=!])>=(?!=)/, to: "<" },
  { find: /===/, to: "!==" },
  { find: /!==/, to: "===" },
  { find: /(?<![=!<>])==(?!=)/, to: "!=" },
  { find: /!=(?!=)/, to: "==" },
  { find: /(?<=\s)<(?=\s)/, to: ">=" },
  { find: /(?<=\s)>(?=\s)/, to: "<=" },
  { find: /(?<=\s)-lt(?=\s)/, to: "-ge", shell: true },
  { find: /(?<=\s)-gt(?=\s)/, to: "-le", shell: true },
  { find: /(?<=\s)-le(?=\s)/, to: "-gt", shell: true },
  { find: /(?<=\s)-ge(?=\s)/, to: "-lt", shell: true },
  { find: /(?<=\s)-eq(?=\s)/, to: "-ne", shell: true },
  { find: /(?<=\s)-ne(?=\s)/, to: "-eq", shell: true },
];

const SHELLISH = new Set([".sh", ".bash", ""]);

function isImport(t: string): boolean {
  return /^(import\s|from\s+\S+\s+import\s|#include|use\s|require\(|const\s+\w+\s*=\s*require\(|package\s|using\s)/.test(t) || /^(export\s+)?\{?.*\}?\s*from\s+["']/.test(t) || t.startsWith("#!");
}

function balanced(t: string): boolean {
  let n = 0;
  for (const c of t) {
    if ("([{".includes(c)) n++;
    else if (")]}".includes(c)) n--;
    if (n < 0) return false;
  }
  return n === 0;
}

function flipComparison(line: string, ext: string): { after: string; operator: string } | null {
  const masked = maskLine(line, ext);
  if (/^\s*(import|from|#include)\b/.test(line) || line.trim().startsWith("#!")) return null;
  for (const f of FLIPS) {
    if (SHELLISH.has(ext)) {
      // In a shell script `<` and `>` are redirects: only the test operators, and `==`/`!=` inside a test.
      if (!f.shell && (!/\[\[?\s/.test(masked) || !/^[=!]=$/.test(f.to))) continue;
    } else if (f.shell) continue;
    const m = f.find.exec(masked);
    if (!m) continue;
    return { after: splice(line, m.index, m[0].length, f.to), operator: `flip ${m[0].trim()} to ${f.to}` };
  }
  return null;
}

function offByOne(line: string, ext: string): { after: string; operator: string } | null {
  const t = line.trim();
  if (!t || isImport(t) || /^(#|\/\/|\*|\/\*)/.test(t)) return null;
  const masked = maskLine(line, ext);
  const m = /(?<![\w.$])(\d+)(?![\w.])/.exec(masked);
  if (!m) return null;
  const n = Number(line.slice(m.index, m.index + m[1]!.length));
  if (!Number.isSafeInteger(n)) return null;
  return { after: splice(line, m.index, m[1]!.length, String(n + 1)), operator: `nudge ${n} to ${n + 1}` };
}

function deleteStatement(line: string, ext: string, next: string | undefined, prev: string | undefined): { after: string; operator: string } | null {
  const t = line.trim();
  if (!t || isImport(t) || /^(#|\/\/|\*|\/\*|@)/.test(t)) return null;
  if (!balanced(maskLine(t, ext))) return null;
  if (prev !== undefined && /[\\,(\[{]\s*$/.test(prev.trim())) return null; // a continuation
  const indent = line.slice(0, line.length - line.trimStart().length);
  if (ext === ".py") {
    if (/:\s*(#.*)?$/.test(t) || /^(def|class|elif|else|except|finally|try|with|for|while|if|async|global|nonlocal)\b/.test(t)) return null;
    return { after: `${indent}pass`, operator: "delete a statement" };
  }
  if (SHELLISH.has(ext)) {
    if (/^(then|do|done|fi|else|elif|esac|case|in|function|\{|\}|;;|.*\)\s*$)/.test(t) || /\b(then|do)\s*$/.test(t)) return null;
    // Deleting the last command of a block leaves `then`/`do` with nothing: bash refuses it.
    if (next !== undefined && /^(fi|done|else|elif|esac|;;)\b/.test(next.trim()) && prev !== undefined && /\b(then|do|else)\s*$/.test(prev.trim())) return null;
    return { after: `${indent}:`, operator: "delete a statement" };
  }
  if (!t.endsWith(";") || /[{}]/.test(t)) return null;
  if (/^(let|const|var|int|long|double|float|char|bool|auto|String)\b/.test(t)) return null; // a declaration others read
  return { after: `${indent};`, operator: "delete a statement" };
}

/** Python `if c:` / `else:` (or C-like `if (...) {` / `} else {`) with the two bodies swapped. */
function swapBranches(lines: string[], i: number, ext: string): { text: string[]; operator: string; end: number } | null {
  const line = lines[i]!;
  const ind = (l: string) => l.length - l.trimStart().length;
  if (ext === ".py") {
    if (!/^\s*(if|elif)\b.*:\s*(#.*)?$/.test(line)) return null;
    const base = ind(line);
    let j = i + 1;
    while (j < lines.length && (lines[j]!.trim() === "" || ind(lines[j]!) > base)) j++;
    if (j >= lines.length || ind(lines[j]!) !== base || !/^\s*else\s*:\s*(#.*)?$/.test(lines[j]!)) return null;
    let k = j + 1;
    while (k < lines.length && (lines[k]!.trim() === "" || ind(lines[k]!) > base)) k++;
    while (k > j + 1 && lines[k - 1]!.trim() === "") k--;
    const a = lines.slice(i + 1, j);
    const b = lines.slice(j + 1, k);
    if (!a.some((l) => l.trim()) || !b.some((l) => l.trim())) return null;
    if (a.join("\n").trim() === b.join("\n").trim()) return null;
    return { text: [...lines.slice(0, i + 1), ...b, lines[j]!, ...a, ...lines.slice(k)], operator: "swap the if/else branches", end: k };
  }
  if ([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".c", ".cpp", ".java", ".go", ".rs", ".kt", ".swift", ".php"].includes(ext)) {
    if (!/^\s*(\}\s*else\s+)?if\b.*\{\s*$/.test(line)) return null;
    const base = ind(line);
    let j = i + 1;
    while (j < lines.length && !(ind(lines[j]!) === base && /^\s*\}\s*else\s*\{\s*$/.test(lines[j]!))) {
      if (ind(lines[j]!) <= base && lines[j]!.trim() !== "" && !/^\s*\}/.test(lines[j]!)) return null;
      if (ind(lines[j]!) === base && /^\s*\}/.test(lines[j]!)) return null;
      j++;
    }
    if (j >= lines.length) return null;
    let k = j + 1;
    while (k < lines.length && !(ind(lines[k]!) === base && /^\s*\}\s*$/.test(lines[k]!))) k++;
    if (k >= lines.length) return null;
    const a = lines.slice(i + 1, j);
    const b = lines.slice(j + 1, k);
    if (!a.some((l) => l.trim()) || !b.some((l) => l.trim()) || a.join("\n").trim() === b.join("\n").trim()) return null;
    return { text: [...lines.slice(0, i + 1), ...b, lines[j]!, ...a, ...lines.slice(k)], operator: "swap the if/else branches", end: k };
  }
  return null;
}

/** Line numbers (1-based) of `after` whose text is not in `before`: what the work wrote. */
export function changedLines(before: string | undefined, after: string): Set<number> {
  const lines = after.split("\n");
  if (before === undefined) return new Set(lines.map((_, i) => i + 1));
  const pool = new Map<string, number>();
  for (const l of before.split("\n")) pool.set(l, (pool.get(l) ?? 0) + 1);
  const out = new Set<number>();
  lines.forEach((l, i) => {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else out.add(i + 1);
  });
  return out;
}

/** Every mechanical mutant of the file's changed lines, by operator. */
export function mutantCandidates(path: string, text: string, before?: string): Record<"flip" | "nudge" | "delete" | "swap", Mutant[]> {
  const ext = extname(path) === "" && text.startsWith("#!") ? (/python/.test(text.split("\n")[0]!) ? ".py" : /node/.test(text.split("\n")[0]!) ? ".js" : "") : extname(path);
  const lines = text.split("\n");
  const touched = changedLines(before, text);
  const out: Record<"flip" | "nudge" | "delete" | "swap", Mutant[]> = { flip: [], nudge: [], delete: [], swap: [] };
  const one = (i: number, r: { after: string; operator: string } | null, into: Mutant[]) => {
    if (!r || r.after === lines[i]) return;
    const copy = [...lines];
    copy[i] = r.after;
    into.push({ path, line: i + 1, operator: r.operator, before: lines[i]!, after: r.after, text: copy.join("\n") });
  };
  for (let i = 0; i < lines.length; i++) {
    if (!touched.has(i + 1)) continue;
    one(i, flipComparison(lines[i]!, ext), out.flip);
    one(i, offByOne(lines[i]!, ext), out.nudge);
    one(i, deleteStatement(lines[i]!, ext, lines[i + 1], lines[i - 1]), out.delete);
    const s = swapBranches(lines, i, ext);
    if (s) out.swap.push({ path, line: i + 1, operator: s.operator, before: lines[i]!, after: lines[i]!, text: s.text.join("\n") });
  }
  return out;
}

/** Mutants of a data file's changed lines: the first number nudged, or the line removed. */
export function dataMutants(path: string, text: string, before?: string): { nudge: Mutant[]; delete: Mutant[] } {
  const lines = text.split("\n");
  const touched = changedLines(before, text);
  const out = { nudge: [] as Mutant[], delete: [] as Mutant[] };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!touched.has(i + 1) || !l.trim()) continue;
    const m = /(?<![\w.])(\d+)(?![\w])/.exec(l);
    if (m && Number.isSafeInteger(Number(m[1]))) {
      const after = splice(l, m.index, m[1]!.length, String(Number(m[1]) + 1));
      out.nudge.push({ path, line: i + 1, operator: `nudge ${m[1]} to ${Number(m[1]) + 1}`, before: l, after, text: [...lines.slice(0, i), after, ...lines.slice(i + 1)].join("\n") });
    }
    // Only where a line can go and leave the format whole: not a JSON line ending a value list.
    if (!/^\s*[{}\[\],]*\s*$/.test(l)) {
      out.delete.push({ path, line: i + 1, operator: "delete a line", before: l, after: "", text: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n") });
    }
  }
  return out;
}

const COMPILE: Record<string, (file: string) => string> = {
  ".py": (f) => `python3 -m py_compile ${q(f)}`,
  ".js": (f) => `node --check ${q(f)}`,
  ".mjs": (f) => `node --check ${q(f)}`,
  ".cjs": (f) => `node --check ${q(f)}`,
  ".sh": (f) => `bash -n ${q(f)}`,
  ".bash": (f) => `bash -n ${q(f)}`,
};

function q(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** Does the mutant still parse? Languages with no cheap parser here are taken as parsing. */
export async function mutantParses(m: Mutant): Promise<boolean> {
  if (extname(m.path).toLowerCase() === ".json") {
    try {
      JSON.parse(m.text);
      return true;
    } catch {
      return false;
    }
  }
  const compile = COMPILE[extname(m.path)];
  if (!compile) return true;
  const dir = mkdtempSync(join(tmpdir(), "maat-mutant-"));
  try {
    const file = join(dir, basename(m.path));
    writeFileSync(file, m.text);
    const r = await runCommand(compile(file), { cwd: dir, timeoutMs: 10_000, maxBuffer: 64 * 1024, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    // A missing interpreter says nothing about the mutant.
    if (r.code === 127) return true;
    return r.code === 0 && !r.timedOut;
  } catch {
    return true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Up to `max` mutants of the changed code files that still parse, spread
 * over the four operators and over the files, in a fixed order so a replay
 * makes the same ones.
 */
export async function planAuditMutants(
  files: readonly { path: string; text: string; before?: string }[],
  max = AUDIT_MAX_MUTANTS,
): Promise<Mutant[]> {
  const pools: Mutant[][] = [];
  // When the work changed code, only the code is broken: a check that reads an output file the
  // code wrote once is killed by editing that file and says nothing about the code. Data is
  // broken only when the deliverable is data (a migrated config, a regex file, a hand-made report).
  const anyCode = files.some((f) => isCode(f.path, f.text));
  for (const f of files) {
    if (anyCode && !isCode(f.path, f.text)) continue;
    if (!isCode(f.path, f.text)) {
      // A deliverable that is data (a migrated config, a regex, a report): nudge a number, drop a line.
      const d = dataMutants(f.path, f.text, f.before);
      pools.push(spread(d.nudge), spread(d.delete));
      continue;
    }
    const c = mutantCandidates(f.path, f.text, f.before);
    // Spread within an operator too: every other candidate, from both ends.
    for (const k of ["flip", "swap", "nudge", "delete"] as const) pools.push(spread(c[k]));
  }
  const chosen: Mutant[] = [];
  const texts = new Set<string>();
  let tried = 0;
  for (let round = 0; chosen.length < max && tried < max * 6; round++) {
    let any = false;
    for (const p of pools) {
      const m = p[round];
      if (!m) continue;
      any = true;
      const key = `${m.path}\0${m.text}`;
      if (texts.has(key)) continue;
      texts.add(key);
      tried++;
      if (await mutantParses(m)) chosen.push(m);
      if (chosen.length >= max || tried >= max * 6) break;
    }
    if (!any) break;
  }
  return chosen;
}

function spread<T>(xs: T[]): T[] {
  const out: T[] = [];
  let lo = 0;
  let hi = xs.length - 1;
  while (lo <= hi) {
    out.push(xs[lo++]!);
    if (lo <= hi) out.push(xs[hi--]!);
  }
  return out;
}

// ---------------------------------------------------------------- gates

export type RunVerdict = { status: "pass" | "fail" | "broken"; printedFail: boolean; crashed: boolean; output: string };

const CRASH = /Traceback \(most recent call last\)|\b(?:SyntaxError|ReferenceError|NameError|UnboundLocalError|IndentationError|ImportError|ModuleNotFoundError)\b/;

/** Run a check on a throwaway copy of `dir`, optionally with one file replaced. */
export async function runOnCopy(
  dir: string,
  run: string,
  opts: { timeoutMs?: number; replace?: { path: string; text: string }; signal?: AbortSignal } = {},
): Promise<RunVerdict> {
  const copy = await copyTree(dir);
  if (!copy) return { status: "broken", printedFail: false, crashed: false, output: "the project could not be copied, so the check was not run" };
  try {
    if (opts.replace) writeFileSync(join(copy.dir, opts.replace.path), opts.replace.text);
    const r = await runCommand(run, {
      cwd: copy.dir,
      shell: bashPath() ?? true,
      timeoutMs: opts.timeoutMs ?? AUDIT_CHECK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      signal: opts.signal,
      killGroupOnExit: true,
    });
    const output = copy.unmap(`${r.stdout}\n${r.stderr}`).trim().slice(-2_000);
    const d = diagnoseFailure(r.code ?? 0, r.stdout, r.stderr);
    if (d.didNotRun || (SHELL_PARSE_ERROR.test(r.stderr) && r.code !== 0 && !CRASH.test(r.stderr))) return { status: "broken", printedFail: false, crashed: false, output };
    const printedFail = /\bFAIL(?:ED)?\b/.test(`${r.stdout}\n${r.stderr}`);
    // As at the bar: a check whose deciding step printed False/FAIL (or a non-zero `echo $?`) failed.
    const ok = !r.timedOut && r.code === 0 && !reportsFailure(run, r.stdout);
    return { status: ok && !printedFail ? "pass" : "fail", printedFail: ok && printedFail, crashed: !ok && CRASH.test(output), output };
  } catch (e) {
    return { status: "broken", printedFail: false, crashed: false, output: (e as Error).message };
  } finally {
    await copy.cleanup();
  }
}

export type GateResult = {
  name: string;
  run: string;
  quote: string;
  accepted: boolean;
  /** Why it was not accepted: the first gate it did not clear. */
  why?: string;
  rule?: string;
  work?: RunVerdict["status"];
  preWork?: "failed" | "passed" | "printed-fail";
  mutants?: { total: number; killed: number; crashedOnly: number; survived: number; killedBy?: string[] };
};

/** Gates (d), (a), (b), (c), in that order: cheapest first, and each run only if the last was cleared. */
export async function auditGates(
  c: AuditCheck,
  ctx: { workDir: string; preWorkDir: string; mutants: readonly Mutant[]; timeoutMs?: number; signal?: AbortSignal; preWorkIntact?: () => Promise<boolean> },
): Promise<GateResult> {
  const base = { name: c.name, run: c.run, quote: c.quote };
  const no = (rule: string, why: string, extra: Partial<GateResult> = {}): GateResult => ({ ...base, accepted: false, rule, why, ...extra });
  const writes = checkMutates(c.run);
  if (writes) return no("L15-mutates", writes);
  const never = cannotFail(c.run);
  if (never) return no("L16-cannot-fail", never);
  if (!assertsValue(c.run)) return no("V-no-value", "it does not assert an expected value");
  if (!assertsExact(c.run)) return no("V-property-only", "it tests a property of the output (a count, an order, a format, membership, two runs agreeing), not an exact expected value");
  const work = await runOnCopy(ctx.workDir, c.run, { timeoutMs: ctx.timeoutMs, signal: ctx.signal });
  if (work.printedFail) return no("L16-printed-fail", "it printed FAIL and still exited 0 on the work", { work: work.status });
  if (work.status !== "pass") return no("A-fails-on-work", `it does not pass on the work (${work.status}): ${work.output.split("\n").slice(-1)[0]?.slice(0, 160) ?? ""}`, { work: work.status });
  const screened = await preWorkScreen([{ name: c.name, run: c.run }], ctx.preWorkDir, false, {
    killGroupOnExit: true,
    timeoutMs: ctx.timeoutMs ?? AUDIT_CHECK_TIMEOUT_MS,
    ...(ctx.preWorkIntact ? { intact: ctx.preWorkIntact } : {}),
  });
  if (!screened) return no("B-untried", "it could not be tried on the copy taken before the work (the copy changed, or the try could not run)", { work: "pass" });
  const hit = screened.bad[0];
  if (hit) return no(hit.rule, hit.why, { work: "pass", preWork: hit.rule === "L16-printed-fail" ? "printed-fail" : "passed" });
  if (!ctx.mutants.length) return no("C-no-mutants", "no mutant of the changed files could be made, so nothing shows the check reads the work", { work: "pass", preWork: "failed" });
  let killed = 0;
  const killedBy: string[] = [];
  let crashedOnly = 0;
  let survived = 0;
  for (const m of ctx.mutants) {
    const r = await runOnCopy(ctx.workDir, c.run, { timeoutMs: ctx.timeoutMs, replace: { path: m.path, text: m.text }, signal: ctx.signal });
    if (r.status === "pass") survived++;
    else if (r.status === "fail" && !r.crashed) {
      killed++;
      killedBy.push(`${m.operator} at ${m.path}:${m.line}`);
    } else crashedOnly++;
  }
  const mutants = { total: ctx.mutants.length, killed, crashedOnly, survived, killedBy };
  if (survived === ctx.mutants.length) return no("C-passes-every-mutant", `it passed on all ${ctx.mutants.length} mutants of the changed files`, { work: "pass", preWork: "failed", mutants });
  if (killed === 0) return no("C-only-crashes", "it failed only on mutants that crashed or could not run, never on one that still ran", { work: "pass", preWork: "failed", mutants });
  return { ...base, accepted: true, work: "pass", preWork: "failed", mutants };
}

// ---------------------------------------------------------------- the audit

export type AuditReport = {
  judge: string;
  /** What the judge was shown, besides the task text. */
  view: string;
  changed: Changed[];
  drafted: number;
  dropped: AuditDrop[];
  mutants: { path: string; line: number; operator: string }[];
  checks: GateResult[];
  /** Names of the checks that cleared every gate. */
  accepted: string[];
  /** Set when the audit could not ask the judge or read its reply. */
  error?: string;
};

export async function postWorkAudit(opts: {
  task: string;
  workDir: string;
  preWorkDir: string;
  /** Whether the pre-work copy is still as taken (scratch.ts preWorkCopy). */
  preWorkIntact?: () => Promise<boolean>;
  judge: { baseUrl: string; apiKey?: string; model: string };
  fetchFn?: typeof fetch;
  acpSpawn?: AskOptions["acpSpawn"];
  cliRun?: AskOptions["cliRun"];
  reasoningEffort?: string;
  askTimeoutMs?: number;
  deadlineAt?: number;
  checkTimeoutMs?: number;
  maxMutants?: number;
  signal?: AbortSignal;
  /** Called with each check before it is run, so a caller can withhold its command. */
  onCheck?: (c: AuditCheck) => void;
}): Promise<AuditReport> {
  const view = await interfaceView({ preWorkDir: opts.preWorkDir, workDir: opts.workDir, signal: opts.signal });
  const report: AuditReport = { judge: opts.judge.model, view: view.text, changed: view.changed, drafted: 0, dropped: [], mutants: [], checks: [], accepted: [] };
  const prompt = [
    `TASK TEXT:\n${opts.task}`,
    "",
    "INTERFACE OF THE FINISHED WORK (names and signatures only; what it printed or wrote is not shown):",
    view.text,
    ...(process.platform === "darwin" ? ["", "This is macOS: BSD tools, not GNU. Prefer python3 for anything beyond plain shell."] : []),
  ].join("\n");
  // A subprocess judge starts in an empty folder of its own, never the work: it must not read the outputs.
  const askDir = mkdtempSync(join(tmpdir(), "maat-audit-"));
  let parsed: ReturnType<typeof parseAuditChecks> = null;
  let lastText = "";
  try {
    for (let i = 0; i < 2 && !parsed; i++) {
      const asked = await askModel({
        ...opts.judge,
        system: AUDIT_SYSTEM,
        prompt: i === 0 ? prompt : `${prompt}\n\nYour last reply could not be parsed as JSON. Reply with the JSON object only.`,
        cwd: askDir,
        what: "drafting post-work audit checks",
        fetchFn: opts.fetchFn,
        acpSpawn: opts.acpSpawn,
        cliRun: opts.cliRun,
        reasoningEffort: opts.reasoningEffort,
        timeoutMs: opts.askTimeoutMs,
        deadlineAt: opts.deadlineAt,
      });
      if (!asked.ok) {
        report.error = asked.error;
        return report;
      }
      lastText = asked.text;
      parsed = parseAuditChecks(asked.text, opts.task);
    }
  } finally {
    rmSync(askDir, { recursive: true, force: true });
  }
  if (!parsed) {
    const said = lastText.trim().replace(/\s+/g, " ");
    report.error = `the judge's reply was not JSON: ${said ? `"${said.slice(0, 160)}${said.length > 160 ? "…" : ""}"` : "the reply was empty"}`;
    return report;
  }
  report.drafted = parsed.kept.length + parsed.dropped.length;
  report.dropped = parsed.dropped;
  if (!parsed.kept.length) return report;
  const files = view.changed.map((c) => {
    let text = "";
    let before: string | undefined;
    try {
      text = readFileSync(join(opts.workDir, c.path), "utf8");
      if (c.status === "changed") before = readFileSync(join(opts.preWorkDir, c.path), "utf8");
    } catch {
      /* unreadable: no mutants from it */
    }
    return { path: c.path, text, ...(before !== undefined ? { before } : {}) };
  });
  const mutants = await planAuditMutants(files.filter((f) => f.text && !f.text.includes("\u0000")), opts.maxMutants ?? AUDIT_MAX_MUTANTS);
  report.mutants = mutants.map((m) => ({ path: m.path, line: m.line, operator: m.operator }));
  for (const c of parsed.kept) {
    if (opts.signal?.aborted || (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt)) {
      report.checks.push({ ...c, accepted: false, rule: "T-out-of-time", why: "the run's time ran out before this check was tried" });
      continue;
    }
    opts.onCheck?.(c);
    const g = await auditGates(c, { workDir: opts.workDir, preWorkDir: opts.preWorkDir, mutants, timeoutMs: opts.checkTimeoutMs, signal: opts.signal, ...(opts.preWorkIntact ? { preWorkIntact: opts.preWorkIntact } : {}) });
    report.checks.push(g);
    if (g.accepted) report.accepted.push(g.name);
  }
  return report;
}
