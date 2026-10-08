/**
 * The reference check: an answer computed independently of the work.
 *
 * Drafted checks share the worker's misreadings. Asked to check cron-next,
 * the drafter wrote `nextrun.py '0 12 1 * 1' ... | grep -q 2024-02-01` — a
 * hand-worked answer, and a wrong one (the 8th is a Monday) — and on another
 * draft no edge case at all, so `5-10/2` counted from zero and a leap-day
 * search that gave up both sailed through as "verified". A check written by
 * the party that misunderstood the task repeats the misunderstanding.
 *
 * So a second, fresh model reads only the task text and the project as it was
 * before any work, and writes the most literal reference it can — brute force,
 * no cleverness — with a harness that compares the deliverable to it on the
 * task's examples, the edge cases its words imply, and seeded random inputs.
 * Every expected value comes from running the reference, never from working
 * an answer out by hand. On local tasks this caught every wrong cron-next
 * solution with the input, the expected and the actual result, and a
 * correct-by-the-grader one that broke a rule the grader never tested.
 *
 * One reference alone was not enough. On 20 local tasks it caught every
 * wrong solution it judged, and refused 29 of 70 correct ones: its own bugs
 * (Sunday off by one, a server's state) and behaviour the task never decided
 * (symlinks, an error for ".5 KB"). A reference is a program written by a
 * model, and it shares a model's failure rate. So there are two: a second
 * reviewer who sees the task, the files and what an input is — never the
 * first reviewer's code or answers — writes its own reference(), and Maat's
 * own driver (never written by a model) judges the deliverable only on
 * inputs where both agree. A pair that mostly disagrees is dropped whole.
 *
 * Its guarantees, and where each comes from:
 *  - It predates the work: it is built from the task text and a snapshot of
 *    the project taken before the first step, and only ever reads that
 *    snapshot. So it may join the sealed checks later than the drafted ones
 *    without the work having had any say in it.
 *  - Its own bugs are not the work's fault: the driver computes every
 *    expected value before running the deliverable, and exits 3 when a
 *    reference fails, the pair disagrees, or run_deliverable raises (it is
 *    told never to). Tried once on the untouched snapshot, a 3 there drops
 *    it; a 3 at a claim retires it (engine.ts).
 *  - It is withheld from the model like every drafted check, and lives
 *    outside the project, so a task that walks the tree never meets it.
 */
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { askModel, jsonIn, type AskOptions } from "./ask.js";
import { runCommand } from "./run.js";
import { STATE_DIRS } from "./statedir.js";
import type { Check } from "./types.js";

export const REFERENCE_CHECK_NAME = "reference";
/** The exit code a reference harness uses for its own failure. */
export const REFERENCE_SELF_ERROR = 3;
/** A snapshot larger than this is not taken, and no reference is offered. */
export const REFERENCE_MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
export const REFERENCE_MAX_SNAPSHOT_FILES = 5_000;
/** Room for a whole program in the reply, plus a reasoning model's thinking. */
export const REFERENCE_MAX_TOKENS = 16_000;
export const REFERENCE_TIMEOUT_MS = 120_000;

const SKIP = new Set<string>([...STATE_DIRS, ".git", "node_modules", "__pycache__", ".venv", "venv", ".tox", "target", "dist"]);

export const REFERENCE_SYSTEM = [
  "You write an independent reference check for one coding task. Someone else does",
  "the task; you never see their work. Your check runs after they finish and decides",
  "whether their result is right. A second reviewer, who never sees your code,",
  "independently writes a reference for the same inputs, and only inputs where both",
  "references agree are used to judge the work.",
  "",
  "The danger you exist to remove: the person doing the task can misread it, and any",
  "check they write repeats their misreading. So you work from the task's own words",
  "only, and you write the most literal, obviously-correct version of the answer you",
  "can — brute force, enumerate everything, no clever shortcuts, no optimisation,",
  "every rule in the task applied exactly as written. Slow is fine (under 60 seconds",
  "for all inputs together). Clever is how references go wrong.",
  "",
  "FIRST decide whether a reference applies. It applies when the right result can be",
  "COMPUTED from the task text and inputs present in the project: a program or",
  "function with a stated interface, a command whose output is specified, a file",
  "transform, a report or query over files that are here. It does NOT apply when the",
  "answer has to be discovered, searched for, trained, measured on hidden data,",
  "depends on the network, or is a judgement call; or when the task is only about",
  "repository or system state that a plain command checks directly; or when the task",
  "does not name exactly how the result is used (a command line, an import path, an",
  "output file). When it does not apply, say so — a wrong reference is worse than none.",
  "",
  "When it applies, write check.py, a Python 3 module (standard library only) that",
  "Maat's driver imports. It defines:",
  "",
  '  INPUT_FORMAT = "one line: what one input is"        # shown to the second reviewer',
  '  OUTPUT_FORMAT = "one line: what reference() returns" # shown to the second reviewer',
  "  INPUTS = [...]   # JSON-serialisable test inputs",
  "  def reference(inp): ...        # the right result for inp, from the task text",
  "  def run_deliverable(inp): ...  # the deliverable's result for inp, same shape",
  "  def same(expected, actual): ... # optional; default is equality",
  "",
  "INPUTS: every example the task gives; every edge case the task's words DECIDE —",
  "boundaries of each stated range, each kind of item the task lists, with values",
  "chosen to expose an off-by-one or a wrong starting point, calendar edges if dates",
  "are involved, and empty input, duplicates, mixed case, whitespace or CRLF only if",
  "the task speaks of such data; and a few seeded random ones (random.seed(1)). An",
  "edge case is in scope only when the task's words decide its answer: if you would",
  "have to choose how the deliverable should behave (a symlink, a malformed value,",
  "an error the task never mentions), leave it out. Every input must be one the",
  "task's own description allows — a line never contains a newline, a value stated",
  "to be in a range stays in it.",
  "",
  "reference(inp): never hard-codes an answer you worked out by hand — compute it.",
  "When the task says to use something the project already has (a script, a",
  "library, a data file, a converter), call that very thing — its copy under the",
  "folder named by the environment variable REFERENCE_BEFORE — never a rewrite.",
  "Brute force may need to go far (an answer can be years of minutes away): never",
  "cap a search so low that a legal input runs out.",
  "",
  "run_deliverable(inp): runs the deliverable exactly as the task says it is used",
  "(the command line, import path or output file the task names), with exactly",
  "what reference() takes — the same argument strings, stdin, files and working",
  "directory — so anything the output echoes back (a file name as given, a path)",
  "is the same string for both. It runs in the project folder (the current",
  "directory). It must NEVER raise: if the deliverable is missing, crashes or times",
  "out (give each run a timeout), return a short string saying what happened.",
  "Return the result in the same shape reference() does, keeping only what the",
  "task specifies: strip trailing whitespace at line ends and the final newline;",
  "do not keep formatting, ordering or extra output the task does not state (if the",
  "order does not matter, return a sorted list).",
  "",
  "Tasks that change files IN PLACE: the originals, as they were before any work,",
  "are under REFERENCE_BEFORE (same relative paths); read inputs from there and the",
  "deliverable's results from the project. Ignore Maat's own folders .maat/ and",
  ".molt/ wherever you list or compare files. Write temporary files only under",
  "tempfile.mkdtemp(), never into the project.",
  "",
  "Reply with one line of JSON, and when it applies the whole module after it in a",
  "fenced python block — never inside the JSON:",
  '{"applies": true, "reason": "one line"}',
  "```python",
  "...check.py...",
  "```",
  "or only",
  '{"applies": false, "reason": "one line"}',
].join("\n");

/** The second, independent reviewer: one function, from the task and the input format only. */
export const SECOND_REFERENCE_SYSTEM = [
  "You independently compute the right answers for one coding task, for a check that",
  "compares two references written by reviewers who never see each other's code.",
  "Inputs where the two disagree are not used, so a careful literal answer matters",
  "more than a clever one.",
  "",
  "Write second.py, a Python 3 module (standard library only) defining",
  "  def reference(inp): ...",
  "returning the right result for one input, computed from the task text: brute",
  "force, every rule applied exactly as written, nothing worked out by hand. You are",
  "told what an input is and what shape the result takes; match that shape exactly.",
  "When the task says to use something the project already has (a script, a",
  "library, a data file), call that very thing — its copy under the folder named by",
  "the environment variable REFERENCE_BEFORE — never a rewrite. Files the task",
  "works on are under REFERENCE_BEFORE as they were before any work. Ignore .maat/",
  "and .molt/. Write temporary files only under tempfile.mkdtemp().",
  "",
  "Reply with the module only, in one fenced python block.",
].join("\n");

/**
 * Maat's own driver: never written by a model. It computes both references on
 * every input before the deliverable runs; judges the deliverable only where
 * they agree; and exits 3 — the check's own failure, never the work's — when
 * a reference fails, the two mostly disagree, or run_deliverable raises.
 */
export const DRIVER = [
  "import importlib.util, json, os, sys, traceback",
  "HERE = os.path.dirname(os.path.abspath(__file__))",
  "def load(name):",
  "    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, name + '.py'))",
  "    m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m",
  "def key(v):",
  "    try: return json.dumps(v, sort_keys=True, default=repr)",
  "    except Exception: return repr(v)",
  "def own(msg):",
  "    sys.stdout.flush(); sys.stderr.write('REFERENCE ERROR: ' + msg + '\\n'); sys.exit(3)",
  "try:",
  "    a = load('check'); b = load('second'); inputs = list(a.INPUTS)[:200]",
  "except SystemExit: raise",
  "except BaseException:",
  "    traceback.print_exc(); own('a reference could not be loaded')",
  "if not inputs: own('the reference defines no inputs')",
  "agreed, disagreed = [], []",
  "for x in inputs:",
  "    try: ea = a.reference(x)",
  "    except BaseException: traceback.print_exc(); own('the first reference failed on input %r' % (x,))",
  "    try: eb = b.reference(x)",
  "    except BaseException as e: eb = ('<the second reference failed>', repr(e))",
  "    (agreed if key(ea) == key(eb) else disagreed).append((x, ea, eb))",
  "need = len(inputs) if len(inputs) < 3 else max(3, (len(inputs) + 1) // 2)",
  "if len(agreed) < need:",
  "    x, ea, eb = disagreed[0]",
  "    own('the two independent references agree on only %d of %d inputs; first disagreement, input %r: %r vs %r' % (len(agreed), len(inputs), x, ea, eb))",
  "same = getattr(a, 'same', None)",
  "for x, e, _ in agreed:",
  "    try: got = a.run_deliverable(x)",
  "    except BaseException: traceback.print_exc(); own('run_deliverable raised on input %r' % (x,))",
  "    try: ok = same(e, got) if same else key(e) == key(got)",
  "    except BaseException: traceback.print_exc(); own('the comparison failed on input %r' % (x,))",
  "    if not ok:",
  "        print('input: %r\\nexpected: %r\\nactual:   %r\\n(two independent references agree on the expected result)' % (x, e, got)); sys.exit(1)",
  "print('%d inputs match two independent references%s' % (len(agreed), '; %d where they disagreed were not judged' % len(disagreed) if disagreed else ''))",
  "",
].join("\n");

/** What the second reviewer is told about the inputs: their format and a few of them, never an answer. */
export const PROBE = [
  "import importlib.util, json, os, sys",
  "spec = importlib.util.spec_from_file_location('check', sys.argv[1])",
  "m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)",
  "print(json.dumps({'input': str(getattr(m, 'INPUT_FORMAT', '')), 'output': str(getattr(m, 'OUTPUT_FORMAT', '')), 'n': len(m.INPUTS), 'sample': [repr(x)[:300] for x in list(m.INPUTS)[:5]]}))",
  "",
].join("\n");

/**
 * The verdict line and the program from a reply.
 *
 * The program comes in its own fenced block, not as a JSON string: inside
 * JSON a whole Python file has to be escaped twice over, and on local tasks
 * one reply in four came back with a newline decoded into the middle of a
 * string literal — a SyntaxError that, run as a check, exits 1 exactly like
 * a real mismatch and refused six correct solutions in a row. A JSON
 * `check_py` is still read when a model sends one anyway.
 */
export function parseReferenceReply(text: string): { applies: boolean; reason: string; source: string } | null {
  const fence = text.search(/```(?:python|py)?[ \t]*\n/i);
  const head = fence === -1 ? text : text.slice(0, fence);
  const j = jsonIn(head) ?? (fence === -1 ? null : jsonIn(text));
  if (!j) return null;
  let source = typeof j.check_py === "string" ? j.check_py : "";
  if (fence !== -1) {
    const body = text.slice(fence).replace(/^```(?:python|py)?[ \t]*\n/i, "");
    const end = body.lastIndexOf("```");
    source = end === -1 ? body : body.slice(0, end);
  }
  return { applies: j.applies === true, reason: String(j.reason ?? "").slice(0, 200), source };
}

export type Snapshot = { dir: string; files: number; bytes: number; hash: string };

/**
 * Copy the project as it is now into a fresh folder outside it.
 *
 * Taken before the first step, so everything the reference reads predates the
 * work. Null when the project is too large to copy quickly — the reference is
 * an extra, never a reason for a slow start.
 */
export function snapshotProject(cwd: string, root = mkdtempSync(join(tmpdir(), "ref-"))): Snapshot | null {
  const files: string[] = [];
  let bytes = 0;
  const walk = (dir: string): boolean => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const e of entries) {
      if (SKIP.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!walk(p)) return false;
      } else if (e.isFile()) {
        bytes += statSync(p).size;
        files.push(relative(cwd, p));
        if (bytes > REFERENCE_MAX_SNAPSHOT_BYTES || files.length > REFERENCE_MAX_SNAPSHOT_FILES) return false;
      }
    }
    return true;
  };
  if (!walk(cwd)) return null;
  const before = join(root, "before");
  mkdirSync(before, { recursive: true });
  const h = createHash("sha256");
  for (const f of files.sort()) {
    const to = join(before, f);
    mkdirSync(join(to, ".."), { recursive: true });
    cpSync(join(cwd, f), to);
    h.update(f).update("\0").update(readFileSync(to)).update("\0");
  }
  return { dir: root, files: files.length, bytes, hash: h.digest("hex") };
}

/** What the reference writer sees of the project: names, sizes, first lines. */
export function describeSnapshot(before: string, limit = 40): string {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const buf = readFileSync(p);
        const binary = buf.subarray(0, 4096).includes(0);
        const head = binary ? "(binary)" : buf.toString("utf8").split("\n").slice(0, 8).join("\n");
        out.push(`--- ${relative(before, p)} (${buf.length} bytes)\n${head}`);
      }
    }
  };
  walk(before);
  return out.join("\n") || "(empty)";
}

export type Reference =
  | { ok: true; check: Check; snapshot: Snapshot; reason: string; source: string }
  | { ok: false; why: string };

type Ask = Omit<AskOptions, "system" | "prompt" | "maxTokens"> & { task: string; snapshot: Snapshot; python?: string };

/**
 * Two independent references and Maat's driver, tried once on the untouched
 * project. The first writer is asked once more when its module reports its
 * own bug there; a pair that mostly disagrees is dropped.
 */
export async function draftReference(opts: Ask): Promise<Reference> {
  const before = join(opts.snapshot.dir, "before");
  const prompt = `TASK TEXT:\n${opts.task}\n\nFILES IN THE PROJECT BEFORE ANY WORK:\n${describeSnapshot(before)}`;
  let r = await writeAndTry(opts, prompt);
  if (!r.ok && "selfError" in r && r.selfError && !/independent references agree on only/.test(r.selfError)) {
    const again =
      `${prompt}\n\nYour previous check.py failed in its own code on the untouched project:\n${r.selfError}\n\n` +
      "Fix it. Every expected value must come from running your reference; run_deliverable must never raise. " +
      "Reply with the JSON line and the full corrected module.";
    r = await writeAndTry(opts, again);
  }
  return r.ok ? r : { ok: false, why: r.why };
}

async function writeAndTry(opts: Ask, prompt: string): Promise<Reference | { ok: false; why: string; selfError?: string }> {
  const dir = opts.snapshot.dir;
  const before = join(dir, "before");
  const python = opts.python ?? "python3";
  const env = `REFERENCE_BEFORE='${before}'`;
  const asked = await askModel({ ...opts, system: REFERENCE_SYSTEM, prompt, maxTokens: REFERENCE_MAX_TOKENS, what: "writing a reference check" });
  if (!asked.ok) return { ok: false, why: asked.error };
  const parsed = parseReferenceReply(asked.text);
  if (!parsed) return { ok: false, why: "the reply was not JSON" };
  const { reason, source } = parsed;
  if (!parsed.applies) return { ok: false, why: `does not apply: ${reason || "no reason given"}` };
  if (!source.trim()) return { ok: false, why: "no program in the reply" };
  const file = join(dir, "check.py");
  writeFileSync(file, source);
  writeFileSync(join(dir, "probe.py"), PROBE);
  writeFileSync(join(dir, "driver.py"), DRIVER);
  // Every try runs on a scratch copy of the untouched project, never on the
  // project: by now the work may have begun.
  const scratch = mkdtempSync(join(tmpdir(), "ref-try-"));
  cpSync(before, scratch, { recursive: true });
  const compiled = await runCommand(`${python} -m py_compile '${file}'`, { cwd: scratch, timeoutMs: 30_000, maxBuffer: 256 * 1024 });
  if (compiled.code !== 0) {
    const said = lastLines(`${compiled.stdout}\n${compiled.stderr}`);
    return { ok: false, why: `the reference does not compile: ${said}`, selfError: said };
  }
  const probed = await runCommand(`${env} ${python} '${join(dir, "probe.py")}' '${file}'`, { cwd: scratch, timeoutMs: 30_000, maxBuffer: 256 * 1024 });
  let shape: { input: string; output: string; n: number; sample: string[] };
  try {
    shape = JSON.parse(probed.stdout.trim().split("\n").at(-1) ?? "");
  } catch {
    const said = lastLines(`${probed.stdout}\n${probed.stderr}`);
    return { ok: false, why: `the reference module does not load or defines no INPUTS: ${said}`, selfError: said };
  }
  if (!shape.n) return { ok: false, why: "the reference defines no inputs", selfError: "INPUTS is empty" };
  // The second reviewer: the task, the files, what an input is and what shape
  // the answer takes — never the first reviewer's code or answers.
  const second = await askModel({
    ...opts,
    system: SECOND_REFERENCE_SYSTEM,
    prompt:
      `TASK TEXT:\n${opts.task}\n\nFILES IN THE PROJECT BEFORE ANY WORK:\n${describeSnapshot(before)}\n\n` +
      `ONE INPUT IS: ${shape.input || "(not described)"}\nreference(inp) RETURNS: ${shape.output || "(not described)"}\n` +
      `SOME OF THE INPUTS (Python repr):\n${shape.sample.map((x) => `- ${x}`).join("\n")}`,
    maxTokens: REFERENCE_MAX_TOKENS,
    what: "writing the second reference",
  });
  if (!second.ok) return { ok: false, why: `no second reference: ${second.error}` };
  const secondSource = fencedPython(second.text);
  if (!secondSource) return { ok: false, why: "the second reference reply held no program" };
  writeFileSync(join(dir, "second.py"), secondSource);
  const compiled2 = await runCommand(`${python} -m py_compile '${join(dir, "second.py")}'`, { cwd: scratch, timeoutMs: 30_000, maxBuffer: 256 * 1024 });
  if (compiled2.code !== 0) return { ok: false, why: `the second reference does not compile: ${lastLines(compiled2.stderr)}` };
  const check: Check = {
    name: REFERENCE_CHECK_NAME,
    kind: "command",
    run: `${env} ${python} '${join(dir, "driver.py")}'`,
    timeoutMs: REFERENCE_TIMEOUT_MS,
    expectExit: 0,
    // It runs the deliverable on inputs and compares what it returns to two
    // independently written references: a run that asserts values.
    tags: ["task", "reference", "value"],
    hidden: true,
  };
  // The reference value-check is hidden; keep its command out of argv (src/run.ts).
  const tried = await runCommand(check.run, { cwd: scratch, timeoutMs: REFERENCE_TIMEOUT_MS, maxBuffer: 1024 * 1024, hideCommand: true });
  if (tried.timedOut) return { ok: false, why: "the references did not finish on the untouched project" };
  if (tried.code === REFERENCE_SELF_ERROR) {
    const said = lastLines(`${tried.stdout}\n${tried.stderr}`);
    return { ok: false, why: `the reference reported its own bug: ${said}`, selfError: said };
  }
  if (tried.code === 0) return { ok: false, why: "the reference already passes on the untouched project, so it cannot tell work from none" };
  return { ok: true, check, snapshot: opts.snapshot, reason, source: `${source}\n\n# ---- second.py ----\n${secondSource}` };
}

/** The first fenced python block in a reply, or the whole reply when it has none and looks like code. */
export function fencedPython(text: string): string {
  const m = /```(?:python|py)?[ \t]*\n([\s\S]*?)```/i.exec(text);
  if (m) return m[1]!;
  return /^\s*(?:import|from|def)\s/m.test(text) ? text : "";
}

function lastLines(s: string, n = 3): string {
  return s.trim().split("\n").slice(-n).join(" / ").slice(0, 300);
}
