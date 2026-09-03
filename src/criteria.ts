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
import { authHeaders } from "./providers.js";
import { runCommand } from "./run.js";
import { diagnoseFailure } from "./bar.js";

export type DraftedCheck = { name: string; run: string };
export type Draft = { checks: DraftedCheck[]; notes: string[] };

/** Same bounds the drafter uses — applied again at `session:run`. */
export const CRITERIA_MAX_CHECKS = 4;
export const CRITERIA_MAX_NOTES = 3;
export const CRITERIA_MAX_NAME = 40;
export const CRITERIA_MAX_RUN = 300;
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
            (c as DraftedCheck).run.trim().length > 0,
        )
        .slice(0, CRITERIA_MAX_CHECKS)
        .map((c) => ({
          name: c.name.trim().slice(0, CRITERIA_MAX_NAME),
          run: c.run.trim().slice(0, CRITERIA_MAX_RUN),
        }))
        .filter((c) => c.run.length > 0)
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
export function taskChecksFrom(raw: unknown): {
  taskChecks: {
    name: string;
    kind: "command";
    run: string;
    timeoutMs: number;
    expectExit: number;
    tags: string[];
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
      tags: ["task"],
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

export async function preflightCriteria(
  checks: readonly { name: string; kind?: string; run?: string }[],
  opts: { cwd: string; timeoutMs?: number; signal?: AbortSignal },
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
      if (d.didNotRun) broken.push({ name: c.name, run: c.run, why: d.hint ?? "did not run" });
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
  "missing teaches people to ignore criteria.",
  "",
  "notes are for anything a command cannot decide — how something looks, reads, or",
  "feels. They are recorded on the receipt as stated intent and never reported as",
  "verified. Do not write a note that pretends to be a check.",
  "",
  "Two or three checks and at most two notes. Fewer is better. If the task needs",
  "no criterion beyond the project's own bar, return empty lists.",
].join("\n");

/** Strip a fenced block, which models add whatever the instructions say. */
function parseDraft(text: string): Draft {
  const body = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return { checks: [], notes: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { checks: [], notes: [] };
  }
  return sanitizeCriteria(raw);
}

export async function draftCriteria(opts: {
  task: string;
  scripts: string[];
  barChecks: string[];
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchFn?: typeof fetch;
}): Promise<{ ok: true; draft: Draft } | { ok: false; error: string }> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const context = [
    `Task: ${opts.task}`,
    "",
    `Scripts available: ${opts.scripts.length ? opts.scripts.join(", ") : "(none found)"}`,
    `The project already checks: ${opts.barChecks.length ? opts.barChecks.join(", ") : "(nothing)"}`,
    "",
    "Do not repeat what the project already checks. Add only what is specific to",
    "this task.",
  ].join("\n");

  try {
    const res = await f(`${base}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders(base, opts.apiKey) },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: context },
        ],
        // Small and cheap: this is one short structured answer, not a turn.
        max_tokens: 500,
        temperature: 0,
      }),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status} drafting criteria` };
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content ?? "";
    return { ok: true, draft: parseDraft(text) };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}
