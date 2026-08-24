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
import { authHeaders } from "../src/providers.js";

export type DraftedCheck = { name: string; run: string };
export type Draft = { checks: DraftedCheck[]; notes: string[] };

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
        .slice(0, 4)
        .map((c) => ({ name: c.name.trim().slice(0, 40), run: c.run.trim().slice(0, 300) }))
    : [];
  const notes: string[] = Array.isArray(o.notes)
    ? o.notes.filter((n): n is string => typeof n === "string" && n.trim().length > 0)
        .slice(0, 3)
        .map((n) => n.trim().slice(0, 200))
    : [];
  return { checks, notes };
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
