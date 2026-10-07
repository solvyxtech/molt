/**
 * Missions: work that runs for hours against a contract nobody can edit.
 *
 * A mission is a goal decomposed into features, each of which claims some
 * assertions from a contract. The contract is executable — every assertion
 * that counts is a command with an exit code — and it is sealed before any
 * work starts. A worker session is started per feature, held to exactly the
 * assertions that feature claims, and its receipt is the record. When every
 * feature in a milestone is done, every assertion in that milestone is run
 * again, together, and the milestone seals only if all of them still pass.
 *
 * What is deliberately NOT here: an orchestrator model. A competitor's missions
 * put a frontier model in a loop with seventeen tools to decide what runs
 * next and whether a worker's handoff was good; it is the most expensive
 * process in the system and it is doing a job a loop can do. Here the
 * orchestrator is this file. It reads a queue, starts a worker, reads a
 * verdict the bar produced, and moves on. It never judges work — the
 * assertions do — and it never asks a model whether a milestone is done. The
 * model does only what a model is good at: proposing the plan (once, for a
 * person to read) and doing the work.
 *
 * The rule this inherits from the rest of molt, stated once: a model may
 * PROPOSE a contract and must never JUDGE against one. `molt mission plan`
 * writes the proposal to disk for a person to edit. `molt mission run` seals
 * what is on disk and refuses to continue if it moves.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, stringify as toYaml } from "yaml";
import { askModel, jsonIn, notJson, type AskOptions } from "./ask.js";
import type { Engine } from "./engine.js";
import { runCommand } from "./run.js";
import { diagnoseFailure } from "./bar.js";
import type { Check, Confirm, EngineEvent, JobOutcome, Spend } from "./types.js";
import { estTokens } from "./types.js";
import { stateDir, stateDirName } from "./statedir.js";

/** How the folder is named in messages; the real one is `missionRel(cwd)`. */
export const MISSION_DIR = ".maat/mission";
export const CONTRACT_FILE = "contract.yml";
export const FEATURES_FILE = "features.json";
export const STATE_FILE = "state.json";
export const MISSION_FILE = "mission.md";
export const LIBRARY_DIR = "library";
export const HANDOFF_DIR = "handoffs";

export const DEFAULT_ASSERTION_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_ATTEMPTS = 3;
/** How much of the library a worker is shown. Beyond this, it is told where the rest is. */
export const LIBRARY_TOKENS = 1_500;

export class MissionError extends Error {}

/** One thing that must be true when the mission is done. */
export type Assertion = {
  id: string;
  title: string;
  /** The command whose exit 0 establishes it. Absent for a note. */
  run?: string;
  timeoutMs?: number;
  /** Stated intent a command cannot decide. Recorded, never passed. */
  note?: string;
};

export type Contract = { version: 1; assertions: Assertion[] };

export type FeatureStatus = "pending" | "done" | "blocked" | "cancelled";

export type Feature = {
  id: string;
  title: string;
  description: string;
  milestone: string;
  /** Feature ids that must be done first. */
  after: string[];
  /** Assertion ids this feature establishes. Each id belongs to exactly one feature. */
  fulfills: string[];
  status: FeatureStatus;
  attempts: number;
  /** Receipt paths, one per attempt that produced one. */
  receipts: string[];
  /** Why it is blocked, or what a milestone seal found. */
  note?: string;
};

export type Features = { version: 1; features: Feature[] };

export type AssertionState = {
  status: "untested" | "passed" | "failed";
  at?: string;
  /** The feature whose turn established or lost it. */
  feature?: string;
};

export type MilestoneState = {
  sealed: boolean;
  at?: string;
  /** Every assertion in the milestone at the last seal attempt. */
  results?: { id: string; ok: boolean }[];
};

export type MissionState = {
  version: 1;
  /** sha256 of contract.yml when the mission started. Null until it has. */
  contractSha: string | null;
  startedAt?: string;
  assertions: Record<string, AssertionState>;
  milestones: Record<string, MilestoneState>;
  log: string[];
};

// ---------------------------------------------------------------------------
// Files

export function missionDir(cwd: string): string {
  return stateDir(cwd, "mission");
}

/** The mission folder relative to the project, as this project names it. */
export function missionRel(cwd: string): string {
  return `${stateDirName(cwd)}/mission`;
}

export function hasMission(cwd: string): boolean {
  return existsSync(join(missionDir(cwd), CONTRACT_FILE)) && existsSync(join(missionDir(cwd), FEATURES_FILE));
}

function isId(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z][\w-]{0,63}$/.test(s);
}

export function parseContract(source: string): Contract {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (e) {
    throw new MissionError(`${CONTRACT_FILE} is not valid YAML: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new MissionError(`${CONTRACT_FILE} must be a mapping with version and assertions`);
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new MissionError(`${CONTRACT_FILE}: version must be 1`);
  if (!Array.isArray(o.assertions) || o.assertions.length === 0) {
    throw new MissionError(`${CONTRACT_FILE}: assertions must be a non-empty list`);
  }
  const seen = new Set<string>();
  const assertions: Assertion[] = o.assertions.map((a, i) => {
    if (!a || typeof a !== "object") throw new MissionError(`${CONTRACT_FILE}: assertion ${i + 1} is not a mapping`);
    const x = a as Record<string, unknown>;
    if (!isId(x.id)) throw new MissionError(`${CONTRACT_FILE}: assertion ${i + 1} needs an id like VAL-API-001`);
    if (seen.has(x.id)) throw new MissionError(`${CONTRACT_FILE}: assertion id ${x.id} appears twice`);
    seen.add(x.id);
    const title = typeof x.title === "string" && x.title.trim() ? x.title.trim() : x.id;
    const run = typeof x.run === "string" && x.run.trim() ? x.run.trim() : undefined;
    const note = typeof x.note === "string" && x.note.trim() ? x.note.trim() : undefined;
    if (!run && !note) throw new MissionError(`${CONTRACT_FILE}: ${x.id} needs a run command or a note`);
    if (run && note) throw new MissionError(`${CONTRACT_FILE}: ${x.id} is either a run or a note, not both`);
    const timeoutMs =
      typeof x.timeout === "number" && x.timeout > 0 ? Math.round(x.timeout * 1000) : undefined;
    return { id: x.id, title, ...(run ? { run } : {}), ...(note ? { note } : {}), ...(timeoutMs ? { timeoutMs } : {}) };
  });
  return { version: 1, assertions };
}

const STATUSES: FeatureStatus[] = ["pending", "done", "blocked", "cancelled"];

export function parseFeatures(source: string): Features {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (e) {
    throw new MissionError(`${FEATURES_FILE} is not valid JSON: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object") throw new MissionError(`${FEATURES_FILE} must be an object with version and features`);
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) throw new MissionError(`${FEATURES_FILE}: version must be 1`);
  if (!Array.isArray(o.features) || o.features.length === 0) {
    throw new MissionError(`${FEATURES_FILE}: features must be a non-empty list`);
  }
  const seen = new Set<string>();
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0).map((s) => s.trim()) : [];
  const features: Feature[] = o.features.map((f, i) => {
    if (!f || typeof f !== "object") throw new MissionError(`${FEATURES_FILE}: feature ${i + 1} is not an object`);
    const x = f as Record<string, unknown>;
    if (!isId(x.id)) throw new MissionError(`${FEATURES_FILE}: feature ${i + 1} needs an id like F1`);
    if (seen.has(x.id)) throw new MissionError(`${FEATURES_FILE}: feature id ${x.id} appears twice`);
    seen.add(x.id);
    const status = STATUSES.includes(x.status as FeatureStatus) ? (x.status as FeatureStatus) : "pending";
    return {
      id: x.id,
      title: typeof x.title === "string" && x.title.trim() ? x.title.trim() : x.id,
      description: typeof x.description === "string" ? x.description.trim() : "",
      milestone: typeof x.milestone === "string" && x.milestone.trim() ? x.milestone.trim() : "main",
      after: strings(x.after),
      fulfills: strings(x.fulfills),
      status,
      attempts: typeof x.attempts === "number" && x.attempts >= 0 ? Math.floor(x.attempts) : 0,
      receipts: strings(x.receipts),
      ...(typeof x.note === "string" && x.note.trim() ? { note: x.note.trim() } : {}),
    };
  });
  return { version: 1, features };
}

export function emptyState(): MissionState {
  return { version: 1, contractSha: null, assertions: {}, milestones: {}, log: [] };
}

export function readState(cwd: string): MissionState {
  const p = join(missionDir(cwd), STATE_FILE);
  if (!existsSync(p)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<MissionState>;
    return {
      version: 1,
      contractSha: typeof raw.contractSha === "string" ? raw.contractSha : null,
      ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
      assertions: raw.assertions && typeof raw.assertions === "object" ? raw.assertions : {},
      milestones: raw.milestones && typeof raw.milestones === "object" ? raw.milestones : {},
      log: Array.isArray(raw.log) ? raw.log.filter((l): l is string => typeof l === "string") : [],
    };
  } catch {
    return emptyState();
  }
}

export function contractSha(cwd: string): string | null {
  const p = join(missionDir(cwd), CONTRACT_FILE);
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

export function loadMission(cwd: string): { contract: Contract; features: Features; state: MissionState; goal: string } {
  const dir = missionDir(cwd);
  if (!hasMission(cwd)) {
    throw new MissionError(`no mission in ${MISSION_DIR} — write ${CONTRACT_FILE} and ${FEATURES_FILE}, or run: Maat mission plan "<goal>"`);
  }
  const contract = parseContract(readFileSync(join(dir, CONTRACT_FILE), "utf8"));
  const features = parseFeatures(readFileSync(join(dir, FEATURES_FILE), "utf8"));
  const goalPath = join(dir, MISSION_FILE);
  const goal = existsSync(goalPath) ? readFileSync(goalPath, "utf8").trim() : "";
  return { contract, features, state: readState(cwd), goal };
}

export function writeFeatures(cwd: string, features: Features): void {
  mkdirSync(missionDir(cwd), { recursive: true });
  writeFileSync(join(missionDir(cwd), FEATURES_FILE), JSON.stringify(features, null, 2) + "\n");
}

export function writeState(cwd: string, state: MissionState): void {
  mkdirSync(missionDir(cwd), { recursive: true });
  writeFileSync(join(missionDir(cwd), STATE_FILE), JSON.stringify(state, null, 2) + "\n");
}

export function renderContract(contract: Contract): string {
  return (
    "# What this mission must make true. Sealed when `maat mission run` starts;\n" +
    "# a change after that stops the run. Every `run` is a command whose exit 0\n" +
    "# establishes the assertion. A `note` is intent a command cannot decide: it\n" +
    "# is recorded on every receipt and never reported as passed.\n" +
    toYaml({
      version: 1,
      assertions: contract.assertions.map((a) => ({
        id: a.id,
        title: a.title,
        ...(a.run ? { run: a.run } : {}),
        ...(a.timeoutMs ? { timeout: Math.round(a.timeoutMs / 1000) } : {}),
        ...(a.note ? { note: a.note } : {}),
      })),
    })
  );
}

// ---------------------------------------------------------------------------
// The coverage gate

/**
 * Every assertion is claimed by exactly one feature, every feature claims at
 * least one assertion that can run, and the `after` graph is a DAG over
 * known ids. Returned as sentences, because the person fixing the plan reads
 * them; an empty list means the mission may start.
 */
export function coverageGate(contract: Contract, features: Features): string[] {
  const problems: string[] = [];
  const byId = new Map(contract.assertions.map((a) => [a.id, a]));
  const claimed = new Map<string, string[]>();
  const featureIds = new Set(features.features.map((f) => f.id));

  for (const f of features.features) {
    if (f.status === "cancelled") continue;
    let runnable = 0;
    for (const id of f.fulfills) {
      const a = byId.get(id);
      if (!a) {
        problems.push(`feature ${f.id} fulfills ${id}, which is not in the contract`);
        continue;
      }
      if (a.run) runnable += 1;
      claimed.set(id, [...(claimed.get(id) ?? []), f.id]);
    }
    if (runnable === 0) {
      problems.push(`feature ${f.id} fulfills no runnable assertion — nothing could ever verify it`);
    }
    for (const dep of f.after) {
      if (!featureIds.has(dep)) problems.push(`feature ${f.id} comes after ${dep}, which does not exist`);
    }
  }
  for (const a of contract.assertions) {
    const owners = claimed.get(a.id) ?? [];
    if (owners.length === 0 && a.run) problems.push(`assertion ${a.id} is claimed by no feature`);
    if (owners.length > 1) problems.push(`assertion ${a.id} is claimed by ${owners.join(" and ")} — exactly one feature must own it`);
  }
  // Cycle check over `after`.
  const state = new Map<string, 0 | 1 | 2>();
  const edges = new Map(features.features.map((f) => [f.id, f.after.filter((d) => featureIds.has(d))]));
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 2) return;
    if (s === 1) {
      problems.push(`features depend on each other in a cycle: ${[...path, id].join(" → ")}`);
      return;
    }
    state.set(id, 1);
    for (const d of edges.get(id) ?? []) visit(d, [...path, id]);
    state.set(id, 2);
  };
  for (const f of features.features) visit(f.id, []);
  return [...new Set(problems)];
}

/** The next feature that can run: first pending, in order, with every `after` done. */
export function nextFeature(features: Features): Feature | null {
  const done = new Set(features.features.filter((f) => f.status === "done" || f.status === "cancelled").map((f) => f.id));
  return features.features.find((f) => f.status === "pending" && f.after.every((d) => done.has(d))) ?? null;
}

/** The checks a worker is held to: this feature's runnable assertions, as sealed task criteria. */
export function assertionChecks(contract: Contract, ids: readonly string[]): Check[] {
  const byId = new Map(contract.assertions.map((a) => [a.id, a]));
  const out: Check[] = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a?.run) continue;
    out.push({
      name: a.id,
      kind: "command",
      run: a.run,
      timeoutMs: a.timeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
      expectExit: 0,
      tags: ["mission"],
      // The worker is told what must be true, not how it will be checked.
      hidden: true,
    });
  }
  return out;
}

export function assertionNotes(contract: Contract, ids: readonly string[]): string[] {
  const byId = new Map(contract.assertions.map((a) => [a.id, a]));
  return ids.map((id) => byId.get(id)).filter((a): a is Assertion => Boolean(a?.note)).map((a) => `${a.id}: ${a.note}`);
}

// ---------------------------------------------------------------------------
// The library

/** Every `.md` under the library, as the worker is shown it, within a budget. */
export function readLibrary(cwd: string, budgetTokens = LIBRARY_TOKENS): string {
  const dir = join(missionDir(cwd), LIBRARY_DIR);
  if (!existsSync(dir)) return "";
  const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  const parts: string[] = [];
  let used = 0;
  let left = 0;
  for (const f of files) {
    const text = readFileSync(join(dir, f), "utf8").trim();
    if (!text) continue;
    const block = `--- ${MISSION_DIR}/${LIBRARY_DIR}/${f} ---\n${text}`;
    const t = estTokens(block);
    if (used + t > budgetTokens) {
      left += 1;
      continue;
    }
    parts.push(block);
    used += t;
  }
  if (left) parts.push(`(${left} more library file(s) not shown — read them from ${MISSION_DIR}/${LIBRARY_DIR}/)`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// The worker's brief

export function workerPrompt(input: {
  goal: string;
  feature: Feature;
  contract: Contract;
  features: Features;
  library: string;
  attempt: number;
  maxAttempts: number;
}): string {
  const { feature, contract } = input;
  const byId = new Map(contract.assertions.map((a) => [a.id, a]));
  const done = input.features.features.filter((f) => f.status === "done").map((f) => `${f.id} ${f.title}`);
  const lines: string[] = [];
  // The first line is what a receipt and a `--commit` subject show, so it is
  // the feature, not the framing.
  lines.push(`${feature.id} ${feature.title}`);
  lines.push("", `You are one worker in a mission. Do this feature and nothing else.`);
  if (input.goal) lines.push("", `Mission: ${input.goal}`);
  lines.push("", `Feature ${feature.id} (milestone ${feature.milestone}): ${feature.title}`);
  if (feature.description) lines.push("", feature.description);
  lines.push(
    "",
    "Done means every one of these is true — each is checked by a command when you say you are",
    "finished. The commands are not shown: a check you can see is a check you can copy, and",
    "the point is the work, not the check.",
  );
  for (const id of feature.fulfills) {
    const a = byId.get(id);
    if (!a) continue;
    lines.push(a.run ? `- ${a.id}: ${a.title}` : `- ${a.id} (note, not checked): ${a.note}`);
  }
  if (feature.note) lines.push("", `Last time: ${feature.note}`);
  if (input.attempt > 1) lines.push("", `This is attempt ${input.attempt} of ${input.maxAttempts}.`);
  if (done.length) lines.push("", `Already done by earlier workers: ${done.join("; ")}.`);
  lines.push(
    "",
    `The contract (${MISSION_DIR}/${CONTRACT_FILE}) and the feature list are read-only.`,
    `If you learn something the next worker needs — a command that has to run first, a port, a`,
    `trap — write it to a file under ${MISSION_DIR}/${LIBRARY_DIR}/ so it is not learned twice.`,
    "Do not start work outside this feature; if it is blocked by something outside it, say so and stop.",
  );
  if (input.library) lines.push("", "What earlier workers wrote down:", "", input.library);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Running assertions directly (milestone seals)

export type AssertionResult = { id: string; ok: boolean; output: string; didNotRun: boolean; ms: number };

export async function runAssertions(
  contract: Contract,
  ids: readonly string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<AssertionResult[]> {
  const byId = new Map(contract.assertions.map((a) => [a.id, a]));
  const out: AssertionResult[] = [];
  for (const id of ids) {
    const a = byId.get(id);
    if (!a?.run) continue;
    const t0 = Date.now();
    try {
      const r = await runCommand(a.run, {
        cwd,
        timeoutMs: a.timeoutMs ?? DEFAULT_ASSERTION_TIMEOUT_MS,
        maxBuffer: 256 * 1024,
        signal,
      });
      const d = diagnoseFailure(r.code ?? 0, r.stdout, r.stderr);
      out.push({
        id,
        ok: !r.timedOut && r.code === 0,
        output: (r.timedOut ? "timed out\n" : "") + `${r.stdout}${r.stderr}`.slice(-4000),
        didNotRun: d.didNotRun,
        ms: Date.now() - t0,
      });
    } catch (e) {
      out.push({ id, ok: false, output: String(e), didNotRun: true, ms: Date.now() - t0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The runner

export type Handoff = {
  feature: string;
  attempt: number;
  outcome: JobOutcome;
  claim: string;
  /** Checks the bar reported failing on the last attempt, by name. */
  failed: string[];
  receipt?: string;
  spend?: Spend;
  durationMs: number;
  at: string;
};

export type MissionEvents = {
  featureStart?: (f: Feature, attempt: number) => void;
  featureEnd?: (f: Feature, h: Handoff) => void;
  milestone?: (name: string, ok: boolean, results: AssertionResult[]) => void;
  log?: (text: string) => void;
  /** Every engine event from the worker, for a surface that wants to show them. */
  worker?: (f: Feature, ev: EngineEvent) => void;
};

export type MissionRunOptions = {
  cwd: string;
  /** A fresh engine per feature. Same cwd; the caller picks the model and policies. */
  makeWorker: (feature: Feature) => Engine | Promise<Engine>;
  confirm?: Confirm;
  maxAttempts?: number;
  /** Stop after this many worker runs. For tests and for `--features n`. */
  maxRuns?: number;
  events?: MissionEvents;
  signal?: AbortSignal;
};

export type MissionSummary = {
  runs: number;
  done: string[];
  blocked: string[];
  pending: string[];
  sealed: string[];
  unsealed: string[];
  /** Why the run ended. */
  stopped: "complete" | "nothing runnable" | "max runs" | "cancelled" | "contract moved";
};

const now = () => new Date().toISOString();

function milestoneFeatures(features: Features, name: string): Feature[] {
  return features.features.filter((f) => f.milestone === name && f.status !== "cancelled");
}

/**
 * Run the mission until nothing runnable remains.
 *
 * Every state change is written to disk before the next worker starts, so a
 * killed run resumes where it was: the queue is the file.
 */
export async function runMission(opts: MissionRunOptions): Promise<MissionSummary> {
  const { cwd } = opts;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const confirm: Confirm = opts.confirm ?? (async () => true);
  const ev = opts.events ?? {};
  const log = (text: string) => {
    state.log.push(`${now()} ${text}`);
    ev.log?.(text);
  };

  const { contract, features, state, goal } = loadMission(cwd);
  // A moved contract is refused before anything else is looked at: what the
  // new one says is beside the point, because work was already judged
  // against the old one.
  const sha = contractSha(cwd);
  if (state.contractSha !== null && state.contractSha !== sha) {
    throw new MissionError(
      `${MISSION_DIR}/${CONTRACT_FILE} has changed since the mission started. A contract that moves ` +
        `cannot judge the work done against it. Put it back, or start a new mission (remove ${STATE_FILE}).`,
    );
  }
  const problems = coverageGate(contract, features);
  if (problems.length) {
    throw new MissionError(`the mission cannot start:\n- ${problems.join("\n- ")}`);
  }
  if (state.contractSha === null) {
    state.contractSha = sha;
    state.startedAt = now();
    for (const a of contract.assertions) state.assertions[a.id] ??= { status: "untested" };
    log(`mission started · ${features.features.length} feature(s) · ${contract.assertions.length} assertion(s)`);
    writeState(cwd, state);
  }

  const summary = (stopped: MissionSummary["stopped"], runs: number): MissionSummary => {
    const names = [...new Set(features.features.map((f) => f.milestone))];
    return {
      runs,
      done: features.features.filter((f) => f.status === "done").map((f) => f.id),
      blocked: features.features.filter((f) => f.status === "blocked").map((f) => f.id),
      pending: features.features.filter((f) => f.status === "pending").map((f) => f.id),
      sealed: names.filter((n) => state.milestones[n]?.sealed),
      unsealed: names.filter((n) => !state.milestones[n]?.sealed),
      stopped,
    };
  };

  let runs = 0;
  for (;;) {
    if (opts.signal?.aborted) return summary("cancelled", runs);
    if (contractSha(cwd) !== state.contractSha) {
      log("contract moved mid-run — stopping");
      writeState(cwd, state);
      return summary("contract moved", runs);
    }
    const feature = nextFeature(features);
    if (!feature) {
      const all = features.features.every((f) => f.status === "done" || f.status === "cancelled");
      writeState(cwd, state);
      return summary(all ? "complete" : "nothing runnable", runs);
    }
    if (opts.maxRuns !== undefined && runs >= opts.maxRuns) {
      writeState(cwd, state);
      return summary("max runs", runs);
    }

    runs += 1;
    const attempt = feature.attempts + 1;
    ev.featureStart?.(feature, attempt);
    log(`${feature.id} attempt ${attempt}: ${feature.title}`);

    const engine = await opts.makeWorker(feature);
    engine.addReadOnly([
      `${MISSION_DIR}/${CONTRACT_FILE}`,
      `${MISSION_DIR}/${FEATURES_FILE}`,
      `${MISSION_DIR}/${STATE_FILE}`,
    ]);
    const prompt = workerPrompt({
      goal,
      feature,
      contract,
      features,
      library: readLibrary(cwd),
      attempt,
      maxAttempts,
    });
    const taskChecks = assertionChecks(contract, feature.fulfills);
    const taskNotes = assertionNotes(contract, feature.fulfills);

    let outcome: JobOutcome = "stopped";
    let claim = "";
    let failed: string[] = [];
    let receipt: string | undefined;
    let spend: Spend | undefined;
    let durationMs = 0;
    const t0 = Date.now();
    try {
      for await (const e of engine.run(prompt, confirm, { taskChecks, taskNotes })) {
        ev.worker?.(feature, e);
        switch (e.kind) {
          case "assistant_text":
            claim = e.text;
            break;
          case "receipt":
            receipt = e.path;
            break;
          case "proof_result":
          case "proof_refused":
          case "proof_exhausted":
            // The engine namespaces task criteria as `task:<id>`; the
            // contract knows them by id.
            failed = e.result.results
              .filter((c) => !c.ok && !c.advisory)
              .map((c) => c.name.replace(/^task:/, ""));
            break;
          case "job_end":
            outcome = e.outcome;
            spend = e.spend;
            durationMs = e.durationMs;
            break;
          default:
            break;
        }
      }
    } catch (err) {
      outcome = "error";
      claim = String(err);
    }
    if (!durationMs) durationMs = Date.now() - t0;

    const handoff: Handoff = {
      feature: feature.id,
      attempt,
      outcome,
      claim,
      failed,
      ...(receipt ? { receipt } : {}),
      ...(spend ? { spend } : {}),
      durationMs,
      at: now(),
    };
    writeHandoff(cwd, handoff);
    feature.attempts = attempt;
    if (receipt) feature.receipts.push(receipt);

    if (outcome === "verified") {
      feature.status = "done";
      delete feature.note;
      for (const id of feature.fulfills) {
        if (contract.assertions.find((a) => a.id === id)?.run) {
          state.assertions[id] = { status: "passed", at: now(), feature: feature.id };
        }
      }
      log(`${feature.id} done${receipt ? ` · ${receipt}` : ""}`);
    } else {
      for (const id of failed) {
        if (state.assertions[id]) state.assertions[id] = { status: "failed", at: now(), feature: feature.id };
      }
      const why = failed.length ? `failed ${failed.join(", ")}` : outcome;
      if (attempt >= maxAttempts) {
        feature.status = "blocked";
        feature.note = `blocked after ${attempt} attempt(s): ${why}`;
        log(`${feature.id} blocked: ${why}`);
      } else {
        feature.note = `attempt ${attempt} ${why}`;
        log(`${feature.id} not done (${why}); will retry`);
      }
    }
    ev.featureEnd?.(feature, handoff);
    writeFeatures(cwd, features);
    writeState(cwd, state);

    // Milestone seal: every feature in it done → run every assertion in it.
    const inMilestone = milestoneFeatures(features, feature.milestone);
    if (inMilestone.length && inMilestone.every((f) => f.status === "done") && !state.milestones[feature.milestone]?.sealed) {
      const ids = inMilestone.flatMap((f) => f.fulfills);
      const results = await runAssertions(contract, ids, cwd, opts.signal);
      const ok = results.every((r) => r.ok);
      state.milestones[feature.milestone] = {
        sealed: ok,
        at: now(),
        results: results.map((r) => ({ id: r.id, ok: r.ok })),
      };
      ev.milestone?.(feature.milestone, ok, results);
      if (ok) {
        log(`milestone ${feature.milestone} sealed · ${results.length} assertion(s) pass together`);
      } else {
        // A feature whose assertion no longer holds is reopened, not
        // patched by a model that decides what went wrong: the queue does
        // the same thing it did the first time, with the failure named.
        const lost = results.filter((r) => !r.ok);
        const reopened = new Set<string>();
        for (const r of lost) {
          const owner = inMilestone.find((f) => f.fulfills.includes(r.id));
          if (!owner) continue;
          state.assertions[r.id] = { status: "failed", at: now(), feature: owner.id };
          if (owner.status === "done") {
            owner.status = owner.attempts >= maxAttempts ? "blocked" : "pending";
            owner.note = `regressed at milestone ${feature.milestone} seal: ${r.id} failed — ${r.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`;
            reopened.add(owner.id);
          }
        }
        log(`milestone ${feature.milestone} not sealed: ${lost.map((r) => r.id).join(", ")} failed together — reopened ${reopened.size} feature(s)`);
        writeFeatures(cwd, features);
      }
      writeState(cwd, state);
    }
  }
}

export function writeHandoff(cwd: string, h: Handoff): string {
  const dir = join(missionDir(cwd), HANDOFF_DIR);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${h.feature}-${h.attempt}.json`);
  writeFileSync(p, JSON.stringify(h, null, 2) + "\n");
  return `${missionRel(cwd)}/${HANDOFF_DIR}/${h.feature}-${h.attempt}.json`;
}

// ---------------------------------------------------------------------------
// Status

export function missionStatus(cwd: string): string {
  if (!hasMission(cwd)) return `no mission in ${MISSION_DIR} — Maat mission plan "<goal>" drafts one`;
  let loaded: ReturnType<typeof loadMission>;
  try {
    loaded = loadMission(cwd);
  } catch (e) {
    return `mission unreadable: ${(e as Error).message}`;
  }
  const { contract, features, state, goal } = loaded;
  const problems = coverageGate(contract, features);
  const lines: string[] = [];
  if (goal) lines.push(goal.split("\n")[0]);
  const counts = { done: 0, pending: 0, blocked: 0, cancelled: 0 } as Record<FeatureStatus, number>;
  for (const f of features.features) counts[f.status] += 1;
  lines.push(
    `${features.features.length} feature(s): ${counts.done} done · ${counts.pending} pending · ${counts.blocked} blocked` +
      (counts.cancelled ? ` · ${counts.cancelled} cancelled` : ""),
  );
  const names = [...new Set(features.features.map((f) => f.milestone))];
  for (const n of names) {
    const fs = milestoneFeatures(features, n);
    const m = state.milestones[n];
    const mark = m?.sealed ? "sealed" : fs.every((f) => f.status === "done") ? "done, not sealed" : `${fs.filter((f) => f.status === "done").length}/${fs.length}`;
    lines.push(`  ${n}: ${mark}`);
    for (const f of fs) {
      const tag = f.status === "done" ? "[x]" : f.status === "blocked" ? "[!]" : f.status === "cancelled" ? "[-]" : "[ ]";
      lines.push(`    ${tag} ${f.id} ${f.title}${f.status === "pending" && f.attempts ? ` (attempt ${f.attempts})` : ""}${f.note ? ` — ${f.note}` : ""}`);
    }
  }
  const runnable = contract.assertions.filter((a) => a.run).length;
  const passed = Object.values(state.assertions).filter((a) => a.status === "passed").length;
  lines.push(`${contract.assertions.length} assertion(s), ${runnable} runnable, ${passed} passed`);
  lines.push(state.contractSha ? `contract sealed ${state.contractSha.slice(0, 12)}${contractSha(cwd) === state.contractSha ? "" : " — MOVED since"}` : "contract not yet sealed");
  if (problems.length) lines.push(`cannot run until fixed:`, ...problems.map((p) => `  - ${p}`));
  const next = nextFeature(features);
  if (next && !problems.length) lines.push(`next: ${next.id} ${next.title}`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Planning

const PLAN_SYSTEM = [
  "You plan a software mission: work an agent will do unattended for hours, in",
  "small features, each proven by commands. You are not doing the work and you",
  "will never judge it — a person reads what you write and edits it, then the",
  "commands are what decides.",
  "",
  "Return JSON only, matching:",
  '  {"mission":"one paragraph",',
  '   "assertions":[{"id":"VAL-AREA-001","title":"short","run":"shell command"} | {"id":"...","title":"...","note":"intent no command can check"}],',
  '   "features":[{"id":"F1","title":"short","description":"what to build and how it is used","milestone":"M1","after":["F0"],"fulfills":["VAL-AREA-001"]}]}',
  "",
  "Rules:",
  "- Every assertion with `run` must be a command that exits 0 exactly when the",
  "  thing is true, using only tools present in the environment described",
  "  below. Prefer the project's own scripts; otherwise test -f, grep -q, curl,",
  "  an interpreter one-liner, a small test file the feature will add.",
  "- Every assertion is claimed by exactly one feature. Every feature claims at",
  "  least one assertion with `run`. Notes are for intent a command cannot",
  "  decide and are never reported as passed.",
  "- Features are ordered: the first pending one runs next. Use `after` only",
  "  for a real dependency. Group features into milestones that are vertical",
  "  slices a person could look at.",
  "- A feature is one session's work: under an hour for a careful engineer.",
  "  Split anything larger. Ten features is typical; forty is too many.",
  "- Say what each feature must produce, at which path, and how it is used.",
  "  Vague descriptions produce vague work.",
].join("\n");

export type MissionPlan = {
  mission: string;
  contract: Contract;
  features: Features;
};

export function parsePlan(text: string, cutOff = false): { ok: true; plan: MissionPlan } | { ok: false; error: string } {
  const o = jsonIn(text);
  if (!o) return { ok: false, error: notJson(text, cutOff, "plan") };
  const mission = typeof o.mission === "string" ? o.mission.trim() : "";
  let contract: Contract;
  let features: Features;
  try {
    contract = parseContract(toYaml({ version: 1, assertions: Array.isArray(o.assertions) ? o.assertions : [] }));
    features = parseFeatures(JSON.stringify({ version: 1, features: Array.isArray(o.features) ? o.features : [] }));
  } catch (e) {
    return { ok: false, error: `the plan was JSON but not a mission: ${(e as Error).message}` };
  }
  return { ok: true, plan: { mission, contract, features } };
}

/**
 * Ask the model for a plan. Returns the plan and the coverage gate's
 * findings; a plan with problems is still returned, because a person is
 * going to edit it anyway and the findings tell them where.
 */
export async function draftMission(opts: {
  goal: string;
  /** The environment brief and repo map, if the caller has them. */
  context?: string;
  scripts?: string[];
  ask: Omit<AskOptions, "system" | "prompt" | "maxTokens" | "what">;
}): Promise<{ ok: true; plan: MissionPlan; problems: string[] } | { ok: false; error: string }> {
  const prompt = [
    `Goal: ${opts.goal}`,
    "",
    `Scripts available: ${opts.scripts?.length ? opts.scripts.join(", ") : "(none found)"}`,
    ...(opts.context ? ["", opts.context] : []),
  ].join("\n");
  const asked = await askModel({ ...opts.ask, system: PLAN_SYSTEM, prompt, maxTokens: 6000, what: "planning the mission" });
  if (!asked.ok) return asked;
  const parsed = parsePlan(asked.text, asked.cutOff);
  if (!parsed.ok) return parsed;
  return { ok: true, plan: parsed.plan, problems: coverageGate(parsed.plan.contract, parsed.plan.features) };
}

/** Write a plan to disk. Refuses to overwrite an existing mission unless told to. */
export function writePlan(cwd: string, plan: MissionPlan, opts: { force?: boolean } = {}): string[] {
  const dir = missionDir(cwd);
  if (hasMission(cwd) && !opts.force) {
    throw new MissionError(`a mission already exists in ${MISSION_DIR}; pass --force to replace it`);
  }
  mkdirSync(join(dir, LIBRARY_DIR), { recursive: true });
  const written: string[] = [];
  const put = (name: string, text: string) => {
    writeFileSync(join(dir, name), text);
    written.push(`${missionRel(cwd)}/${name}`);
  };
  put(MISSION_FILE, `${plan.mission}\n`);
  put(CONTRACT_FILE, renderContract(plan.contract));
  put(FEATURES_FILE, JSON.stringify(plan.features, null, 2) + "\n");
  const statePath = join(dir, STATE_FILE);
  if (existsSync(statePath) && opts.force) {
    writeFileSync(statePath, JSON.stringify(emptyState(), null, 2) + "\n");
    written.push(`${missionRel(cwd)}/${STATE_FILE} (reset)`);
  }
  return written;
}
