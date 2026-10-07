/**
 * Drafting acceptance criteria for a task.
 *
 * The friction this removes is the reason per-task verification does not
 * normally exist: writing shell commands before every task is a discipline
 * nobody keeps past Wednesday. A model is good at turning "make the picker
 * show local models" into "npm test -- picker" and a sentence about what a
 * person should see — it is simply not allowed to decide whether its own work
 * met either.
 *
 * So this drafts, and a person edits and approves, and the engine seals what
 * they approved before any work begins. The model contributes the part it is
 * good at and touches none of the part it is not.
 *
 * Two rules shape the prompt below, and both exist because the obvious draft
 * is the useless one:
 *
 *  - A command must already exist in this project. A model inventing
 *    `npm run verify-picker` produces a criterion that fails for the wrong
 *    reason and teaches everyone to ignore criteria.
 *  - Anything not mechanically checkable is a note, and is labelled as one.
 *    A sentence dressed as a check is worse than no check.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { openSync, readSync, closeSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { topLevel } from "./brief.js";
import { namedInputs, profileLine } from "./inspect.js";
import { askModel, type AskOptions } from "./ask.js";
import { runCommand, draftedShell, bashPath } from "./run.js";
import { lintAll, readTree, type LintCtx, type Tree } from "./checklint.js";
import { checkMutates } from "./checkwrites.js";
import { copyTree } from "./scratch.js";
import { diagnoseFailure } from "./bar.js";
import { normalizeRequirements } from "./signout.js";
import { evidenceTags } from "./tiers.js";

/**
 * `surface`: the critic read it as only looking (a file exists, a word
 * appears, it compiles) rather than running the deliverable. Kept, but such a
 * check alone cannot carry a "verified" once the ones that ran it are retired.
 */
export type DraftedCheck = { name: string; run: string; surface?: true };
export type Draft = {
  checks: DraftedCheck[];
  notes: string[];
  /**
   * The task's own stated requirements, verbatim quotes (src/signout.ts). Not
   * checks: they are kept with the sealed criteria so an unattended turn can
   * sign each one out before its claim is judged.
   */
  requirements?: string[];
};

/** Same bounds the drafter uses — applied again at `session:run`. */
export const CRITERIA_MAX_CHECKS = 4;
export const CRITERIA_MAX_NOTES = 3;
export const CRITERIA_MAX_NAME = 40;
/**
 * The longest command a drafted check may be.
 *
 * It was 300, and a longer one was cut to 300. On a benchmark every drafted
 * check over the limit came back "Syntax error: Unterminated quoted string":
 * a truncated command is not a shorter command, it is a different one that
 * does not parse, and seven correct pieces of work were reported "not proven"
 * against it. A check over the limit is dropped and said, never cut.
 */
export const CRITERIA_MAX_RUN = 1_000;
export const CRITERIA_MAX_NOTE = 200;

/**
 * Shape a renderer-supplied payload into checks the engine may run.
 *
 * The page is untrusted. `session:run` used to copy `name`/`run` off whatever
 * arrived, so a non-array `checks`, a 10kB shell string, or a number where a
 * command should be became `shell: true` in the workspace. The drafter already
 * capped this; the run handler did not.
 */
export function sanitizeCriteria(raw: unknown): Draft {
  if (!raw || typeof raw !== "object") return { checks: [], notes: [] };
  const o = raw as { checks?: unknown; notes?: unknown; requirements?: unknown };
  const checks: DraftedCheck[] = Array.isArray(o.checks)
    ? o.checks
        .filter(
          (c): c is DraftedCheck =>
            !!c &&
            typeof (c as DraftedCheck).name === "string" &&
            typeof (c as DraftedCheck).run === "string" &&
            (c as DraftedCheck).run.trim().length > 0 &&
            // Dropped, not cut, and before the cap on count so a dropped
            // check does not use up a slot: see CRITERIA_MAX_RUN.
            (c as DraftedCheck).run.trim().length <= CRITERIA_MAX_RUN,
        )
        .slice(0, CRITERIA_MAX_CHECKS)
        .map((c) => ({
          name: c.name.trim().slice(0, CRITERIA_MAX_NAME),
          run: c.run.trim(),
          ...(c.surface === true ? { surface: true as const } : {}),
        }))
    : [];
  const notes: string[] = Array.isArray(o.notes)
    ? o.notes
        .filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        .slice(0, CRITERIA_MAX_NOTES)
        .map((n) => n.trim().slice(0, CRITERIA_MAX_NOTE))
    : [];
  const requirements = normalizeRequirements(Array.isArray(o.requirements) ? o.requirements : undefined);
  return { checks, notes, ...(requirements.length ? { requirements } : {}) };
}

/**
 * The shape `session:run` seals. Built here so a test of garbage input is a
 * test of the boundary, not of a mapper the handler forgot to call.
 */
export function taskChecksFrom(
  raw: unknown,
  opts: { hidden?: boolean } = {},
): {
  taskChecks: {
    name: string;
    kind: "command";
    run: string;
    timeoutMs: number;
    expectExit: number;
    tags: string[];
    hidden?: boolean;
  }[];
  taskNotes: string[];
  requirements?: string[];
} {
  const drafted = sanitizeCriteria(raw);
  return {
    taskChecks: drafted.checks.map((c) => ({
      name: c.name,
      kind: "command" as const,
      run: c.run,
      timeoutMs: 120_000,
      expectExit: 0,
      // surface from the critic, value from the command itself (evidence.ts).
      tags: evidenceTags(c.run, c.surface),
      ...(opts.hidden ? { hidden: true } : {}),
    })),
    taskNotes: drafted.notes,
    ...(drafted.requirements ? { requirements: drafted.requirements } : {}),
  };
}

/**
 * Try each drafted criterion once, before the work, and report the ones that
 * cannot run at all.
 *
 * The prompt above already tells the model not to invent a command. A local
 * 8B model did anyway: it sealed a criterion grepping a file that did not
 * exist, and the run ended with the model dutifully trying to create the file
 * so the grep would stop erroring. An instruction is the weakest place to put
 * a rule that a command can settle, so this settles it.
 *
 * Two deliberate limits:
 *
 *  - A criterion is EXPECTED to fail here. Failing before the work is the
 *    entire point of one. Only "did not run" is reported — the shell could
 *    not find or execute the command.
 *  - It reports; it does not veto. A criterion can be legitimately unrunnable
 *    beforehand and runnable after, if the work is what installs the tool it
 *    names. Blocking on that would refuse a correct criterion, and the bar
 *    still has the final say when the work claims to be finished.
 *
 * Short timeout, because this runs before every turn that seals criteria and
 * a criterion that is still running after a few seconds has plainly run.
 */
export type BrokenCriterion = { name: string; run: string; why: string };

/** What sh, bash and python say about a command they could not read. */
export const SHELL_PARSE_ERROR =
  /Syntax error|syntax error|unexpected EOF|unterminated|unexpected end of file|SyntaxError/i;

function firstLine(s: string): string {
  return (s.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "").slice(0, 160);
}

/**
 * Did a check fail because of itself — its own code or the tools it calls —
 * rather than the work? Only signs that cannot come from the deliverable
 * count: a tool rejecting its own options, git outside a repository, a
 * NameError or SyntaxError in the check's inline program, a standard-library
 * call it got wrong. A missing file, a missing function or an assertion is
 * the work's business (before the work, those are expected).
 *
 * Of 17 local runs where molt said "not proven" about work the grader passed,
 * 6 were checks like these: `find -printf` on macOS, `git diff` outside a
 * repository, `Path.read_text(newlines=…)`, a NameError in the check's own
 * code. A check that breaks this way can refuse correct work forever.
 */
export function checkSelfError(output: string): string | null {
  const tool: [RegExp, string][] = [
    [/unknown primary or operator/i, "a tool rejected the check's options"],
    [/^usage: git /im, "git rejected the check's command"],
    [/not a git repository/i, "the check runs git outside a git repository"],
    // A check that compares against `git show HEAD:<file>` needs a commit that
    // holds the file. Where the file is untracked, or the repository has no
    // commit, git answers fatal and the check says nothing about the work: on
    // the local suite 5 of the passing runs molt called unverified were
    // refused by exactly this, in different checks. Only HEAD (or an empty
    // revision left by a failed substitution) counts — a branch the work was
    // meant to create and did not is the work's failure, not the check's.
    [/fatal: path '[^']*' (?:does not exist|exists on disk, but not) in 'HEAD'/i, "the check reads a file from HEAD that no commit holds"],
    [/fatal: (?:ambiguous argument '(?:HEAD)?': unknown revision|bad revision 'HEAD'|invalid object name 'HEAD')/i, "the check names a revision that does not exist"],
    [/\b(illegal|invalid|unrecognized) option\b/i, "a tool rejected the check's options"],
    [/illegal time specification|out of range or illegal time/i, "a tool rejected the check's date format"],
    [/syntax error near unexpected token|unexpected EOF while looking for/i, "the check's shell syntax is broken"],
  ];
  for (const [re, why] of tool) if (re.test(output)) return why;
  // Compile errors of the check's own program. `python3 -c` with a syntax
  // error prints `File "<string>", line 10` and `SyntaxError:` with no
  // "Traceback" line at all, so the traceback rule below never saw it: a
  // redact-secrets check with an unterminated f-string refused five correct
  // solutions. jq and sqlite3 name their own compile errors.
  // Only when the innermost frame is the inline program: `-c "import x"`
  // over a deliverable with a syntax error names x.py last, and that is the
  // work's fault.
  const lastFrame = [...output.matchAll(/^\s*File "([^"]+)", line \d+/gm)].map((m) => m[1]).at(-1);
  if ((lastFrame === "<string>" || lastFrame === "<stdin>") && /^(?:SyntaxError|IndentationError|TabError)\b/m.test(output)) return "the check's own program has a bug";
  if (/^jq: error: syntax error|^jq: \d+ compile errors?/m.test(output)) return "the check's jq program does not compile";
  if (/^(?:Parse error|Error): .*\n?.*syntax error/im.test(output) || /near ".*": syntax error/.test(output)) return "the check's SQL does not parse";
  if (/Traceback \(most recent call last\)/.test(output)) {
    const frames = [...output.matchAll(/File "([^"]+)", line \d+/g)].map((m) => m[1]);
    const inline = frames.length > 0 && (frames.at(-1) === "<string>" || frames.at(-1) === "<stdin>");
    if (inline && /^(NameError|SyntaxError|IndentationError|UnboundLocalError)\b/m.test(output)) return "the check's own program has a bug";
    if (/got an unexpected keyword argument|no such group|invalid group reference/.test(output)) return "the check's own program misuses a library call";
    // Syntax-tree nodes belong to the standard library, not the deliverable: an
    // attribute they lack (`FunctionDef.docstring`) is the check's mistake.
    if (/^AttributeError: '(?:Module|FunctionDef|AsyncFunctionDef|ClassDef)' object has no attribute/m.test(output)) return "the check's own program misuses a library call";
  }
  return null;
}

/** Absolute prefixes of the system itself: tools, libraries, devices. Never the project's own files. */
const SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/opt", "/lib", "/lib32", "/lib64", "/etc", "/dev", "/proc", "/sys", "/System", "/Library", "/Applications"];
const TEMP_PATHS = ["/tmp", "/private/tmp", "/var/tmp", "/var/folders", "/private/var/folders"];

function under(p: string, root: string): boolean {
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/**
 * The first absolute path in a drafted command that points outside the
 * project, or null. Allowed: anything under the working directory, the system
 * temp directory (what `mktemp -d` returns), system locations (/usr/bin/env,
 * /dev/null, /opt/homebrew/...), and a path the task text itself states.
 *
 * Seen in real runs: `python3 /wc.py` and `/home/user/data.csv` in checks
 * drafted without any view of the project. They fail for ever, whatever the
 * work does, and refuse correct work. Paths with a trailing slash are skipped
 * (`awk '/x/'`, `sed 's/a/b/'` delimiters), as is anything glued to a word,
 * `$VAR`, `./`, or `://` — those are relative paths, expansions and URLs —
 * and so are closing tags (`</h1>`) and cron steps. A deliberately missing path
 * (`/nonexistent`) tests error handling and is allowed.
 */
export function strayPath(run: string, opts: { cwd: string; task?: string }): string | null {
  let real = opts.cwd;
  try {
    real = realpathSync(opts.cwd);
  } catch {
    /* a cwd that is not there: compare as given */
  }
  const roots = [opts.cwd, real, ...TEMP_PATHS, tmpdir(), ...SYSTEM_PATHS];
  for (const m of run.matchAll(/(?<![\w.$}):/~<*+\]\\-])(\/[\w.@+-][^\s"'`;|&<>()*?\[\]{}$,=\\]*)/g)) {
    const p = m[1]!;
    if (p.endsWith("/")) continue;
    // A path built to not exist is an error-handling test, not an invention.
    if (/nonexist|no[-_]such|does[-_]?not[-_]?exist|missing/i.test(p)) continue;
    if (roots.some((r) => under(p, r))) continue;
    if (opts.task && opts.task.includes(p)) continue;
    return p;
  }
  return null;
}

export async function preflightCriteria(
  checks: readonly { name: string; kind?: string; run?: string; expectExit?: number }[],
  opts: {
    cwd: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /**
     * Filled with the names of criteria that already PASS before the work.
     *
     * Such a criterion guards against breaking something; it cannot tell a
     * finished task from an untouched one, so its pass at the end is not
     * evidence the task was done. The engine uses this to say so.
     */
    passed?: string[];
    /**
     * Set for DRAFTED checks: a command that reaches for an absolute path
     * outside the project (see strayPath) is reported broken without being
     * run. The task text is where a path the person stated is allowed from.
     */
    stray?: { task: string };
  },
): Promise<BrokenCriterion[]> {
  const broken: BrokenCriterion[] = [];
  for (const c of checks) {
    if (c.kind && c.kind !== "command") continue;
    if (!c.run) continue;
    const stray = opts.stray ? strayPath(c.run, { cwd: opts.cwd, task: opts.stray.task }) : null;
    if (stray) {
      broken.push({ name: c.name, run: c.run, why: `it uses ${stray}, an absolute path outside the project (paths must be relative to the working directory)` });
      continue;
    }
    // In a copy, like the bar (src/scratch.ts): tried before the work, a check
    // that checks out a branch or deletes a file would change the folder the
    // work starts from.
    const copy = process.env.MAAT_CHECK_COPY === "0" ? null : await copyTree(opts.cwd);
    try {
      const r = await runCommand(c.run, {
        cwd: copy?.dir ?? opts.cwd,
        // Drafted checks (stray set) run under the shell the bar will use.
        shell: draftedShell({ hidden: !!opts.stray, tags: ["task"] }),
        timeoutMs: opts.timeoutMs ?? 5_000,
        maxBuffer: 1024 * 1024,
        signal: opts.signal,
      });
      // One decision point, shared with the bar. A command that outlived the
      // timeout plainly ran, and a timeout's exit code is never one of the
      // shell's "could not execute that" codes, so it needs no separate case
      // here — a second copy of this judgement is a second place to drift.
      const d = diagnoseFailure(r.code ?? 0, r.stdout, r.stderr);
      // A shell that could not parse the command ran nothing, whatever the
      // exit code says; sending a model to satisfy it would send it to
      // satisfy a command that cannot be satisfied.
      const unparsed = SHELL_PARSE_ERROR.test(r.stderr);
      const selfError = r.code !== (c.expectExit ?? 0) ? checkSelfError(`${r.stdout}\n${r.stderr}`) : null;
      if (d.didNotRun) broken.push({ name: c.name, run: c.run, why: d.hint ?? "did not run" });
      else if (unparsed) {
        broken.push({ name: c.name, run: c.run, why: `the shell could not parse it: ${firstLine(copy ? copy.unmap(r.stderr) : r.stderr)}` });
      } else if (selfError) broken.push({ name: c.name, run: c.run, why: selfError }); else if (!r.timedOut && r.code === (c.expectExit ?? 0)) opts.passed?.push(c.name);
    } catch {
      // Failing to spawn it here is molt's problem, not the criterion's.
      // Reporting it as broken would block work for the wrong reason.
    } finally {
      await copy?.cleanup();
    }
  }
  return broken;
}

/** Caps for the project view the drafter and critic are shown. */
export const VIEW_MAX_ENTRIES = 40;
export const VIEW_MAX_LISTING = 2_000;
export const VIEW_MAX_PROFILE = 1_500;

function firstTextLine(abs: string): string {
  try {
    const fd = openSync(abs, "r");
    try {
      const buf = Buffer.alloc(400);
      const n = readSync(fd, buf, 0, 400, 0);
      const head = buf.subarray(0, n);
      if (head.includes(0)) return "";
      return (head.toString("utf8").split("\n")[0] ?? "").trim().slice(0, 100);
    } finally {
      closeSync(fd);
    }
  } catch {
    return "";
  }
}

/**
 * What the worker is shown and the drafter used not to be: where the work
 * happens, what is in it, and what the files the task names look like. Without
 * it a drafter invents `python3 /wc.py` and hand-computes expected values it
 * could have read from the input. Bounded (entries, characters) because the
 * drafter often runs on a slow model. Empty when there is no directory.
 */
export function projectView(task: string, cwd?: string): string {
  if (!cwd) return "";
  const lines = [`Working directory: ${cwd}`];
  let listing = topLevel(cwd, VIEW_MAX_ENTRIES + 1).filter((n) => n !== ".maat/" && n !== ".maat").slice(0, VIEW_MAX_ENTRIES).join(" ");
  if (listing.length > VIEW_MAX_LISTING) listing = `${listing.slice(0, VIEW_MAX_LISTING)}…`;
  lines.push(`Project files (top level): ${listing || "(empty)"}`);
  let profile = "";
  for (const abs of namedInputs(task, cwd, 6)) {
    try {
      if (!statSync(abs).isFile()) continue;
      const rel = relative(cwd, abs);
      let entry = profileLine(abs, isAbsolute(rel) || rel.startsWith("..") ? abs : rel).slice(0, 240);
      const first = firstTextLine(abs);
      if (first) entry += `\n    first line: ${first}`;
      if (profile.length + entry.length > VIEW_MAX_PROFILE) break;
      profile += `${profile ? "\n" : ""}  ${entry}`;
    } catch {
      /* unreadable: leave it out */
    }
  }
  if (profile) lines.push(`Input files the task names:`, profile);
  return lines.join("\n");
}

/**
 * Everything the drafter reads about the project, taken once, before the first
 * step. Every drafter stage — the first draft, the lint redraft, the critic,
 * the cover step, the redraft after review, and a whole second try — reads
 * this and never the live folder: those stages run while the worker is
 * already changing files, and a redraft that re-read the tree once saw the
 * worker's out.txt and could have sealed its answer as the check.
 */
export type DrafterInputs = {
  /** The task text as given, before any review findings are appended. */
  readonly task: string;
  /** projectView(task, cwd) at turn start. */
  readonly view: string;
  /** readTree(cwd) at turn start, for the seal-time lint. */
  readonly tree?: Tree;
  readonly commands?: { present: string[]; missing: string[] };
  readonly scripts: readonly string[];
  readonly lessons: readonly string[];
};

/** Take the drafter's inputs now. */
export function drafterSnapshot(
  task: string,
  cwd: string | undefined,
  rest: { commands?: { present: string[]; missing: string[] }; scripts?: string[]; lessons?: string[] },
): DrafterInputs {
  return Object.freeze({
    task,
    view: projectView(task, cwd),
    ...(cwd ? { tree: readTree(cwd) } : {}),
    ...(rest.commands ? { commands: { present: [...rest.commands.present], missing: [...rest.commands.missing] } } : {}),
    scripts: Object.freeze([...(rest.scripts ?? [])]),
    lessons: Object.freeze([...(rest.lessons ?? [])]),
  });
}

/**
 * A hash of the drafter's inputs. Taken at turn start over the snapshot, and
 * again by each drafter stage over the values it actually put in its prompt,
 * so "drafted without sight of the work" is a comparison the record can fail.
 */
export function drafterInputsHash(d: DrafterInputs): string {
  const h = createHash("sha256");
  const part = (k: string, v: string) => h.update(`\0${k}\0${v}`, "utf8");
  part("task", d.task);
  part("view", d.view);
  part("files", d.tree ? [...d.tree.files].sort().join("\n") : "");
  part("text", d.tree?.text ?? "");
  part("present", (d.commands?.present ?? []).join(","));
  part("missing", (d.commands?.missing ?? []).join(","));
  part("scripts", d.scripts.join("\n"));
  part("lessons", d.lessons.join("\n"));
  return h.digest("hex").slice(0, 16);
}

const SYSTEM = [
  "You draft acceptance criteria for one coding task. You are not doing the task",
  "and you will not judge whether it was done — a person approves what you write",
  "and it is sealed before the work starts.",
  "",
  "Return JSON only, matching:",
  '  {"checks":[{"name":"kebab-name","run":"shell command"}],"notes":["sentence"]}',
  "",
  "checks are commands that MUST already work in this project. Prefer the scripts",
  "listed below verbatim, optionally narrowed (npm test -- <pattern>). Never invent",
  "a script that does not exist: a criterion that fails because the command is",
  "missing teaches people to ignore criteria. A plain shell check is also fine —",
  "test -f for a file the task must produce, grep -q for content it must hold, a",
  "curl against a port it must serve, an interpreter one-liner — using only",
  "tools that exist here. Prefer a check that FAILS now and passes once the task is",
  "done: a check that already passes only guards against a regression and cannot",
  "show the task was done. One line each and well under 500 characters: if a",
  "check needs a program, have it run a small script file that the task will add.",
  "Never invent a number, limit, path or format the task does not state: a check",
  "stricter than the task fails correct work, and a check that guesses is not a check.",
  "But every one the task DOES state is a check: each path, exact value, threshold,",
  "count, format, and anything it says must not change or must be the only thing",
  "present. A task that says accuracy above 0.62 gets a check of accuracy above 0.62.",
  "At least one check must run the thing and test its result; a check that only",
  "asks whether a file exists, a name appears, or output parses shows nothing.",
  "When the right answer cannot be known before the work (a fitted value, a model's",
  "accuracy on held-out data, the fastest query), check the closest thing the task",
  "provides instead: the stated threshold on the data that IS here (accuracy >= 0.62",
  "on the provided test split), the fit's error against the measured points, the new",
  "query's time against the original's. Never hard-code an answer you had to guess.",
  "Never write an expected value you worked out yourself — a date, a total, a count,",
  "an output line the task does not state. Your own arithmetic is where checks go",
  "wrong. Expected values come only from the task text; otherwise test what the task",
  "states as a property: the stated number of lines, each strictly after the start,",
  "the stated format, totals that add up, the same answer from two equivalent inputs.",
  "Checks must leave nothing behind: build and write into $(mktemp -d), never into",
  "a directory the task names.",
  "Every path is relative to the working directory shown below. Never write an",
  "absolute path outside it (no /wc.py, no /home/..) except $(mktemp -d) and system",
  "tools; a check with one is dropped. Read expected values from the input files.",
  "",
  "notes are for anything a command cannot decide — how something looks, reads, or",
  "feels. They are recorded on the receipt as stated intent and never reported as",
  "verified. Do not write a note that pretends to be a check.",
  "",
  "Two or three checks and at most two notes. Fewer is better. If the task needs",
  "no criterion beyond the project's own bar, return empty lists.",
].join("\n");

/** Double every backslash that does not start a valid JSON escape; valid pairs are kept whole. */
export function repairEscapes(json: string): string {
  let out = "";
  for (let i = 0; i < json.length; i++) {
    const c = json[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = json[i + 1] ?? "";
    if ('"\\/bfnrtu'.includes(next) && next !== "") {
      out += c + next;
      i += 1;
    } else {
      out += "\\\\";
    }
  }
  return out;
}

/**
 * Strip a fenced block, which models add whatever the instructions say.
 *
 * A reply that holds no JSON object is a failed draft, not an empty one. It
 * used to come back as `{ checks: [], notes: [] }`, which the window reads as
 * the model's considered answer and prints as "the model had nothing to add
 * beyond the project's bar" — over a reply cut off at the token limit, an
 * apology, or nothing at all. `parseInterviewReply` already said "not JSON".
 */
function parseDraft(text: string): Draft | null {
  const body = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  let raw: unknown;
  const json = body.slice(start, end + 1);
  try {
    raw = JSON.parse(json);
  } catch {
    // Shell commands carry backslashes (`grep -q '\.'`, `\d`) that are not
    // JSON escapes, and a draft that was right about the checks failed to
    // parse over one of them — the openssl task then ran with no checks at
    // all. Double the lone ones and try once more.
    try {
      raw = JSON.parse(repairEscapes(json));
    } catch {
      return null;
    }
  }
  return sanitizeCriteria(raw);
}

/** The draft, or a failure that says what came back instead. */
function drafted(
  text: string,
  cutOff = false,
): { ok: true; draft: Draft } | { ok: false; error: string } {
  const draft = parseDraft(text);
  if (draft) return { ok: true, draft };
  const said = text.trim().replace(/\s+/g, " ");
  return {
    ok: false,
    error:
      `the draft reply was not JSON, so nothing was proposed` +
      (cutOff ? " — it was cut off at the token limit" : "") +
      (said ? `: "${said.slice(0, 80)}${said.length > 80 ? "…" : ""}"` : ": the reply was empty"),
  };
}

const EDGE_SYSTEM = [
  "You review a task given to a coding agent BEFORE any work starts. You see only the task text and the files that exist.",
  "Find the places where two reasonable readings of the task would make a correct-looking deliverable produce DIFFERENT OUTPUT on the same input.",
  "List up to 6 probes. A probe is one concrete literal input (a value, a line, a date, a number), the two readings, and what each outputs for it.",
  "Prefer boundary cases: off-by-one in what counts, inclusive/exclusive ranges, rounding and formatting, whole token vs substring, how two rules combine,",
  "empty or malformed input, ordering and ties, what counts as a category. Only real divergence; no generic engineering concerns.",
  "Quote the task words each reading rests on. Fewer is better than padding; an empty list is fine.",
  'Reply with JSON only: {"probes":[{"input":"...","readingA":"...","outputA":"...","readingB":"...","outputB":"...","quote":"..."}]}',
].join("\n");

/**
 * Edge cases where the task reads two ways (MAAT_EDGE_CHECKS=1), asked of the
 * judge before the draft. They are handed to the drafter as candidates, not
 * asked of anyone: a check is written only where the task text settles the
 * reading. Asked as questions they were 90% noise (Bet 3); as check targets
 * they cost one check each and found every trap the models kept failing.
 */
async function edgeProbes(opts: Parameters<typeof draftCriteria>[0], view: string | undefined): Promise<string> {
  const asked = await askModel({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    system: EDGE_SYSTEM,
    prompt: [`Task: ${opts.task}`, ...(view ? ["", view] : [])].join("\n"),
    cwd: opts.askCwd ?? opts.cwd,
    what: "probing edge cases",
    fetchFn: opts.fetchFn,
    acpSpawn: opts.acpSpawn,
    cliRun: opts.cliRun,
    timeoutMs: opts.timeoutMs,
    deadlineAt: opts.deadlineAt,
    reasoningEffort: opts.reasoningEffort,
    latency: opts.latency,
  }).catch(() => null);
  if (!asked?.ok) return "";
  let probes: { input?: unknown; readingA?: unknown; outputA?: unknown; readingB?: unknown; outputB?: unknown; quote?: unknown }[] = [];
  try {
    const m = asked.text.match(/\{[\s\S]*\}/);
    const parsed = m ? (JSON.parse(m[0]) as { probes?: unknown }) : {};
    probes = Array.isArray(parsed.probes) ? (parsed.probes as typeof probes).slice(0, 6) : [];
  } catch {
    return "";
  }
  const lines = probes
    .filter((p) => typeof p.input === "string" && p.input)
    .map((p, i) => `${i + 1}. input ${JSON.stringify(p.input)} — reading A (${String(p.readingA ?? "")}) gives ${String(p.outputA ?? "")}; reading B (${String(p.readingB ?? "")}) gives ${String(p.outputB ?? "")}. Task words: "${String(p.quote ?? "")}"`);
  if (!lines.length) return "";
  return [
    "Edge cases where the task could be read two ways (from a review of the task text):",
    ...lines,
    "For each one the task text SETTLES (quote it), add a check that feeds that literal input and asserts the settled output.",
    "Skip any the task text does not settle: a check must never pick a side the task leaves open.",
  ].join("\n");
}

export async function draftCriteria(opts: {
  task: string;
  scripts: string[];
  barChecks: string[];
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Where the draft is asked for. Only a subprocess (ACP) transport reads it. */
  cwd?: string;
  fetchFn?: typeof fetch;
  /** How an ACP agent is spawned. Tests only; see `EngineConfig.acpSpawn`. */
  acpSpawn?: typeof import("node:child_process").spawn;
  /** How a subscription CLI is run for a pre-turn question (opencode). Tests only. */
  cliRun?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
  /** How long the HTTP question may wait for its answer; see askTimeoutMs. Tests only. */
  timeoutMs?: number;
  /** The run's time budget, as an epoch ms (AskOptions.deadlineAt). */
  deadlineAt?: number;
  /** Pause before re-asking after empty replies (EMPTY_DRAFT_DELAY_MS). Tests only. */
  emptyRetryDelayMs?: number;
  reasoningEffort?: string;
  /** Learns from completed asks (AskOptions.latency). */
  latency?: AskOptions["latency"];
  /** What is installed, so a check never calls a command that is not (see commandsHere). */
  commands?: { present: string[]; missing: string[] };
  /**
   * Drafted checks a person ruled wrong in this project (Judgments.lessons):
   * the mistakes not to seal again.
   */
  lessons?: string[];
  /**
   * The project as it was before the work (drafterSnapshot). When given, the
   * view, scripts, commands and lessons come from it and the folder is not
   * read again; without it they are read now.
   */
  snapshot?: DrafterInputs;
  /** Called with drafterInputsHash of what this call put in its prompt. */
  onInputs?: (sha: string) => void;
  /**
   * Where a subprocess (ACP) drafter is started. Kept apart from the work
   * folder so the agent answering cannot open the worker's files.
   */
  askCwd?: string;
}): Promise<{ ok: true; draft: Draft } | { ok: false; error: string }> {
  const snap = opts.snapshot;
  const view = snap ? snap.view : projectView(opts.task, opts.cwd);
  const scripts = snap ? [...snap.scripts] : opts.scripts;
  const commands = snap ? snap.commands : opts.commands;
  const lessons = snap ? [...snap.lessons] : opts.lessons;
  opts.onInputs?.(
    drafterInputsHash({ task: snap?.task ?? opts.task, view, ...(snap?.tree ? { tree: snap.tree } : {}), ...(commands ? { commands } : {}), scripts, lessons: lessons ?? [] }),
  );
  const askCwd = opts.askCwd ?? opts.cwd;
  const context = [
    `Task: ${opts.task}`,
    ...(view ? ["", view] : []),
    "",
    `Scripts available: ${scripts.length ? scripts.join(", ") : "(none found)"}`,
    `The project already checks: ${opts.barChecks.length ? opts.barChecks.join(", ") : "(nothing)"}`,
    ...(commands ? [`Commands on this machine: ${commands.present.join(", ")}${commands.missing.length ? ` (not installed: ${commands.missing.join(", ")})` : ""}`] : []),
    ...(process.platform === "darwin"
      ? ["This is macOS: BSD tools, not GNU. No `find -printf`, no `stat -c`, no GNU `touch -d`, `sed -i ''` needs the empty argument. Prefer python3 for anything beyond plain shell."]
      : []),
    "`.maat/` is Maat's own folder in the project: a check that lists or counts files must ignore it.",
    ...(lessons?.length
      ? ["", "A person ruled these earlier drafted checks wrong in this project. Do not make the same mistake:", ...lessons.map((l) => `- ${l}`)]
      : []),
    "",
    "Do not repeat what the project already checks. Add only what is specific to",
    "this task.",
  ].join("\n");

  const edges = process.env.MAAT_EDGE_CHECKS === "1" ? await edgeProbes(opts, view) : "";
  const prompted = edges ? `${context}\n\n${edges}` : context;
  const asked = await askModel({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    system: SYSTEM,
    prompt: prompted,
    cwd: askCwd,
    what: "drafting criteria",
    fetchFn: opts.fetchFn,
    acpSpawn: opts.acpSpawn,
    cliRun: opts.cliRun,
    timeoutMs: opts.timeoutMs,
    deadlineAt: opts.deadlineAt,
    reasoningEffort: opts.reasoningEffort,
    latency: opts.latency,
  });
  if (!asked.ok) return asked;
  const first = drafted(asked.text, asked.cutOff);
  if (first.ok) return first;
  // One more ask when the reply was not JSON: a run with no checks at all is
  // worse than one request.
  const again = await askModel({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    system: SYSTEM,
    prompt: `${prompted}\n\nYour last reply could not be parsed as JSON. Reply with the JSON object only.`,
    cwd: askCwd,
    what: "drafting criteria",
    fetchFn: opts.fetchFn,
    acpSpawn: opts.acpSpawn,
    cliRun: opts.cliRun,
    timeoutMs: opts.timeoutMs,
    deadlineAt: opts.deadlineAt,
    reasoningEffort: opts.reasoningEffort,
    latency: opts.latency,
  });
  if (!again.ok) return first;
  const second = drafted(again.text, again.cutOff);
  if (second.ok) return second;
  // Empty twice is the provider, not the prompt: on Terminal-Bench two trials
  // of ten got two empty replies back to back and ran with no checks at all,
  // while the same prompt drafted 4 of 4 a minute later. So an empty reply is
  // asked again after a pause, up to EMPTY_DRAFT_RETRIES more times.
  for (let i = 0; i < EMPTY_DRAFT_RETRIES && again.text.trim() === "" && first.ok === false; i++) {
    await new Promise((r) => setTimeout(r, (opts.emptyRetryDelayMs ?? EMPTY_DRAFT_DELAY_MS) * (i + 1)));
    const more = await askModel({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      system: SYSTEM,
      prompt: context,
      cwd: askCwd,
      what: "drafting criteria",
      fetchFn: opts.fetchFn,
        acpSpawn: opts.acpSpawn,
        cliRun: opts.cliRun,
        timeoutMs: opts.timeoutMs,
        deadlineAt: opts.deadlineAt,
      reasoningEffort: opts.reasoningEffort,
      latency: opts.latency,
    });
    if (!more.ok) break;
    const d = drafted(more.text, more.cutOff);
    if (d.ok) return d;
    if (more.text.trim() !== "") break;
  }
  return first;
}

/** Further asks after two empty draft replies, and the pause before the first. */
export const EMPTY_DRAFT_RETRIES = 2;
export const EMPTY_DRAFT_DELAY_MS = 4_000;

/**
 * A second, fresh reading of a draft, before it is sealed.
 *
 * The drafting prompt already says: never invent a limit, never guess an
 * answer, at least one check must run the thing. On Terminal-Bench 2.0 the
 * drafts broke all three often enough to matter. Of 29 false "verified"
 * claims, about ten rested on a check that demanded something the task did
 * not (an invented `-checkend`, "== 32000" for "< 32,000", a hard-coded
 * guess at the answer), and about nine on checks that only asked whether a
 * file existed or a word appeared. A rule the drafter reads while drafting is
 * a rule it can talk itself past; a critic that did not write the draft reads
 * it cold, against the task text only.
 *
 * The critic drops a check only with a verbatim quote of the task words the
 * check gets wrong — string-matched, so a drop cannot rest on a requirement
 * nobody stated. If no check that runs the deliverable survives, the draft is
 * asked for once more with the critic's findings. Anything that fails leaves
 * the original draft as it was: the critic can only take away, and only with
 * evidence.
 */
export const CRITIC_SYSTEM = [
  "You review acceptance checks another model drafted for a coding task, before any work is done.",
  "You get the task text and the checks. For each check decide one verdict:",
  '  "invents"  — it demands something the task text does not state: a stricter or different',
  "              limit, value, format or path, or it reads a stated limit wrongly (< as ==).",
  '  "guesses"  — it asserts a specific answer the task does not give, one the checker could',
  "              only have guessed (a model name, a count, a result the work must find out).",
  '  "surface"  — it only looks: a file exists, a word appears in source, it compiles, --help works.',
  '  "runs"     — it runs the deliverable on an input and checks what it produces.',
  "For invents and guesses, quote the task words the check gets wrong, verbatim.",
  "",
  "Then list hard requirements no check would catch if the work got them wrong. A hard",
  "requirement is a concrete fact a shell command could test on this machine, right now:",
  "an exact output path that must exist, an exact name or signature, an exact number,",
  "threshold or tolerance the result must meet on data present here, an exact output",
  "format. NOT goals or effort (\"as many as possible\", \"figure out\"), NOT anything",
  "measured on hidden or private data, NOT how the work is done. Quote only the few words",
  "that state it, verbatim, at most two. Usually the list is empty: list one only when",
  "you are sure a wrong result would pass every check.",
  "",
  "Finally list the task's stated requirements, each a short verbatim quote (at most ten):",
  "every concrete thing the finished work must do or contain, in the task's own words.",
  "",
  "Reply with JSON only:",
  '{"checks":[{"name":"...","verdict":"invents|guesses|surface|runs","quote":"verbatim task words, or empty"}],',
  ' "uncovered":["verbatim task words"], "requirements":["verbatim task words"]}',
].join("\n");

export type Critique = {
  kept: DraftedCheck[];
  dropped: { name: string; verdict: "invents" | "guesses"; quote: string }[];
  /** No kept check runs the deliverable. */
  surfaceOnly: boolean;
  /**
   * Requirements the task states that no check would catch, quoted verbatim —
   * string-matched against the task like a drop's quote, so the list cannot
   * hold a requirement nobody stated.
   */
  uncovered: string[];
  /**
   * Every stated requirement the critic quoted, plus the quotes of its drops
   * and uncovered findings — all string-matched against the task, deduplicated,
   * at most REQUIREMENTS_MAX (src/signout.ts).
   */
  requirements: string[];
};

function norm(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/** Apply a critic's reply to a draft. Pure: the part that decides. */
export function applyCritique(draft: Draft, reply: string, task: string): Critique | null {
  const body = reply.slice(reply.indexOf("{"), reply.lastIndexOf("}") + 1);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  const list = (raw as { checks?: unknown }).checks;
  if (!Array.isArray(list)) return null;
  const verdicts = new Map<string, { verdict: string; quote: string }>();
  for (const v of list) {
    if (!v || typeof v !== "object") continue;
    const o = v as Record<string, unknown>;
    verdicts.set(String(o.name ?? ""), { verdict: String(o.verdict ?? ""), quote: String(o.quote ?? "") });
  }
  const t = norm(task);
  const kept: DraftedCheck[] = [];
  const dropped: Critique["dropped"] = [];
  let runs = 0;
  for (const c of draft.checks) {
    const v = verdicts.get(c.name);
    const grounded = !!v && norm(v.quote).length >= 4 && t.includes(norm(v.quote));
    if (v && (v.verdict === "invents" || v.verdict === "guesses") && grounded) {
      dropped.push({ name: c.name, verdict: v.verdict, quote: v.quote });
      continue;
    }
    kept.push(v?.verdict === "surface" ? { ...c, surface: true } : c);
    if (!v || v.verdict === "runs") runs += 1;
  }
  const said = (raw as { uncovered?: unknown }).uncovered;
  const uncovered = (Array.isArray(said) ? said : [])
    .map((q) => String(q ?? "").trim())
    .filter((q) => norm(q).length >= 8 && t.includes(norm(q)))
    .slice(0, CRITIC_MAX_UNCOVERED);
  const stated = (Array.isArray((raw as { requirements?: unknown }).requirements) ? (raw as { requirements: unknown[] }).requirements : [])
    .map((q) => String(q ?? "").trim())
    .filter((q) => norm(q).length >= 8 && t.includes(norm(q)));
  const requirements = normalizeRequirements([...stated, ...uncovered, ...dropped.map((d) => d.quote).filter((q) => norm(q).length >= 8)]);
  return { kept, dropped, surfaceOnly: runs === 0 && kept.length > 0, uncovered, requirements };
}

/** How long the uncovered-requirement step may add to drafting. */
export const COVER_MAX_MS = 30_000;

/** How many uncovered requirements one critique may raise. */
export const CRITIC_MAX_UNCOVERED = 3;

/**
 * Draft, critique, and — when nothing runs the deliverable or checks were
 * dropped — draft once more with the findings. Returns the draft to seal and
 * what the critic did, for the receipt.
 */
export async function draftCriteriaCritiqued(
  opts: Parameters<typeof draftCriteria>[0] & {
    /** Called with the best draft so far — the reviewed checks once there are any. */
    onProgress?: (d: Draft) => void;
    /** Bound on the step that adds checks for uncovered requirements (COVER_MAX_MS). */
    coverMaxMs?: number;
  },
): Promise<{ ok: true; draft: Draft; critique: string[]; lint?: LintDrop[] } | { ok: false; error: string }> {
  // The critic's list of stated requirements rides on whatever draft comes
  // back, however many ways the function below returns.
  const sink: Sink = { requirements: [], lint: [] };
  const withReqs = (d: Draft): Draft => (sink.requirements.length ? { ...d, requirements: sink.requirements } : d);
  // Every stage below reads the project as it is now, not as the worker
  // leaves it: the later stages run while the work is under way.
  const snapshot =
    opts.snapshot ?? drafterSnapshot(opts.task, opts.cwd, { commands: opts.commands, scripts: opts.scripts, lessons: opts.lessons });
  // A subprocess drafter starts in an empty folder of its own, not the work.
  const ownDir = opts.askCwd === undefined ? mkdtempSync(join(tmpdir(), "maat-draft-")) : undefined;
  try {
    const r = await critiqued(
      { ...opts, snapshot, askCwd: opts.askCwd ?? ownDir, onProgress: opts.onProgress && ((d) => opts.onProgress!(withReqs(d))) },
      sink,
    );
    return r.ok ? { ...r, draft: withReqs(r.draft), ...(sink.lint.length ? { lint: sink.lint } : {}) } : r;
  } finally {
    if (ownDir) rmSync(ownDir, { recursive: true, force: true });
  }
}

/** A drafted check the seal-time lint retired (src/checklint.ts), for the journal. */
export type LintDrop = { name: string; run: string; rule: string; why: string; redraft: boolean };
type Sink = { requirements: string[]; lint: LintDrop[] };

async function critiqued(
  opts: Parameters<typeof draftCriteria>[0] & {
    /** Called with the best draft so far — the reviewed checks once there are any. */
    onProgress?: (d: Draft) => void;
    /** Bound on the step that adds checks for uncovered requirements (COVER_MAX_MS). */
    coverMaxMs?: number;
  },
  sink: Sink,
): Promise<{ ok: true; draft: Draft; critique: string[] } | { ok: false; error: string }> {
  const snap = opts.snapshot ?? drafterSnapshot(opts.task, opts.cwd, { commands: opts.commands, scripts: opts.scripts, lessons: opts.lessons });
  opts = { ...opts, snapshot: snap };
  const commands = snap.commands;
  const fix = (d: Draft): Draft =>
    commands ? { ...d, checks: d.checks.map((c) => ({ ...c, run: fixInterpreters(c.run, commands) })) } : d;
  const view = snap.view;
  // The project as it was before the model changed anything (the snapshot).
  const lintCtx: LintCtx = {
    task: opts.task,
    shell: bashPath() ? "bash" : "sh",
    ...(opts.cwd ? { cwd: opts.cwd, tree: snap.tree ?? readTree(opts.cwd) } : {}),
  };
  const said: string[] = [];
  /** Split a draft's checks into the ones that pass the lint and the ones that do not. Drops are recorded, never silent. */
  const lintSplit = (checks: DraftedCheck[], redraft: boolean): { ok: DraftedCheck[]; bad: LintDrop[] } => {
    const ok: DraftedCheck[] = [];
    const bad: LintDrop[] = [];
    for (const c of checks) {
      // Off unless MAAT_CHECK_LINT=1: in the v13 paired run the lint left fewer, shallower
      // checks sealed (the redraft lands after the seal), which cost passes and let wrong work through.
      // Except L15: a check that changes the work it judges is never sealed (checkwrites.ts).
      const writes = checkMutates(c.run);
      const hit = process.env.MAAT_CHECK_LINT === "1" ? lintAll(c.run, lintCtx)[0] : writes ? { rule: "L15-mutates", why: writes } : undefined;
      if (!hit) ok.push(c);
      else bad.push({ name: c.name, run: c.run, rule: hit.rule, why: hit.why, redraft });
    }
    return { ok, bad };
  };
  const drop = (bad: LintDrop[], where: string) => {
    for (const b of bad) {
      sink.lint.push(b);
      said.push(`dropped ${b.name} (${b.run}) ${where}: ${b.why} [${b.rule}]`);
    }
  };
  const drafted1 = await draftCriteria(opts);
  let first = drafted1.ok ? { ...drafted1, draft: fix(drafted1.draft) } : drafted1;
  if (first.ok && first.draft.checks.length) {
    const l1 = lintSplit(first.draft.checks, false);
    if (l1.bad.length) {
      // Sent back once with the reasons. What passes the lint is already ready
      // to seal while that second ask runs.
      first = { ...first, draft: { ...first.draft, checks: l1.ok } };
      if (l1.ok.length) opts.onProgress?.(first.draft);
      const findings = l1.bad.map((b) => `"${b.name}" was dropped: ${b.why}.`).join(" ");
      const again = await draftCriteria({
        ...opts,
        task: `${opts.task}\n\n(Review of an earlier draft of the checks: ${findings} Draft replacement checks that avoid this. Checks run under bash.)`,
      });
      const have = new Set(l1.ok.map((c) => c.name));
      const ran = new Set(l1.ok.map((c) => c.run));
      const l2 = again.ok ? lintSplit(fix(again.draft).checks, true) : { ok: [] as DraftedCheck[], bad: [] as LintDrop[] };
      drop(l1.bad, "before sealing");
      drop(l2.bad, "from the redraft");
      const added = l2.ok.filter((c) => !have.has(c.name) && !ran.has(c.run)).slice(0, Math.max(0, CRITERIA_MAX_CHECKS - l1.ok.length));
      if (added.length) said.push(`redrafted for the dropped checks: ${added.map((c) => c.name).join(", ")}`);
      first = { ...first, draft: { ...first.draft, checks: [...l1.ok, ...added], notes: first.draft.notes.length ? first.draft.notes : again.ok ? again.draft.notes : [] } };
    }
  }
  if (!first.ok || !first.draft.checks.length) return first.ok ? { ...first, critique: said } : first;
  const lintCover = (checks: DraftedCheck[]): DraftedCheck[] => {
    const l = lintSplit(checks, false);
    drop(l.bad, "from the cover draft");
    return l.ok;
  };
  const critic = async (d: Draft) => {
    const asked = await askModel({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      system: CRITIC_SYSTEM,
      prompt: `TASK TEXT:\n${opts.task}\n\n${view ? `${view}\n\n` : ""}CHECKS:\n${d.checks.map((c) => `- ${c.name}: ${c.run}`).join("\n")}`,
      cwd: opts.askCwd ?? opts.cwd,
      what: "reviewing the drafted checks",
      fetchFn: opts.fetchFn,
        acpSpawn: opts.acpSpawn,
        cliRun: opts.cliRun,
        timeoutMs: opts.timeoutMs,
        deadlineAt: opts.deadlineAt,
      reasoningEffort: opts.reasoningEffort,
      latency: opts.latency,
    });
    return asked.ok ? applyCritique(d, asked.text, opts.task) : null;
  };
  
  opts.onProgress?.(first.draft);
  const c1 = await critic(first.draft);
  if (!c1) return { ...first, critique: [...said, "the checks could not be reviewed; sealed as drafted"] };
  sink.requirements = c1.requirements;
  if (c1.kept.length) opts.onProgress?.({ ...first.draft, checks: c1.kept });
  const runOf = (name: string) => first.draft.checks.find((c) => c.name === name)?.run ?? "";
  for (const d of c1.dropped) said.push(`dropped ${d.name} (${runOf(d.name)}): it ${d.verdict === "invents" ? "demands what the task does not state" : "guesses an answer the task does not give"} — "${d.quote}"`);
  if (!c1.surfaceOnly && c1.kept.length) {
    if (!c1.uncovered.length) return { ok: true, draft: { ...first.draft, checks: c1.kept }, critique: said };
    // Sound checks, but a stated requirement nothing would catch. On
    // Terminal-Bench the false "verified" claims were mostly that: primers'
    // "at most 5" degrees apart, "equal to A1", "58 and 72" — stated in the
    // task, untested, failed by the grader. Draft checks for those only and
    // add the ones the critic keeps; the reviewed checks are never replaced.
    // Bounded: it adds two requests to a draft the first change waits for.
    const coverStep = async () => {
      const cover = await draftCriteria({
        ...opts,
        task:
          `${opts.task}\n\n(These checks are already sealed: ${c1.kept.map((c) => c.name).join(", ")}. ` +
          `Nothing tests these stated requirements yet: ${c1.uncovered.map((q) => `"${q}"`).join("; ")}. ` +
          `Draft checks for these requirements only.)`,
      });
      const extra = cover.ok ? lintCover(fix(cover.draft).checks) : [];
      return extra.length ? await critic({ checks: extra, notes: [] }) : null;
    };
    let coverTimer: NodeJS.Timeout | undefined;
    const c3 = await Promise.race([
      coverStep().catch(() => null),
      new Promise<null>((r) => {
        coverTimer = setTimeout(() => r(null), opts.coverMaxMs ?? COVER_MAX_MS);
      }),
    ]);
    clearTimeout(coverTimer);
    const taken = new Set(c1.kept.map((c) => c.name));
    const added = (c3 ? c3.kept : []).filter((c) => !taken.has(c.name)).slice(0, Math.max(0, CRITERIA_MAX_CHECKS - c1.kept.length));
    said.push(
      added.length
        ? `added ${added.map((c) => c.name).join(", ")} for what no check tested: ${c1.uncovered.map((q) => `"${q}"`).join("; ")}`
        : `no check could be added for ${c1.uncovered.map((q) => `"${q}"`).join("; ")}`,
    );
    return { ok: true, draft: { ...first.draft, checks: [...c1.kept, ...added] }, critique: said };
  }

  // Once more, told what was wrong. Its result is critiqued the same way.
  const findings = [
    ...c1.dropped.map((d) => `"${d.name}" was dropped: it ${d.verdict} ("${d.quote}").`),
    c1.surfaceOnly || !c1.kept.length ? "No check runs the deliverable on an input and tests what it produces. Add one." : "",
  ].filter(Boolean).join(" ");
  const drafted2 = await draftCriteria({ ...opts, task: `${opts.task}\n\n(Review of an earlier draft of the checks: ${findings})` });
  let second = drafted2.ok ? { ...drafted2, draft: fix(drafted2.draft) } : drafted2;
  if (second.ok) {
    const l = lintSplit(second.draft.checks, false);
    drop(l.bad, "from the redraft");
    second = { ...second, draft: { ...second.draft, checks: l.ok } };
  }
  if (second.ok && second.draft.checks.length) {
    const c2 = await critic(second.draft);
    const kept = c2 ? c2.kept : second.draft.checks;
    if (kept.length && !(c2?.surfaceOnly && !c1.surfaceOnly)) {
      for (const d of c2?.dropped ?? []) said.push(`dropped ${d.name} from the redraft — "${d.quote}"`);
      said.push(c2 && !c2.surfaceOnly ? "redrafted: a check now runs the deliverable" : "redrafted");
      return { ok: true, draft: { checks: kept, notes: second.draft.notes }, critique: said };
    }
  }
  said.push(c1.surfaceOnly ? "no check runs the deliverable; the redraft did not fix that" : "");
  return { ok: true, draft: { ...first.draft, checks: c1.kept.length ? c1.kept : first.draft.checks }, critique: said.filter(Boolean) };
}


const PROBED = ["python3", "python", "pip3", "pip", "pytest", "node", "npm", "npx", "go", "cargo", "rustc", "gcc", "g++", "make", "java", "ruby", "sqlite3", "jq", "git", "curl"];

/** Which of the usual commands exist here, by `command -v`. */
export function commandsHere(cwd?: string): { present: string[]; missing: string[] } {
  const present: string[] = [];
  const missing: string[] = [];
  for (const c of PROBED) {
    try {
      execFileSync("sh", ["-c", `command -v ${c}`], { cwd, stdio: "ignore", timeout: 2_000 });
      present.push(c);
    } catch {
      missing.push(c);
    }
  }
  return { present, missing };
}

/**
 * `python`/`pip` in a drafted check, on a machine that only has `python3`/`pip3`.
 *
 * macOS ships no `python`. A check that called it was dropped as unrunnable
 * before the work began — size-parse-bug ran with no checks at all over
 * `python -m doctest sizes.py`. The command meant is not in doubt.
 */
export function fixInterpreters(run: string, here: { present: string[] }): string {
  let out = run;
  if (!here.present.includes("python") && here.present.includes("python3")) out = out.replace(/(^|[\s;&|(`$"'])python(?![\w.-])/g, "$1python3");
  if (!here.present.includes("pip") && here.present.includes("pip3")) out = out.replace(/(^|[\s;&|(`$"'])pip(?![\w.-])/g, "$1pip3");
  return out;
}
