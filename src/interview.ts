/**
 * Interview: ask before work, then seal into the bar and criteria.
 *
 * Wrappers added "interview mode" because agents start coding on guesses.
 * molt already owns the gate; this is the missing precursor. The model asks
 * non-obvious questions, a person answers, and what comes back is editable
 * checks — never a spec the model later grades itself against.
 *
 * Separate from the work transcript. The model never writes `.molt/done.yml`;
 * Seal does, after parseBar accepts the YAML.
 */
import { stringify } from "yaml";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { authHeaders } from "./providers.js";
import { loadBar, parseBar, barPath } from "./bar.js";
import type { Bar, Check } from "./types.js";
import {
  CRITERIA_MAX_CHECKS,
  CRITERIA_MAX_NAME,
  CRITERIA_MAX_NOTES,
  CRITERIA_MAX_RUN,
  sanitizeCriteria,
  type Draft,
} from "./criteria.js";

export const INTERVIEW_MAX_ROUNDS = 4;
export const INTERVIEW_MAX_QUESTIONS = 8;

export type InterviewQuestion = {
  id: string;
  prompt: string;
  options: string[];
  allowOther: boolean;
};

export type InterviewAnswer = { id: string; choice: string };

export type BarAdd = { name: string; run: string };

export type InterviewProposal = {
  barAdds: BarAdd[];
  checks: Draft["checks"];
  notes: string[];
};

export type InterviewTurn =
  | { kind: "ask"; questions: InterviewQuestion[]; round: number }
  | { kind: "propose"; proposal: InterviewProposal }
  | { kind: "error"; error: string };

const SYSTEM = [
  "You interview a person about one coding task before any work starts.",
  "You are not doing the task. You will not write code. You will not judge the work.",
  "",
  "Return JSON only, one of:",
  '  {"questions":[{"id":"q1","prompt":"...","options":["a","b"],"allowOther":true}]}',
  '  {"proposal":{"bar":[{"name":"kebab-name","run":"shell command"}],"checks":[{"name":"kebab-name","run":"shell command"}],"notes":["sentence"]}}',
  "",
  "Questions must not be obvious. Prefer trade-offs, failure modes, and what",
  "\"done\" would look like as a command this project already has. Never invent a",
  "script that does not exist — a criterion that fails because the command is",
  "missing teaches people to ignore criteria.",
  "",
  "`bar` is additions to .molt/done.yml, the project's standing gate. Only propose",
  "bar additions when the project has no bar, or when a check belongs on every",
  "future task, not this one. `checks` and `notes` are for this task only.",
  "notes are recorded as stated intent and never reported as verified.",
  "",
  `At most ${INTERVIEW_MAX_QUESTIONS} questions per reply, 2–4 options each.`,
  "When you know enough to propose, propose. Do not keep asking.",
].join("\n");

/** Scripts this project already has, so interview does not invent commands. */
export function projectScripts(cwd: string): string[] {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

/** Strip a fenced block; models add them whatever the instructions say. */
function jsonObject(text: string): Record<string, unknown> | null {
  const body = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const raw: unknown = JSON.parse(body.slice(start, end + 1));
    return raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function sanitizeAnswers(raw: unknown): InterviewAnswer[] {
  if (!Array.isArray(raw)) return [];
  const out: InterviewAnswer[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as { id?: unknown; choice?: unknown };
    const id = asString(o.id);
    const choice = asString(o.choice);
    if (!id || !choice) continue;
    out.push({ id: id.slice(0, 40), choice: choice.slice(0, 400) });
    if (out.length >= INTERVIEW_MAX_QUESTIONS) break;
  }
  return out;
}

export function parseQuestions(raw: unknown): InterviewQuestion[] {
  if (!Array.isArray(raw)) return [];
  const out: InterviewQuestion[] = [];
  for (const [i, row] of raw.entries()) {
    if (!row || typeof row !== "object") continue;
    const o = row as { id?: unknown; prompt?: unknown; options?: unknown; allowOther?: unknown };
    const prompt = asString(o.prompt);
    if (!prompt) continue;
    const options = Array.isArray(o.options)
      ? o.options
          .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
          .map((x) => x.trim().slice(0, 80))
          .slice(0, 4)
      : [];
    if (options.length < 2) continue;
    out.push({
      id: asString(o.id).slice(0, 40) || `q${i + 1}`,
      prompt: prompt.slice(0, 280),
      options,
      allowOther: o.allowOther === true,
    });
    if (out.length >= INTERVIEW_MAX_QUESTIONS) break;
  }
  return out;
}

function parseBarAdds(raw: unknown): BarAdd[] {
  if (!Array.isArray(raw)) return [];
  const out: BarAdd[] = [];
  const seen = new Set<string>();
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const o = row as { name?: unknown; run?: unknown };
    const name = asString(o.name).slice(0, CRITERIA_MAX_NAME);
    const run = asString(o.run).slice(0, CRITERIA_MAX_RUN);
    if (!name || !run || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, run });
    if (out.length >= CRITERIA_MAX_CHECKS) break;
  }
  return out;
}

export function parseInterviewReply(text: string, round: number): InterviewTurn {
  const obj = jsonObject(text);
  if (!obj) return { kind: "error", error: "interview reply was not JSON" };
  const questions = parseQuestions(obj.questions);
  if (questions.length && round < INTERVIEW_MAX_ROUNDS) {
    return { kind: "ask", questions, round };
  }
  const proposalRaw =
    obj.proposal && typeof obj.proposal === "object" ? (obj.proposal as Record<string, unknown>) : obj;
  const drafted = sanitizeCriteria({
    checks: proposalRaw.checks,
    notes: proposalRaw.notes,
  });
  return {
    kind: "propose",
    proposal: {
      barAdds: parseBarAdds(proposalRaw.bar ?? proposalRaw.barAdds),
      checks: drafted.checks.slice(0, CRITERIA_MAX_CHECKS),
      notes: drafted.notes.slice(0, CRITERIA_MAX_NOTES),
    },
  };
}

function yamlFromBar(checks: Check[]): string {
  return stringify(
    {
      version: 1,
      checks: checks.map((c) => {
        if (c.kind === "command") {
          const row: Record<string, unknown> = { name: c.name, run: c.run };
          if (c.tags.length) row.tags = c.tags;
          if (c.advisory) row.advisory = true;
          if (c.watch?.length) row.watch = c.watch;
          if (c.expectExit !== 0) row.expect_exit = c.expectExit;
          return row;
        }
        const row: Record<string, unknown> = { name: c.name, builtin: c.builtin };
        if (c.tags.length) row.tags = c.tags;
        if (c.advisory) row.advisory = true;
        if (c.lcov) row.lcov = c.lcov;
        if (c.commentOnly) row["comment-only"] = c.commentOnly;
        if (c.builtin === "mutation" && c.run) row.run = c.run;
        return row;
      }),
    },
    { lineWidth: 0 },
  );
}

function asCommand(add: BarAdd): Check {
  return {
    name: add.name,
    kind: "command",
    run: add.run,
    timeoutMs: 120_000,
    expectExit: 0,
    tags: [],
  };
}

/**
 * Merge proposed command checks into the project's bar and write it.
 *
 * `parseBar` is the authority: if the result would not load, nothing is
 * written. Existing names keep their current definition so an interview
 * cannot silently weaken a committed check. Builtins stay as they are.
 */
export function applyBarAdds(
  cwd: string,
  adds: BarAdd[],
  current: Bar | null,
): { ok: true; bar: Bar } | { ok: false; error: string } {
  const cleaned = parseBarAdds(adds);
  if (!cleaned.length) return { ok: false, error: "nothing to add to the bar" };
  const existing = current ?? loadBar(cwd);
  const merged: Check[] = existing ? [...existing.checks] : [];
  const taken = new Set(merged.map((c) => c.name));
  let added = 0;
  for (const add of cleaned) {
    if (taken.has(add.name)) continue;
    merged.push(asCommand(add));
    taken.add(add.name);
    added += 1;
  }
  if (!added) return { ok: false, error: "those checks are already on the bar" };
  const yaml = yamlFromBar(merged);
  let bar: Bar;
  try {
    bar = parseBar(yaml);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const p = barPath(cwd);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, yaml, "utf8");
  return { ok: true, bar };
}

export async function interviewTurn(opts: {
  task: string;
  scripts: string[];
  barChecks: string[];
  history: { questions: InterviewQuestion[]; answers: InterviewAnswer[] }[];
  round: number;
  baseUrl: string;
  apiKey?: string;
  model: string;
  fetchFn?: typeof fetch;
}): Promise<InterviewTurn> {
  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  const prior = opts.history
    .map((h, i) => {
      const qs = h.questions.map((q) => `  ${q.id}: ${q.prompt}`).join("\n");
      const ans = h.answers.map((a) => `  ${a.id}: ${a.choice}`).join("\n");
      return `Round ${i + 1} questions:\n${qs}\nAnswers:\n${ans || "  (none)"}`;
    })
    .join("\n\n");
  const last = opts.round >= INTERVIEW_MAX_ROUNDS;
  const context = [
    `Task: ${opts.task.trim() || "(the project itself — no task typed yet)"}`,
    "",
    `Scripts available: ${opts.scripts.length ? opts.scripts.join(", ") : "(none found)"}`,
    `The project already checks: ${opts.barChecks.length ? opts.barChecks.join(", ") : "(nothing — you may propose a bar)"}`,
    "",
    prior || "No answers yet.",
    "",
    last
      ? "This is the last round. You must return a proposal, not more questions."
      : "Ask only if a real decision is still missing. Otherwise propose.",
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
        max_tokens: 800,
        temperature: 0,
      }),
    });
    if (!res.ok) return { kind: "error", error: `HTTP ${res.status} interviewing` };
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    const text = json.choices?.[0]?.message?.content ?? "";
    const parsed = parseInterviewReply(text, opts.round);
    if (parsed.kind === "ask" && last) {
      return { kind: "error", error: "interview kept asking after the last round" };
    }
    return parsed;
  } catch (e) {
    return { kind: "error", error: String(e) };
  }
}
