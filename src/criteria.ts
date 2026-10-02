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
import type { Sdk } from "./claude-code.js";
import { execFileSync } from "node:child_process";
import { askModel } from "./ask.js";
import { runCommand } from "./run.js";
import { diagnoseFailure } from "./bar.js";

/**
 * `surface`: the critic read it as only looking (a file exists, a word
 * appears, it compiles) rather than running the deliverable. Kept, but such a
 * check alone cannot carry a "verified" once the ones that ran it are retired.
 */
export type DraftedCheck = { name: string; run: string; surface?: true };
export type Draft = { checks: DraftedCheck[]; notes: string[] };

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
  const o = raw as { checks?: unknown; notes?: unknown };
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
  return { checks, notes };
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
} {
  const drafted = sanitizeCriteria(raw);
  return {
    taskChecks: drafted.checks.map((c) => ({
      name: c.name,
      kind: "command" as const,
      run: c.run,
      timeoutMs: 120_000,
      expectExit: 0,
      tags: c.surface ? ["task", "surface"] : ["task"],
      ...(opts.hidden ? { hidden: true } : {}),
    })),
    taskNotes: drafted.notes,
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
    [/\b(illegal|invalid|unrecognized) option\b/i, "a tool rejected the check's options"],
    [/illegal time specification|out of range or illegal time/i, "a tool rejected the check's date format"],
    [/syntax error near unexpected token|unexpected EOF while looking for/i, "the check's shell syntax is broken"],
  ];
  for (const [re, why] of tool) if (re.test(output)) return why;
  if (/Traceback \(most recent call last\)/.test(output)) {
    const frames = [...output.matchAll(/File "([^"]+)", line \d+/g)].map((m) => m[1]);
    const inline = frames.length > 0 && (frames.at(-1) === "<string>" || frames.at(-1) === "<stdin>");
    if (inline && /^(NameError|SyntaxError|IndentationError|UnboundLocalError)\b/m.test(output)) return "the check's own program has a bug";
    if (/got an unexpected keyword argument|no such group|invalid group reference/.test(output)) return "the check's own program misuses a library call";
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
  },
): Promise<BrokenCriterion[]> {
  const broken: BrokenCriterion[] = [];
  for (const c of checks) {
    if (c.kind && c.kind !== "command") continue;
    if (!c.run) continue;
    try {
      const r = await runCommand(c.run, {
        cwd: opts.cwd,
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
        broken.push({ name: c.name, run: c.run, why: `the shell could not parse it: ${firstLine(r.stderr)}` });
      } else if (selfError) broken.push({ name: c.name, run: c.run, why: selfError }); else if (!r.timedOut && r.code === (c.expectExit ?? 0)) opts.passed?.push(c.name);
    } catch {
      // Failing to spawn it here is molt's problem, not the criterion's.
      // Reporting it as broken would block work for the wrong reason.
    }
  }
  return broken;
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
  "Checks must leave nothing behind: build and write into $(mktemp -d), never into",
  "a directory the task names.",
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

export async function draftCriteria(opts: {
  task: string;
  scripts: string[];
  barChecks: string[];
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Where the draft is asked for. Only the Claude Code transport reads it. */
  cwd?: string;
  fetchFn?: typeof fetch;
  claudeCodeSdk?: Sdk;
  /** How an ACP agent is spawned. Tests only; see `EngineConfig.acpSpawn`. */
  acpSpawn?: typeof import("node:child_process").spawn;
  /** How `agy` is run for a pre-turn question. Tests only. */
  agyRun?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
  /** How long the HTTP question may wait for its answer; see askTimeoutMs. Tests only. */
  timeoutMs?: number;
  /** Pause before re-asking after empty replies (EMPTY_DRAFT_DELAY_MS). Tests only. */
  emptyRetryDelayMs?: number;
  reasoningEffort?: string;
  /** What is installed, so a check never calls a command that is not (see commandsHere). */
  commands?: { present: string[]; missing: string[] };
  /**
   * Drafted checks a person ruled wrong in this project (Judgments.lessons):
   * the mistakes not to seal again.
   */
  lessons?: string[];
}): Promise<{ ok: true; draft: Draft } | { ok: false; error: string }> {
  const context = [
    `Task: ${opts.task}`,
    "",
    `Scripts available: ${opts.scripts.length ? opts.scripts.join(", ") : "(none found)"}`,
    `The project already checks: ${opts.barChecks.length ? opts.barChecks.join(", ") : "(nothing)"}`,
    ...(opts.commands ? [`Commands on this machine: ${opts.commands.present.join(", ")}${opts.commands.missing.length ? ` (not installed: ${opts.commands.missing.join(", ")})` : ""}`] : []),
    ...(process.platform === "darwin"
      ? ["This is macOS: BSD tools, not GNU. No `find -printf`, no `stat -c`, no GNU `touch -d`, `sed -i ''` needs the empty argument. Prefer python3 for anything beyond plain shell."]
      : []),
    "`.maat/` is Maat's own folder in the project: a check that lists or counts files must ignore it.",
    ...(opts.lessons?.length
      ? ["", "A person ruled these earlier drafted checks wrong in this project. Do not make the same mistake:", ...opts.lessons.map((l) => `- ${l}`)]
      : []),
    "",
    "Do not repeat what the project already checks. Add only what is specific to",
    "this task.",
  ].join("\n");

  const asked = await askModel({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    system: SYSTEM,
    prompt: context,
    cwd: opts.cwd,
    what: "drafting criteria",
    fetchFn: opts.fetchFn,
    claudeCodeSdk: opts.claudeCodeSdk,
    acpSpawn: opts.acpSpawn,
    agyRun: opts.agyRun,
    timeoutMs: opts.timeoutMs,
    reasoningEffort: opts.reasoningEffort,
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
    prompt: `${context}\n\nYour last reply could not be parsed as JSON. Reply with the JSON object only.`,
    cwd: opts.cwd,
    what: "drafting criteria",
    fetchFn: opts.fetchFn,
    claudeCodeSdk: opts.claudeCodeSdk,
    acpSpawn: opts.acpSpawn,
    agyRun: opts.agyRun,
    timeoutMs: opts.timeoutMs,
    reasoningEffort: opts.reasoningEffort,
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
      cwd: opts.cwd,
      what: "drafting criteria",
      fetchFn: opts.fetchFn,
      claudeCodeSdk: opts.claudeCodeSdk,
      acpSpawn: opts.acpSpawn,
      agyRun: opts.agyRun,
      timeoutMs: opts.timeoutMs,
      reasoningEffort: opts.reasoningEffort,
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
  "Reply with JSON only:",
  '{"checks":[{"name":"...","verdict":"invents|guesses|surface|runs","quote":"verbatim task words, or empty"}]}',
].join("\n");

export type Critique = {
  kept: DraftedCheck[];
  dropped: { name: string; verdict: "invents" | "guesses"; quote: string }[];
  /** No kept check runs the deliverable. */
  surfaceOnly: boolean;
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
  return { kept, dropped, surfaceOnly: runs === 0 && kept.length > 0 };
}

/**
 * Draft, critique, and — when nothing runs the deliverable or checks were
 * dropped — draft once more with the findings. Returns the draft to seal and
 * what the critic did, for the receipt.
 */
export async function draftCriteriaCritiqued(
  opts: Parameters<typeof draftCriteria>[0],
): Promise<{ ok: true; draft: Draft; critique: string[] } | { ok: false; error: string }> {
  const fix = (d: Draft): Draft =>
    opts.commands ? { ...d, checks: d.checks.map((c) => ({ ...c, run: fixInterpreters(c.run, opts.commands!) })) } : d;
  const drafted1 = await draftCriteria(opts);
  const first = drafted1.ok ? { ...drafted1, draft: fix(drafted1.draft) } : drafted1;
  if (!first.ok || !first.draft.checks.length) return first.ok ? { ...first, critique: [] } : first;
  const critic = async (d: Draft) => {
    const asked = await askModel({
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      model: opts.model,
      system: CRITIC_SYSTEM,
      prompt: `TASK TEXT:\n${opts.task}\n\nCHECKS:\n${d.checks.map((c) => `- ${c.name}: ${c.run}`).join("\n")}`,
      cwd: opts.cwd,
      what: "reviewing the drafted checks",
      fetchFn: opts.fetchFn,
      claudeCodeSdk: opts.claudeCodeSdk,
      acpSpawn: opts.acpSpawn,
      agyRun: opts.agyRun,
      timeoutMs: opts.timeoutMs,
      reasoningEffort: opts.reasoningEffort,
    });
    return asked.ok ? applyCritique(d, asked.text, opts.task) : null;
  };
  const said: string[] = [];
  const c1 = await critic(first.draft);
  if (!c1) return { ...first, critique: ["the checks could not be reviewed; sealed as drafted"] };
  const runOf = (name: string) => first.draft.checks.find((c) => c.name === name)?.run ?? "";
  for (const d of c1.dropped) said.push(`dropped ${d.name} (${runOf(d.name)}): it ${d.verdict === "invents" ? "demands what the task does not state" : "guesses an answer the task does not give"} — "${d.quote}"`);
  if (!c1.surfaceOnly && c1.kept.length) return { ok: true, draft: { ...first.draft, checks: c1.kept }, critique: said };

  // Once more, told what was wrong. Its result is critiqued the same way.
  const findings = [
    ...c1.dropped.map((d) => `"${d.name}" was dropped: it ${d.verdict} ("${d.quote}").`),
    c1.surfaceOnly || !c1.kept.length ? "No check runs the deliverable on an input and tests what it produces. Add one." : "",
  ].filter(Boolean).join(" ");
  const drafted2 = await draftCriteria({ ...opts, task: `${opts.task}\n\n(Review of an earlier draft of the checks: ${findings})` });
  const second = drafted2.ok ? { ...drafted2, draft: fix(drafted2.draft) } : drafted2;
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
