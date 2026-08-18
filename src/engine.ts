/**
 * molt's engine — a small agent loop that speaks the OpenAI-compatible
 * /chat/completions wire format, so one implementation covers OpenAI,
 * OpenRouter, Groq, Mistral, and — the point — local llama.cpp / Ollama /
 * vLLM servers. Any base URL, any key, any model.
 *
 * What makes it molt rather than one more harness is the proof gate. When
 * the model stops calling tools and produces a final answer, that answer
 * is treated as a CLAIM, not a result. molt runs the project's bar
 * (.molt/done.yml). If any check fails, the claim is refused, the exact
 * failures go back to the model, and the loop continues. The model does
 * not get to decide when it is finished.
 *
 * Design rules:
 *  - Three tools. Everything else is bash.
 *  - Every write is ledgered with before/after hashes, so a later check can
 *    prove the write landed and survived.
 *  - Shedding is two-phase: archive first, mutate second.
 *  - Nothing is summarized by a model, ever.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import type { ArchiveLike } from "./archive.js";
import { CheckCache, barFingerprint, formatBarFailure, runBar, type BarContext } from "./bar.js";
import {
  AUTONOMY_SUMMARY,
  DEFAULT_AUTONOMY,
  gate,
  insideProject,
  type Autonomy,
} from "./autonomy.js";
import { redact } from "./redact.js";
import {
  applyEdit,
  formatListing,
  formatMatches,
  grepFiles,
  walk,
} from "./files.js";
import { Journal } from "./journal.js";
import { authHeaders } from "./providers.js";
import { Receipts } from "./receipts.js";
import { readStream, type Usage } from "./stream.js";
import { Transcript, toolDetail } from "./transcript.js";
import {
  estTokens,
  type Bar,
  type CheckResult,
  type BarResult,
  type Bom,
  type Confirm,
  type EngineEvent,
  type LedgerEntry,
  type JobOutcome,
  type Msg,
  type Spend,
} from "./types.js";

/** A reading of the session meter, for measuring one job against. */
type Meter = {
  prompt: number;
  completion: number;
  cached: number;
  billed: number;
  unbilledSteps: number;
  estimatedSteps: number;
  costUsd?: number;
};

export const SYSTEM_PROMPT = [
  "You are molt, a coding agent working in the current directory.",
  "Read only what you need. Be terse.",
  "",
  "Tool results stay in this conversation. Never read a file twice unless you changed",
  "it — scroll up. If you want a file you already have, you are done gathering: answer,",
  "or say what is blocking you.",
  "",
  "This project defines what 'done' means in .molt/done.yml. When you finish,",
  "those checks run automatically. If any fail you will be told exactly which,",
  "with their output, and you must fix the underlying problem and continue.",
  "Do not edit .molt/done.yml to make checks pass. Do not claim work you have",
  "not done — it will be checked against the full session record.",
  "",
  "If you are unsure whether something worked, say so and check it rather than",
  "asserting it. An unverified claim costs the same as a false one.",
].join("\n");

/**
 * How much of a tool result comes back.
 *
 * Tool results are the bulk of a session's tokens, because every one of them
 * is resent on every subsequent request — which argues for a tight cap. It
 * argued too well: at 2048 bytes for everything, reading a 17KB README took
 * nine round trips, and each of those round trips resent the entire
 * conversation. The tight cap cost more tokens than the large read it was
 * avoiding, and produced a session that looked exactly like a model looping.
 *
 * So the cap is per kind of result, sized to how the result is used:
 *
 *  - A file is read to be understood, and paging through one in 2KB slices
 *    is the expensive way to spend a context window. 16KB is roughly 4k
 *    tokens, which holds most source files whole.
 *  - Command output is mostly noise with a signal at one end, and a failing
 *    suite's first 8KB says what failed.
 *
 * Truncation is always visible, never silent, and a truncated read always
 * says how to continue.
 */
/**
 * What one turn may spend before molt stops it, unless told otherwise.
 *
 * There was no ceiling, only a 32-step guard — and a session that thrashed
 * inside those 32 steps spent 661,000 tokens and most of a dollar over
 * thirteen minutes before anything intervened. Steps are the wrong unit:
 * a step can cost a hundred tokens or thirty thousand.
 *
 * Deliberately generous enough for real work and far below "how did this cost
 * a dollar". `/budget` raises or removes it, and the message says so.
 */
/**
 * What one turn may spend before molt stops it, unless told otherwise.
 *
 * Denominated in money, because tokens are the wrong unit for this and it took
 * a user pointing at the arithmetic to see it. A token ceiling scales with
 * context size, so the same limit buys forty steps on a small project and four
 * on a large one — it punishes depth rather than waste. And it ignores
 * caching: 228,000 cumulative prompt tokens with 75% cache hits costs about
 * $0.22, while the token count says $0.68. Charging a budget for tokens the
 * provider is discounting is charging for work nobody did.
 *
 * Waste is caught by the guards that can actually recognise it — repeats,
 * drifting re-reads, steps that learn nothing. This is only the backstop for
 * a turn that is genuinely, expensively going somewhere it should not.
 *
 * The token fallback applies when no price is known, and is deliberately
 * generous: without a price, molt cannot tell an expensive turn from a long one.
 */
export const DEFAULT_TURN_USD = 1.0;
export const DEFAULT_TURN_TOKENS = 500_000;

/** Fractions of the ceiling at which molt says something, once each. */
const CEILING_WARNINGS = [0.5, 0.8];

/**
 * When working history gets compacted, unless told otherwise.
 *
 * Shedding was built for exactly the situation that broke a real session —
 * reading a whole codebase, where the conversation grows until every step
 * resends a hundred kilobytes — and it was off by default, so it never ran.
 * A feature that only works when configured is a feature most sessions do
 * not have.
 *
 * Safe as a default because of where verification reads from: the bar checks
 * the ledger, the disk, and the archive, never the transcript. Shedding costs
 * the model some working memory and costs molt's proof nothing, the full
 * original is preserved in `.molt/exuviae/`, `record-intact` fails if it is
 * not, and `/regrow` pulls it back by pattern.
 */
export const DEFAULT_AUTO_SHED_TOKENS = 60_000;

export const TOOL_RESULT_MAX_BYTES = 8192;
export const READ_MAX_BYTES = 16_384;
export const MAX_STEPS = 32;
export const MAX_PROOF_ATTEMPTS = 4;
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a text file. A long file arrives in parts; the result gives the offset that " +
        "continues it. Same arguments return the same part.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "number", description: "First line, 0-based." },
          limit: { type: "number", description: "How many lines." },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create a file, or overwrite one whole. Use edit_file to change part of one.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List a directory, skipping build and dependency directories.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Default '.'." },
          depth: { type: "number", description: "Levels down. Default 1." },
          glob: { type: "string", description: "e.g. '**/*.ts'." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search file contents by regular expression. Returns path:line: text.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          path: { type: "string", description: "Default '.'." },
          glob: { type: "string", description: "e.g. '**/*.ts'." },
          ignore_case: { type: "boolean" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace exact text. Copy old_text verbatim from a read; refused if absent, or if " +
        "ambiguous without replace_all.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
          replace_all: { type: "boolean" },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command here. Use list_dir and grep instead of ls/grep/find.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  },
] as const;

const TOOL_SCHEMA_JSON = JSON.stringify(TOOLS);

const SECRET_ENV = [
  "MOLT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
];

/** Per-turn options. Nothing here changes the session's configuration. */
export type RunOptions = {
  /**
   * Treat the turn as a question. Checks that cannot be satisfied without a
   * file change are not run — a lookup or an explanation can never satisfy
   * one, and refusing an honest answer for failing to invent work punishes
   * exactly the behaviour molt is built to encourage.
   */
  ask?: boolean;
};

/**
 * The bar minus the checks that require a write to pass. Only
 * `files-changed` is inherently one: every other check reads state that a
 * read-only turn can still satisfy, so it stays.
 */
export function withoutWriteChecks(bar?: Bar | null): Bar | null {
  if (!bar) return null;
  return {
    ...bar,
    checks: bar.checks.filter((c) => !(c.kind === "builtin" && c.builtin === "files-changed")),
  };
}

export type EngineConfig = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  provider?: string;
  cwd?: string;
  priceInPerMtok?: number;
  priceOutPerMtok?: number;
  /**
   * USD per 1M cached prompt tokens. Every provider that caches bills those
   * tokens at a discount; charging them at the full rate is a wrong number,
   * not a conservative one. Undefined means "bill them as ordinary prompt
   * tokens", which is what molt did before it could tell them apart.
   */
  priceCachedInPerMtok?: number;
  /** Where the prices came from — an endpoint, or "set by hand". */
  priceSource?: string;
  bashTimeoutMs?: number;
  fetchFn?: typeof fetch;
  /** Stream tokens as they generate. On by default; a dead TUI reads as broken. */
  stream?: boolean;
  /** Project bar. When absent the proof gate is disabled and molt says so. */
  bar?: Bar | null;
  archive?: ArchiveLike;
  receipts?: Receipts;
  /** Append-only hash-chained record of everything this session did. */
  journal?: Journal;
  maxProofAttempts?: number;
  /**
   * Shed automatically once working history exceeds this many tokens.
   * Defaults to DEFAULT_AUTO_SHED_TOKENS; 0 disables it.
   */
  autoShedAtTokens?: number;
  /** Tokens one turn may spend when no price is known. 0 disables it. */
  maxTurnTokens?: number;
  /** USD one turn may spend when a price is known. 0 disables it. */
  maxTurnUsd?: number;
  /** Drop tool results that later work superseded. On by default. */
  elideSuperseded?: boolean;
  /** How much molt may do without asking. Defaults to asking about everything. */
  autonomy?: Autonomy;
};

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  return env;
}

function sha256Of(p: string): string | null {
  if (!existsSync(p)) return null;
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

/**
 * What a watcher is shown of a tool's arguments or its result.
 *
 * Everything the model got. Not a summary, not a head — the result was already
 * capped on its way to the model, and capping it again on its way to the
 * person watching means the two of you are looking at different things. That
 * is the one outcome a transparency view cannot have.
 *
 * The bound is the tool-result cap itself, so what you see is exactly what the
 * model saw, byte for byte.
 */
function capture(s: string): string {
  return s;
}

/**
 * Name the failing check when the ONLY thing standing between a turn and an
 * answer is a check that demands a write. Read-only work — a question, a
 * lookup, an explanation — can never satisfy one, so the refusal needs to
 * say that in the user's terms rather than read as molt malfunctioning.
 */
function failedOnlyWriteChecks(result: BarResult): string | null {
  const failed = result.results.filter((r) => !r.ok);
  if (failed.length === 0) return null;
  return failed.every((r) => r.detail === "files-changed") ? failed.map((r) => r.name).join(", ") : null;
}

/**
 * A stable identity for a tool call, so "the same question" is recognised
 * however the model happens to spell it.
 */
function callKey(name: string, args: Record<string, unknown>): string {
  const parts = Object.entries(args)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    // An explicit zero offset is the default, and says nothing new.
    .filter(([k, v]) => !((k === "offset" || k === "limit") && Number(v) === 0))
    .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
    .sort();
  return `${name}(${parts.join(",")})`;
}

/** Dollars, for a message that has to be readable without a formatter. */
function fmtUsd(usd: number): string {
  return usd >= 0.1 ? `$${usd.toFixed(2)}` : usd >= 0.001 ? `$${usd.toFixed(3)}` : "<$0.001";
}

/** A tool argument that should be a non-empty string, or nothing. */
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
}

/** A tool argument that should be a non-negative integer, or its default. */
function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/**
 * One part of a file, and how to get the next.
 *
 * The old read_file took a path and nothing else, and every result was cut to
 * TOOL_RESULT_MAX_BYTES. For a 17KB README that meant the first 2KB and no way
 * on earth to reach the rest — so a model that needed more had exactly one
 * move available: call read_file again, and receive the same 2KB. That is not
 * a model looping. That is a dead end with a retry button, and it cost a real
 * session thirty steps and fifty cents.
 *
 * Paging turns the dead end into a path: every truncated result says how many
 * lines are left and the offset that continues it.
 */
function readPart(abs: string, shown: string, offset: number, limit: number): string {
  const raw = readFileSync(abs, "utf8").split("\n");
  // A trailing newline is a terminator, not an empty last line. Counting it
  // reports 401 lines for a 400-line file, and every offset the model is told
  // to use is then one past what it means.
  const lines = raw.length > 1 && raw.at(-1) === "" ? raw.slice(0, -1) : raw;
  const from = Math.min(offset, lines.length);
  const until = Math.min(lines.length, from + limit);

  // The label and the continuation notice have to fit inside the same budget
  // as the content. Filling to the cap and appending them afterwards is how
  // the first version of this failed: truncateResult then cut the notice off
  // the end, so the model was handed a part of a file and no way to ask for
  // the rest — the dead end this function exists to remove, rebuilt one layer
  // up. The reserve uses the longest form either line can take.
  const label = `[molt: ${shown} lines ${from + 1}-${lines.length} of ${lines.length}]`;
  const notice = `[molt: ${lines.length} more line(s). Continue with read_file offset=${lines.length}.]`;
  const reserve = Buffer.byteLength(label + "\n" + notice + "\n", "utf8");
  const budget = Math.max(256, READ_MAX_BYTES - reserve);

  const out: string[] = [];
  let bytes = 0;
  let i = from;
  for (; i < until; i++) {
    const line = lines[i]!;
    const size = Buffer.byteLength(line, "utf8") + 1;
    // Always return at least one line, even an enormous one: a caller that
    // gets nothing back cannot tell "empty" from "too big to send".
    if (out.length > 0 && bytes + size > budget) break;
    out.push(line);
    bytes += size;
  }

  const whole = from === 0 && i >= lines.length;
  if (whole) return out.join("\n");

  // A part is labelled, because a model holding lines 40-80 of a file needs to
  // know that is what it is holding.
  const head = `[molt: ${shown} lines ${from + 1}-${i} of ${lines.length}]`;
  const tail =
    i < lines.length
      ? `\n[molt: ${lines.length - i} more line(s). Continue with read_file offset=${i}.]`
      : "";
  return `${head}\n${out.join("\n")}${tail}`;
}

function truncateResult(s: string): { text: string; note?: string } {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= TOOL_RESULT_MAX_BYTES) return { text: s };
  const cut = Buffer.from(s, "utf8").subarray(0, TOOL_RESULT_MAX_BYTES).toString("utf8");
  return {
    text: cut + `\n[molt: truncated ${bytes - TOOL_RESULT_MAX_BYTES} bytes]`,
    note: `capped at ${TOOL_RESULT_MAX_BYTES}B (was ${bytes}B)`,
  };
}

export class Engine {
  cfg: EngineConfig;
  private transcript: Transcript;
  private ledger: LedgerEntry[] = [];
  private sessionPrompt = 0;
  private sessionCompletion = 0;
  private sessionCached = 0;
  /** Sum of the dollar figures the provider itself reported, when it does. */
  private sessionBilled = 0;
  /** Steps whose dollar figure the provider did not report. */
  private unbilledSteps = 0;
  /** Steps whose token counts molt had to estimate. */
  private estimatedSteps = 0;
  /**
   * Set once a provider rejects `stream_options`. Some OpenAI-compatible
   * servers 400 on request fields they do not implement, and re-sending a
   * field that has already been refused burns a round trip per step.
   */
  private streamUsageUnsupported = false;
  /** Said once: this endpoint is not caching anything. */
  private warnedNoCache = false;
  /**
   * Every path the model read this session.
   *
   * Kept because reading a file is evidence it exists, and claims-grounded
   * needs that evidence: a correct assessment of source living outside the
   * project directory was refused as a fabrication, for naming files the model
   * had just read.
   */
  private readPaths = new Set<string>();
  /**
   * What the model did this turn, one line each, in order.
   *
   * The receipt is read by someone asking "what did it do, and should I
   * believe it finished?" — and until now the answer to the first half was
   * nowhere in the document.
   */
  private did: string[] = [];
  /**
   * Results reused while their watched files have not moved.
   *
   * One per session and never persisted: four proof attempts against a
   * ten-second suite is forty seconds of the inner loop spent re-proving the
   * same thing, and that is worth removing — but only within the process that
   * observed it.
   */
  private cache = new CheckCache();
  /** User turns handled this session. Numbers the jobs the meter reports. */
  private jobCount = 0;
  /**
   * Tool calls the model has been allowed to make since the bar last ran.
   *
   * The proof loop's premise is that the model can act on what failed. When
   * it has acted on nothing, the same bar is about to be run against the
   * same state — and molt was doing exactly that, four times, at the cost of
   * a full test suite each round.
   */
  private actsSinceBar = 0;
  budgetTokens?: number;
  /** Exact JSON body of the most recent request — the wire, unhidden. */
  lastRequestBody?: string;
  /** sha256 of .molt/done.yml as it stood when the session began. */
  private barHash: string | null;
  private inFlight?: AbortController;
  /**
   * How many write records this session handed to the archive. Kept in
   * memory and NOT derived from the archive, so it is an independent
   * expectation the archive can be checked against.
   */
  private archivedWrites = 0;

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
    this.transcript = new Transcript(SYSTEM_PROMPT);
    this.barHash = barFingerprint(this.cwd);
    // The key molt was handed is the one secret it can mask exactly.
    cfg.journal?.protect(cfg.apiKey, process.env.MOLT_API_KEY);
    cfg.receipts?.protect(cfg.apiKey, process.env.MOLT_API_KEY);
  }

  get model(): string {
    return this.cfg.model;
  }
  get baseUrl(): string {
    return this.cfg.baseUrl;
  }
  get provider(): string {
    return this.cfg.provider ?? new URL(this.cfg.baseUrl).hostname.split(".")[0];
  }
  get cwd(): string {
    return this.cfg.cwd ?? process.cwd();
  }
  get sessionTokens(): number {
    return this.sessionPrompt + this.sessionCompletion;
  }
  get shedBatches(): number {
    return this.transcript.shedCount;
  }
  get hasBar(): boolean {
    return Boolean(this.cfg.bar && this.cfg.bar.checks.length > 0);
  }
  get archive(): ArchiveLike | undefined {
    return this.cfg.archive;
  }
  get receipts(): Receipts | undefined {
    return this.cfg.receipts;
  }
  get journal(): Journal | undefined {
    return this.cfg.journal;
  }

  setModel(m: string): void {
    this.cfg.model = m;
  }
  setApiKey(k?: string): void {
    this.cfg.apiKey = k;
    this.cfg.journal?.protect(k);
  }
  /**
   * A session ceiling — and, since it is the knob people reach for when a turn
   * runs away, the turn ceiling too. A budget smaller than the default turn
   * ceiling would otherwise be unreachable, and a budget larger than it would
   * be silently overruled.
   */
  setBudget(tokens?: number): void {
    this.budgetTokens = tokens;
    this.cfg.maxTurnTokens = tokens === undefined ? 0 : tokens;
    // Clearing the budget clears the money ceiling too, or "/budget off"
    // would remove one limit and leave another one nobody mentioned.
    if (tokens === undefined) this.cfg.maxTurnUsd = 0;
  }

  /** A per-turn spending ceiling in dollars. 0 removes it. */
  setTurnBudgetUsd(usd: number): void {
    this.cfg.maxTurnUsd = usd;
  }
  setBar(bar: Bar | null): void {
    this.cfg.bar = bar;
    this.barHash = barFingerprint(this.cwd);
  }

  /**
   * Point at a different endpoint. Resets the session — different world.
   *
   * The model goes with it. A model name belongs to the endpoint that serves
   * it, so carrying `grok-4.6` across a login to Anthropic produced a status
   * line reading `anthropic · grok-4.6` — a combination that exists nowhere,
   * displayed as fact, on the row whose whole job is to answer "what am I
   * pointed at?". Better to say nothing and ask for a model.
   */
  setBaseUrl(url: string, apiKey?: string, provider?: string): void {
    if (url !== this.cfg.baseUrl) this.cfg.model = "";
    this.cfg.baseUrl = url;
    this.cfg.apiKey = apiKey;
    this.cfg.journal?.protect(apiKey);
    this.cfg.provider = provider;
    this.reset();
  }

  reset(): void {
    this.transcript = new Transcript(SYSTEM_PROMPT);
    this.ledger = [];
    this.archivedWrites = 0;
    this.sessionPrompt = 0;
    this.sessionCompletion = 0;
    this.sessionCached = 0;
    this.sessionBilled = 0;
    this.unbilledSteps = 0;
    this.estimatedSteps = 0;
    this.jobCount = 0;
  }

  /**
   * Abort an in-flight request. The assistant turn is only committed to the
   * transcript once a response is complete, so cancelling mid-stream leaves
   * the session exactly as it was rather than half-written.
   */
  cancel(): void {
    this.inFlight?.abort();
  }

  get streaming(): boolean {
    return this.cfg.stream !== false;
  }

  /** Values that must not appear on screen or in a file molt writes. */
  private secrets(): (string | undefined)[] {
    return [this.cfg.apiKey, process.env.MOLT_API_KEY, process.env.OPENAI_API_KEY];
  }

  get autonomy(): Autonomy {
    return this.cfg.autonomy ?? DEFAULT_AUTONOMY;
  }

  /**
   * Change how much molt may do without asking.
   *
   * Journalled, because it is the one setting that changes what molt is
   * allowed to do to a machine. A record of a session that does not say when
   * the ceiling moved cannot explain why a command ran unattended.
   */
  setAutonomy(level: Autonomy): void {
    const from = this.autonomy;
    this.cfg.autonomy = level;
    if (from !== level) {
      this.cfg.journal?.append("autonomy", { from, to: level, means: AUTONOMY_SUMMARY[level] });
    }
  }

  get sessionCachedTokens(): number {
    return this.sessionCached;
  }

  /** True when any step's tokens were counted by molt rather than the provider. */
  get costEstimated(): boolean {
    return this.estimatedSteps > 0;
  }

  /** True when every step's dollar figure came from the provider itself. */
  get costBilled(): boolean {
    return this.sessionBilled > 0 && this.unbilledSteps === 0;
  }

  /**
   * What this session has cost so far, in USD.
   *
   * Three sources, in descending order of how much molt actually knows:
   *
   *   1. The provider billed it. Used only when EVERY step reported a
   *      figure — a total that mixes billed steps with priced ones is
   *      neither, and would be wrong in the direction of too small.
   *   2. Configured prices against reported token counts.
   *   3. Configured prices against molt's own token estimate, which is why
   *      `costEstimated` exists and why the meter marks it.
   *
   * Cached prompt tokens are billed at the cache rate when one is known.
   * They are already inside `sessionPrompt`, so they are subtracted out
   * before the standard rate is applied rather than counted twice.
   */
  costUsd(): number | undefined {
    if (this.costBilled) return this.sessionBilled;
    const { priceInPerMtok: pin, priceOutPerMtok: pout, priceCachedInPerMtok: pcache } = this.cfg;
    if (pin === undefined || pout === undefined) return undefined;
    const cached = pcache === undefined ? 0 : Math.min(this.sessionCached, this.sessionPrompt);
    const fresh = this.sessionPrompt - cached;
    return (fresh / 1e6) * pin + (cached / 1e6) * (pcache ?? pin) + (this.sessionCompletion / 1e6) * pout;
  }

  /** The prices in force, and where they came from. Backs /price. */
  pricing(): { in?: number; out?: number; cached?: number; source?: string } {
    return {
      in: this.cfg.priceInPerMtok,
      out: this.cfg.priceOutPerMtok,
      cached: this.cfg.priceCachedInPerMtok,
      source: this.cfg.priceSource,
    };
  }

  setPricing(p: { in?: number; out?: number; cached?: number; source?: string }): void {
    this.cfg.priceInPerMtok = p.in;
    this.cfg.priceOutPerMtok = p.out;
    this.cfg.priceCachedInPerMtok = p.cached;
    this.cfg.priceSource = p.source;
  }

  /**
   * Keep the standing note of this turn current.
   *
   * The request, the files changed so far, and the last thing the bar said —
   * a few hundred tokens that survive every compaction, so a shed costs the
   * model its notes and not its purpose.
   */
  private pinTask(request: string, lastFailure?: string): void {
    const written = [...new Set(this.ledger.map((e) => e.path))];
    this.transcript.pin(
      [
        "[molt] What this turn is for. This note is never compacted away.",
        `Request: ${request.replace(/\s+/g, " ").slice(0, 400)}`,
        written.length ? `Files you have changed: ${written.join(", ")}` : "Files changed so far: none",
        lastFailure ? `The bar last refused this claim: ${lastFailure}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  /** Everything the meter is made of, at this instant. */
  private meter(): Meter {
    return {
      prompt: this.sessionPrompt,
      completion: this.sessionCompletion,
      cached: this.sessionCached,
      billed: this.sessionBilled,
      unbilledSteps: this.unbilledSteps,
      estimatedSteps: this.estimatedSteps,
      costUsd: this.costUsd(),
    };
  }

  /** What has been spent since a snapshot, and how much of it molt knows. */
  private spendSince(before: Meter): Spend {
    const billedHere = this.sessionBilled - before.billed;
    const wasBilled = this.unbilledSteps === before.unbilledSteps && billedHere > 0;
    const now = this.costUsd();
    return {
      promptTokens: this.sessionPrompt - before.prompt,
      completionTokens: this.sessionCompletion - before.completion,
      cachedTokens: this.sessionCached - before.cached,
      costUsd: wasBilled
        ? billedHere
        : now === undefined
          ? undefined
          : now - (before.costUsd ?? 0),
      estimated: this.estimatedSteps > before.estimatedSteps,
      billed: wasBilled,
    };
  }

  bom(): Bom {
    const b = this.transcript.bom(TOOL_SCHEMA_JSON, {
      prompt: this.sessionPrompt,
      completion: this.sessionCompletion,
    });
    return {
      ...b,
      sessionCachedTokens: this.sessionCached,
      costUsd: this.costUsd(),
      costEstimated: this.costEstimated,
      budgetTokens: this.budgetTokens,
    };
  }

  /**
   * Every write this project can still prove: what is live in memory, plus
   * what the archive preserved from shed context and from earlier sessions.
   * Deduplicated by path — the earliest `before` with the latest `after`, so
   * the pair describes the whole effect on that file.
   */
  mergedLedger(): LedgerEntry[] {
    const archived = this.cfg.archive?.ledger?.() ?? [];
    const byPath = new Map<string, LedgerEntry>();
    for (const e of [...archived, ...this.ledger]) {
      const prior = byPath.get(e.path);
      byPath.set(e.path, prior ? { ...e, before: prior.before } : { ...e });
    }
    return [...byPath.values()];
  }

  barContext(claim?: string): BarContext {
    return {
      cwd: this.cwd,
      record: this.transcript.record(),
      read: [...this.readPaths],
      cache: this.cache,
      ledger: this.mergedLedger(),
      liveLedger: [...this.ledger],
      archive: this.cfg.archive,
      archivedBatches: this.transcript.shedCount,
      expectedArchivedWrites: this.archivedWrites,
      expectedArchiveFiles: Journal.expectedArchives(this.cwd),
      claim,
    };
  }

  getLedger(): readonly LedgerEntry[] {
    return this.ledger;
  }

  getRecord(): Msg[] {
    return this.transcript.record();
  }

  /**
   * Shed context. Two-phase: the archive write happens between planning and
   * committing, so a throwing archive leaves the transcript untouched.
   */
  shed(keepExchanges = 2): { before: number; after: number; dropped: number; path: string } | null {
    const plan = this.transcript.planShed(keepExchanges);
    if (!plan) return null;

    // Writes performed during the messages being shed travel with them. After
    // this, the only record of that work is the archive — which is what makes
    // "verification runs against preserved history" true rather than merely
    // architectural.
    const cut = plan.droppedCount;
    const departingCalls = new Set(
      plan.dropped.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id)),
    );
    const departing = this.ledger.filter((e) => departingCalls.has(e.callId));
    const staying = this.ledger.filter((e) => !departingCalls.has(e.callId));

    if (!this.cfg.archive && departing.length > 0) {
      // Shedding without an archive would destroy write evidence. Refuse
      // rather than quietly lose the ability to prove earlier work.
      return null;
    }

    let path = "(not archived)";
    if (this.cfg.archive) {
      const firstAsk = plan.dropped.find((m) => m.role === "user")?.content ?? "";
      // If this throws, we never reach commitShed and nothing is lost.
      const entry = this.cfg.archive.write(plan.exuvia, cut, firstAsk, departing);
      path = entry.file;
      this.archivedWrites += departing.length;
    }

    this.transcript.commitShed(plan);

    this.ledger = staying;
    return {
      before: plan.beforeTokens,
      after: plan.afterTokens,
      dropped: plan.droppedCount,
      path,
    };
  }

  regrow(text: string): void {
    this.transcript.regrow(text);
  }

  /**
   * Pull archived context back into the working set by pattern. Lossless is
   * only meaningful if it is reversible on demand — this is the payoff for
   * having kept the original.
   */
  regrowMatching(pattern: string, limit = 3): { hits: number; attached: number; tokens: number } {
    if (!this.cfg.archive || typeof this.cfg.archive.grep !== "function") {
      return { hits: 0, attached: 0, tokens: 0 };
    }
    const hits = this.cfg.archive.grep(pattern);
    const take = hits.slice(0, limit);
    if (take.length === 0) return { hits: 0, attached: 0, tokens: 0 };
    const text = take.map((h) => `[exuvia ${h.index}]\n${h.excerpt}`).join("\n\n");
    this.transcript.regrow(text);
    return { hits: hits.length, attached: take.length, tokens: estTokens(text) };
  }

  /**
   * What a shed would do, without doing it. Backs `shed --explain`: the
   * preservation story only lands when someone can see the digest and the
   * original side by side.
   */
  explainShed(keepExchanges = 2): {
    droppedCount: number;
    beforeTokens: number;
    afterTokens: number;
    digest: string;
    exuvia: string;
  } | null {
    const plan = this.transcript.planShed(keepExchanges);
    if (!plan) return null;
    return {
      droppedCount: plan.droppedCount,
      beforeTokens: plan.beforeTokens,
      afterTokens: plan.afterTokens,
      digest: plan.digest,
      exuvia: plan.exuvia,
    };
  }

  private overBudget(): boolean {
    return this.budgetTokens !== undefined && this.sessionTokens >= this.budgetTokens;
  }

  private runTool(name: string, args: Record<string, unknown>, callId: string): string {
    switch (name) {
      case "read_file":
        this.readPaths.add(String(args.path ?? ""));
        return readPart(
          resolve(this.cwd, String(args.path ?? "")),
          String(args.path ?? ""),
          num(args.offset, 0),
          num(args.limit, Number.MAX_SAFE_INTEGER),
        );

      case "write_file": {
        const rel = String(args.path ?? "");
        const abs = resolve(this.cwd, rel);
        const before = sha256Of(abs);
        mkdirSync(dirname(abs), { recursive: true });
        const content = String(args.content ?? "");
        writeFileSync(abs, content, "utf8");
        const after = createHash("sha256").update(content, "utf8").digest("hex");
        this.ledger.push({
          path: isAbsolute(rel) ? relative(this.cwd, abs) : rel,
          before,
          after,
          callId,
        });
        return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${rel}`;
      }

      case "list_dir": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        this.mustBeInside(abs, rel);
        return formatListing(rel, walk(abs, { depth: num(args.depth, 1), glob: str(args.glob) }));
      }

      case "grep": {
        const rel = String(args.path ?? ".");
        const abs = resolve(this.cwd, rel);
        this.mustBeInside(abs, rel);
        const pattern = String(args.pattern ?? "");
        return formatMatches(
          pattern,
          grepFiles(abs, pattern, {
            glob: str(args.glob),
            ignoreCase: args.ignore_case === true,
          }),
        );
      }

      case "edit_file": {
        const rel = String(args.path ?? "");
        const abs = resolve(this.cwd, rel);
        this.mustBeInside(abs, rel);
        if (!existsSync(abs)) return `no such file: ${rel} — write_file creates a new one`;
        const before = sha256Of(abs);
        const current = readFileSync(abs, "utf8");
        const edit = applyEdit(
          current,
          String(args.old_text ?? ""),
          String(args.new_text ?? ""),
          args.replace_all === true,
        );
        if (!edit.ok) return `edit refused: ${edit.why}`;
        writeFileSync(abs, edit.text, "utf8");
        // Ledgered exactly like a write, so files-changed and record-intact
        // prove a surgical edit the same way they prove a whole-file rewrite.
        this.ledger.push({
          path: isAbsolute(rel) ? relative(this.cwd, abs) : rel,
          before,
          after: createHash("sha256").update(edit.text, "utf8").digest("hex"),
          callId,
        });
        const delta = Buffer.byteLength(edit.text, "utf8") - Buffer.byteLength(current, "utf8");
        return (
          `replaced ${edit.replacements} occurrence(s) in ${rel} · ` +
          `${delta >= 0 ? "+" : ""}${delta} bytes`
        );
      }

      case "bash":
        try {
          return execSync(String(args.command ?? ""), {
            cwd: this.cwd,
            timeout: this.cfg.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
            encoding: "utf8",
            env: scrubbedEnv(),
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch (e) {
          const err = e as {
            stdout?: string;
            stderr?: string;
            status?: number | null;
            signal?: string;
          };
          const tag = err.signal === "SIGTERM" ? "timeout" : `exit ${err.status ?? "?"}`;
          return `${tag}\n${err.stdout ?? ""}${err.stderr ?? ""}`;
        }

      default:
        return `unknown tool: ${name}`;
    }
  }

  /**
   * Run the bar, with tamper detection in front of it. A bar the agent
   * rewrote mid-task is not a bar, so the edit is reported as a failure
   * rather than quietly honoured.
   */
  /**
   * Refuse to act outside the project.
   *
   * The permission gate already asks about a path outside the project, but a
   * tool that resolves paths itself has to hold the line itself too: a gate
   * that only inspects `path` cannot see where a directory walk ends up.
   */
  private mustBeInside(abs: string, shown: string): void {
    if (!insideProject(this.cwd, abs)) {
      throw new Error(`${shown} is outside this project; molt will not walk there`);
    }
  }

  private runBarGuarded(claim?: string, override?: Bar | null): BarResult {
    const bar = override ?? this.cfg.bar!;
    const t0 = Date.now();
    const now = barFingerprint(this.cwd);
    if (this.barHash !== null && now !== this.barHash) {
      const tamper: CheckResult = {
        name: "bar-unmodified",
        kind: "builtin",
        detail: "done.yml fingerprint",
        ok: false,
        output:
          ".molt/done.yml changed during this session. The definition of done cannot be " +
          "edited by the work being judged against it. Revert the file and satisfy the " +
          "original checks, or stop and tell the user why the bar is wrong.",
        durationMs: Date.now() - t0,
      };
      const rest = runBar(bar, this.barContext(claim));
      return {
        ok: false,
        results: [tamper, ...rest.results],
        durationMs: Date.now() - t0,
      };
    }
    return runBar(bar, this.barContext(claim));
  }

  /**
   * Ask for an answer with what has already been paid for.
   *
   * Every guard in this loop used to end a turn by returning nothing: the step
   * guard, the budget, the turn ceiling, the no-progress stop. A session that
   * read twenty files and hit a limit threw all of it away — maximum cost,
   * zero value, which is the worst outcome available and the one a user
   * actually reported.
   *
   * So a stopped turn gets one last request with tools disabled. The model
   * cannot go looking for more; it has to say what it found and what it could
   * not determine. That answer is NOT a completion claim and does not go
   * through the bar — it is a report from a turn molt cut short, and it is
   * labelled as one, because presenting it as verified would be the exact lie
   * this whole tool exists to refuse.
   */
  private async *salvage(
    reason: string,
    fetchFn: typeof fetch,
    log?: Journal,
  ): AsyncGenerator<EngineEvent> {
    this.transcript.push({
      role: "user",
      content:
        `[molt] ${reason} You cannot call any more tools. Answer now with what you have ` +
        `already found: what you learned, and — just as importantly — what you did not get ` +
        `to and cannot vouch for. Do not claim anything you did not verify.`,
    });
    try {
      const res = await fetchFn(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...authHeaders(this.cfg.baseUrl, this.cfg.apiKey),
        },
        // `tools` must be present even to say "use none of them" — a
        // tool_choice without a tools array is a 400 on at least xAI, and the
        // first version of this sent exactly that and swallowed the refusal.
        body: JSON.stringify({
          model: this.cfg.model,
          messages: this.transcript.wire(),
          tools: TOOLS,
          tool_choice: "none",
        }),
      });
      if (!res.ok) {
        // A safety net that fails silently is not a safety net. Say so.
        const why = await res.text().catch(() => "");
        log?.append("error", { text: `salvage failed: HTTP ${res.status}`, body: why.slice(0, 200) });
        yield {
          kind: "info",
          text: `could not write a closing summary (HTTP ${res.status}) — the work above is all there is`,
        };
        return;
      }
      const json = (await res.json()) as {
        choices?: { message?: Msg }[];
        usage?: Usage;
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      const pTok = json.usage?.prompt_tokens ?? 0;
      const cTok = json.usage?.completion_tokens ?? 0;
      this.sessionPrompt += pTok;
      this.sessionCompletion += cTok;
      if (typeof json.usage?.cost === "number") this.sessionBilled += json.usage.cost;
      else this.unbilledSteps += 1;
      log?.append("salvage", { reason, promptTokens: pTok, completionTokens: cTok, chars: text.length });
      if (!text.trim()) return;
      yield {
        kind: "info",
        text:
          "the answer below was written after molt stopped the turn. It was NOT checked " +
          "against the bar — treat it as notes, not as a completed task.",
      };
      yield { kind: "assistant_text", text: redact(text, this.secrets()) };
    } catch (e) {
      // A courtesy that failed must not mask the real stop, but must not
      // vanish either.
      log?.append("error", { text: `salvage failed: ${String(e)}` });
    }
  }

  /**
   * Close out a turn whose claim was never proven: write the receipt, log
   * the ending, and report it as a failure. Shared by the exhausted path and
   * the one that stops early because nothing changed, so both produce the
   * same evidence — a refusal that skips the receipt is a refusal nobody can
   * audit later.
   */
  private async *finishUnproven(
    claim: string,
    result: BarResult,
    attempts: number,
    log?: Journal,
  ): AsyncGenerator<EngineEvent> {
    const onlyWrites = failedOnlyWriteChecks(result);
    if (this.cfg.receipts) {
      const receipt = this.cfg.receipts.write({
        claim,
        result,
        attempt: attempts,
        verdict: "exhausted",
        model: this.cfg.model,
        provider: this.provider,
        sessionTokens: this.sessionTokens,
        shedBatches: this.transcript.shedCount,
      });
      log?.append("receipt", { verdict: "exhausted", file: receipt.path, attempt: attempts });
      yield { kind: "receipt", path: receipt.path };
    }
    log?.append("session_end", { reason: "bar not met", attempts });
    yield { kind: "proof_exhausted", result, attempts };
    yield {
      kind: "error",
      text: onlyWrites
        ? `bar not met: ${onlyWrites} requires this turn to have changed a file, and none ` +
          `changed. molt is reporting failure rather than success. Either the work was not ` +
          `done, or this was a question — ask questions with /ask, or a leading "?", which ` +
          `runs the rest of the bar and drops that one check.`
        : `bar not met after ${attempts} attempts. molt is reporting failure rather ` +
          `than success. See .molt/receipts/ for what was checked.`,
    };
  }

  /** Run the bar without touching the loop — backs the /prove command. */
  proveNow(claim?: string): BarResult | null {
    if (!this.cfg.bar) return null;
    return this.runBarGuarded(claim);
  }

  /**
   * One user turn, with its own books.
   *
   * The session meter answers "what have I spent?" and must only ever climb.
   * It cannot also answer "what did that question cost?" — so the per-job
   * figures are kept here, as a delta against a snapshot taken before the
   * turn, and reported when the turn ends. Nothing about the session totals
   * changes; a job is a view of them, never a reset.
   */
  async *run(
    userText: string,
    confirm: Confirm,
    opts: RunOptions = {},
  ): AsyncGenerator<EngineEvent> {
    const job = ++this.jobCount;
    const startedAt = Date.now();
    const before = this.meter();
    let steps = 0;
    let cancelled = false;
    let errored = false;
    let exhausted = false;
    let proven = false;
    let answered = false;

    yield { kind: "job_start", job, text: userText };
    this.pinTask(userText);

    for await (const ev of this.runTurn(userText, confirm, job, opts)) {
      switch (ev.kind) {
        case "step_summary":
          steps += 1;
          break;
        case "cancelled":
          cancelled = true;
          break;
        case "error":
          errored = true;
          break;
        case "proof_exhausted":
          exhausted = true;
          break;
        case "proof_result":
          proven = true;
          break;
        case "assistant_text":
          answered = true;
          break;
      }
      yield ev;
    }

    // Order matters: a bar that was never met is "not proven" even though an
    // error event follows it, and an answer nothing checked is never
    // "verified" — the distinction molt exists to make.
    const outcome: JobOutcome = cancelled
      ? "cancelled"
      : exhausted
        ? "not proven"
        : errored
          ? "error"
          : proven
            ? "verified"
            : answered
              ? "unverified"
              : "stopped";

    yield {
      kind: "job_end",
      job,
      steps,
      spend: this.spendSince(before),
      durationMs: Date.now() - startedAt,
      outcome,
    };
  }

  private async *runTurn(
    userText: string,
    confirm: Confirm,
    job: number,
    opts: RunOptions = {},
  ): AsyncGenerator<EngineEvent> {
    // Remember where this turn began so a cancellation can leave no trace.
    const turnStart = this.transcript.length;
    const log = this.cfg.journal;
    this.transcript.push({ role: "user", content: userText });
    log?.append("user_message", {
      chars: userText.length,
      preview: userText.replace(/\s+/g, " ").slice(0, 120),
      sha256: createHash("sha256").update(userText, "utf8").digest("hex").slice(0, 16),
    });
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const maxAttempts = this.cfg.maxProofAttempts ?? MAX_PROOF_ATTEMPTS;
    let proofAttempts = 0;
    /** The last bar result, for deciding whether another run could differ. */
    let lastResult: BarResult | null = null;
    /** The previous attempt's failures, to notice a bar going nowhere. */
    let lastFailure = "";
    this.actsSinceBar = 0;

    /**
     * Every tool call made this turn, by call and by the digest of what it
     * returned. A model that asks the same question and gets the same answer
     * has learned nothing, and resending that answer costs the same as the
     * first time — which is how thirty steps of re-reading four files became
     * fifty cents.
     */
    const answered = new Map<string, { step: number; sha: string }>();
    /**
     * Which lines of which file the model has already been shown this turn.
     *
     * Exact-match detection is not enough on its own: asking for line 181 and
     * then line 182 of the same file returns almost the same bytes under a
     * different key, which is precisely how a real session walked past the
     * repeat guard for thirty-two steps. Coverage answers the question that
     * actually matters — "has this already been shown?" — rather than "is this
     * byte-identical to something?".
     */
    const shown = new Map<string, { from: number; to: number }[]>();
    /** Consecutive steps in which nothing new came back. */
    let dryStreak = 0;

    // A question changes nothing, so a check that demands a change can only
    // ever fail it. `ask` drops exactly those checks for this turn and runs
    // the rest — the bar is narrowed in the open, never quietly lowered, and
    // the receipt records which checks actually ran.
    const bar = opts.ask ? withoutWriteChecks(this.cfg.bar) : this.cfg.bar;
    if (opts.ask) {
      const dropped = (this.cfg.bar?.checks.length ?? 0) - (bar?.checks.length ?? 0);
      log?.append("note", { text: `ask turn — ${dropped} write-dependent check(s) not run` });
      if (dropped > 0) {
        yield {
          kind: "info",
          text: `asking: ${dropped} check(s) that require a file change are not run this turn`,
        };
      }
    }

    const turnStartTokens = this.sessionTokens;
    const turnStartCost = this.costUsd();
    let warned = 0;
    for (let step = 0; step < MAX_STEPS; step++) {
      // An explicit budget speaks for itself, and speaks first: one knob
      // should not produce two different messages.
      if (this.overBudget()) {
        yield {
          kind: "error",
          text: `budget hit (${this.budgetTokens} tokens) — loop stopped. /budget to raise.`,
        };
        yield* this.salvage(`You have reached the token budget for this session.`, fetchFn, log);
        return;
      }

      // Otherwise a ceiling on the turn, not just on the session. Checked
      // before the request rather than after, so the limit is what molt
      // refuses to spend rather than what it noticed spending.
      // Money where a price is known, tokens only where it is not.
      const spentThisTurn = this.sessionTokens - turnStartTokens;
      const usdThisTurn =
        turnStartCost === undefined ? undefined : (this.costUsd() ?? 0) - turnStartCost;
      const usdCeiling = this.cfg.maxTurnUsd ?? DEFAULT_TURN_USD;
      const tokenCeiling = this.cfg.maxTurnTokens ?? DEFAULT_TURN_TOKENS;
      const priced = usdThisTurn !== undefined && usdCeiling > 0;
      const used = priced ? usdThisTurn : spentThisTurn;
      const ceiling = priced ? usdCeiling : tokenCeiling;
      // Named for what it is, and not `shown` — which is the read-coverage map
      // a few lines down, and which this quietly shadowed until the compiler
      // said so.
      const ceilingLine = priced
        ? `${fmtUsd(usdThisTurn)} of ${fmtUsd(usdCeiling)}`
        : `${spentThisTurn} of ${tokenCeiling} tokens`;

      // Said on the way up, not only on arrival. A limit that speaks for the
      // first time when it stops you is a limit that feels like a surprise
      // bill, whatever the number on it.
      while (
        ceiling > 0 &&
        warned < CEILING_WARNINGS.length &&
        used >= ceiling * CEILING_WARNINGS[warned]!
      ) {
        const pct = Math.round(CEILING_WARNINGS[warned]! * 100);
        warned += 1;
        yield {
          kind: "info",
          text: `this turn: ${ceilingLine} — ${pct}% of the ceiling. /budget raises it, /budget off removes it.`,
        };
      }

      if (ceiling > 0 && used >= ceiling) {
        log?.append("session_end", {
          reason: "turn ceiling",
          tokens: spentThisTurn,
          usd: usdThisTurn ?? null,
        });
        yield {
          kind: "error",
          text:
            `stopped: this turn has spent ${ceilingLine}, its ceiling for a single turn. Nothing ` +
            `was verified. Narrow the request, raise it with /budget, or remove it with ` +
            `/budget off.`,
        };
        yield* this.salvage(`This turn reached its spending ceiling (${ceilingLine}).`, fetchFn, log);
        return;
      }

      // Cheap, mechanical, and strictly a subset of shedding: prune tool
      // results that later work has made irrelevant before considering the
      // much heavier option of shedding.
      if (this.cfg.elideSuperseded !== false) {
        const pruned = this.transcript.elideSupersededReads();
        if (pruned.elided > 0) {
          log?.append("elide", { elided: pruned.elided, tokensSaved: pruned.tokensSaved });
          yield {
            kind: "info",
            text: `pruned ${pruned.elided} superseded tool result(s) · ${pruned.tokensSaved} tokens freed`,
          };
        }
      }

      const auto = this.cfg.autoShedAtTokens ?? DEFAULT_AUTO_SHED_TOKENS;
      if (auto > 0 && this.transcript.historyTokens() > auto) {
        const shed = this.shed();
        if (shed) {
          // Shedding removes the file contents from the model's context, so
          // everything molt believed it had "already been shown" is gone. The
          // coverage map has to forget with it — otherwise molt tells a model
          // to scroll up to something it just archived, refuses the re-read,
          // and calls the resulting stall a loop. A real session spent 29 of
          // its 31 repeat-refusals after a shed, for exactly this reason.
          shown.clear();
          answered.clear();
          log?.append("shed", {
            dropped: shed.dropped,
            before: shed.before,
            after: shed.after,
            archive: shed.path,
            estimated: true,
          });
          yield { kind: "shed", ...shed };
        }
      }

      const stream = this.cfg.stream !== false;
      const controller = new AbortController();
      this.inFlight = controller;
      const stepStartedAt = Date.now();

      const wire = this.transcript.wire();
      const requestEst = this.bom().requestTotalEst;
      log?.append("request", {
        step,
        messages: wire.length,
        estTokens: requestEst,
        estimated: true,
        stream,
        model: this.cfg.model,
        endpoint: this.cfg.baseUrl,
      });
      yield {
        kind: "request",
        step,
        messages: wire.length,
        estTokens: requestEst,
        model: this.cfg.model,
        stream,
      };

      /**
       * Streaming responses carry no usage block unless it is asked for.
       * Without this flag molt fell back to counting the wire JSON itself —
       * an estimate presented in a meter that reads as a measurement, on
       * the code path that is on by default. Asking costs one field.
       */
      const askForUsage = stream && !this.streamUsageUnsupported;
      const send = (withUsage: boolean): Promise<Response> =>
        fetchFn(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            ...authHeaders(this.cfg.baseUrl, this.cfg.apiKey),
          },
          body: (this.lastRequestBody = JSON.stringify({
            model: this.cfg.model,
            messages: wire,
            tools: TOOLS,
            tool_choice: "auto",
            ...(stream ? { stream: true } : {}),
            ...(withUsage ? { stream_options: { include_usage: true } } : {}),
          })),
        });

      let res: Response;
      try {
        res = await send(askForUsage);
        // A server that does not implement the field rejects the request. Try
        // once without it rather than failing a turn over a request for better
        // bookkeeping — and only conclude the field was the problem if the
        // retry actually works, so a genuine 400 does not quietly turn usage
        // reporting off for the rest of the session.
        if (!res.ok && res.status === 400 && askForUsage) {
          const retry = await send(false);
          if (retry.ok) {
            this.streamUsageUnsupported = true;
            log?.append("note", {
              text: "provider rejected stream_options — token counts fall back to molt's estimate",
            });
          }
          res = retry;
        }
      } catch (e) {
        this.inFlight = undefined;
        if (controller.signal.aborted) {
          this.transcript.rollbackTo(turnStart);
          log?.append("cancelled", { step, rolledBack: true });
          yield { kind: "cancelled" };
          return;
        }
        log?.append("error", { text: `network: ${String(e)}` });
        yield { kind: "error", text: `network: ${String(e)}` };
        return;
      }

      if (!res.ok) {
        this.inFlight = undefined;
        const body = (await res.text().catch(() => "")).slice(0, 300);
        log?.append("error", { text: `HTTP ${res.status}`, body: body.slice(0, 200) });
        yield { kind: "error", text: `HTTP ${res.status}: ${body}` };
        return;
      }

      let msg: Msg | undefined;
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      const contentType = res.headers?.get?.("content-type") ?? "";
      const isSse = stream && res.body != null && contentType.includes("event-stream");

      if (isSse) {
        // Fragments are buffered and re-yielded after the read completes.
        // An async generator cannot yield from inside a callback, and
        // restructuring the whole loop into a push model to gain a few
        // hundred milliseconds of earlier paint is not worth the complexity
        // that would add to the proof gate below.
        const fragments: string[] = [];
        try {
          const result = await readStream(res.body!, (fragment) => {
            fragments.push(fragment);
          });
          msg = result.message;
          finishReason = result.finishReason;
          usage = {
            prompt_tokens: result.promptTokens,
            completion_tokens: result.completionTokens,
            ...(result.cachedTokens === undefined
              ? {}
              : { prompt_tokens_details: { cached_tokens: result.cachedTokens } }),
            ...(result.reasoningTokens === undefined
              ? {}
              : { completion_tokens_details: { reasoning_tokens: result.reasoningTokens } }),
            ...(result.costUsd === undefined ? {} : { cost: result.costUsd }),
          };
        } catch (e) {
          this.inFlight = undefined;
          if (controller.signal.aborted) {
            this.transcript.rollbackTo(turnStart);
            yield { kind: "cancelled" };
            return;
          }
          yield { kind: "error", text: `stream: ${String(e)}` };
          return;
        }
        for (const f of fragments) yield { kind: "delta", text: f };
      } else {
        let json: {
          choices?: { message?: Msg; finish_reason?: string | null }[];
          usage?: Usage;
        };
        try {
          json = (await res.json()) as typeof json;
        } catch {
          this.inFlight = undefined;
          if (controller.signal.aborted) {
            this.transcript.rollbackTo(turnStart);
            yield { kind: "cancelled" };
            return;
          }
          yield { kind: "error", text: "provider returned non-JSON response" };
          return;
        }
        msg = json.choices?.[0]?.message;
        finishReason = json.choices?.[0]?.finish_reason ?? undefined;
        usage = json.usage;
      }

      this.inFlight = undefined;

      if (!msg) {
        yield { kind: "error", text: "provider response missing choices[0].message" };
        return;
      }

      const reportedUsage =
        typeof usage?.prompt_tokens === "number" || typeof usage?.completion_tokens === "number";
      const pTok = usage?.prompt_tokens ?? estTokens(JSON.stringify(wire));
      const cTok = usage?.completion_tokens ?? estTokens(JSON.stringify(msg));
      const cachedTok = usage?.prompt_tokens_details?.cached_tokens ?? 0;
      const billedUsd = usage?.cost;
      const costBefore = this.costUsd();

      this.sessionPrompt += pTok;
      this.sessionCompletion += cTok;
      this.sessionCached += cachedTok;
      if (!reportedUsage) this.estimatedSteps += 1;
      if (typeof billedUsd === "number") this.sessionBilled += billedUsd;
      else this.unbilledSteps += 1;

      const costAfter = this.costUsd();
      const stepCost =
        typeof billedUsd === "number"
          ? billedUsd
          : costAfter === undefined
            ? undefined
            : costAfter - (costBefore ?? 0);

      log?.append("response", {
        step,
        promptTokens: pTok,
        completionTokens: cTok,
        cachedTokens: cachedTok,
        // Providers do not always report usage. Say which this is.
        estimated: !reportedUsage,
        costUsd: stepCost ?? null,
        billed: typeof billedUsd === "number",
        finishReason: finishReason ?? null,
        toolCalls: msg.tool_calls?.length ?? 0,
        contentChars: (msg.content ?? "").length,
        finishedWithText: Boolean(msg.content),
      });
      yield {
        kind: "usage",
        promptTokens: pTok,
        completionTokens: cTok,
        cachedTokens: cachedTok,
        sessionTokens: this.sessionTokens,
        costUsd: costAfter,
        estimated: !reportedUsage,
        billed: typeof billedUsd === "number",
      };
      // Cumulative prompt tokens are dominated by resending the same
      // conversation, which is fine when the provider caches it and brutal
      // when it does not. Said once, when it starts to matter, because it
      // changes which provider a long session should run on.
      if (
        !this.warnedNoCache &&
        this.sessionCached === 0 &&
        this.sessionPrompt > 100_000 &&
        reportedUsage
      ) {
        this.warnedNoCache = true;
        yield {
          kind: "info",
          text:
            `${this.sessionPrompt} prompt tokens so far and none of them cached — this ` +
            `endpoint re-bills the whole conversation on every step. Providers with ` +
            `automatic caching charge a fraction of this for the same work.`,
        };
      }

      const spend: Spend = {
        promptTokens: pTok,
        completionTokens: cTok,
        cachedTokens: cachedTok,
        costUsd: stepCost,
        estimated: !reportedUsage,
        billed: typeof billedUsd === "number",
      };
      /** Close out the step with what it did and what it cost. */
      const summary = (tools: string[], outcome: "tools" | "claim"): EngineEvent => ({
        kind: "step_summary",
        job,
        step,
        tools,
        spend,
        sessionTokens: this.sessionTokens,
        sessionCostUsd: this.costUsd(),
        durationMs: Date.now() - stepStartedAt,
        outcome,
        finishReason,
      });

      this.transcript.push({
        role: "assistant",
        content: msg.content ?? null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });

      if (msg.tool_calls?.length) {
        const called: string[] = [];
        let autoRan = 0;
        let repeated = 0;
        for (const call of msg.tool_calls) {
          const name = call.function?.name ?? "unknown";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
          } catch {
            /* model sent malformed args; run with empty */
          }
          const detail = toolDetail(name, args);
          // What the current autonomy level says about this exact call. The
          // decision is mechanical and the reason travels with it, so an
          // approval prompt can say which rule produced it rather than
          // asking the same way about everything.
          const decision = gate(this.autonomy, { name, args, cwd: this.cwd });
          // The prompt shows the command in full. You are being asked to judge
          // it, and a redacted command is one you cannot judge.
          const allowed = decision.ask ? await confirm(name, `${detail}${decision.why ? ` — ${decision.why}` : ""}`) : true;

          let result: string;
          let note: string | undefined;
          // Timed around execution only. Waiting on a human to approve a gated
          // tool is not the tool being slow, and folding the two together
          // would make every gated call look like one.
          let durationMs: number | undefined;
          if (!allowed) {
            result = "User denied this action.";
            note = "denied";
          } else {
            yield { kind: "tool_start", name, detail };
            const toolStartedAt = Date.now();
            try {
              // read_file budgets itself, to the byte, so that the notice
              // saying how to continue survives. Capping it again here is what
              // cut that notice off and left the model with no way forward.
              const raw = this.runTool(name, args, call.id);
              const t =
                name === "read_file" ? { text: raw, note: undefined } : truncateResult(raw);
              result = t.text;
              note = t.note;
            } catch (e) {
              result = `tool error: ${String(e)}`;
              note = "error";
            }
            durationMs = Date.now() - toolStartedAt;

            // A read of lines the model has already been shown, whatever
            // offset it spelled them with.
            if (name === "read_file" && note !== "error") {
              const path = String(args.path ?? "");
              const from = num(args.offset, 0);
              const lines = (result.match(/\n/g)?.length ?? 0) + 1;
              const to = from + lines;
              const covered = shown.get(path) ?? [];
              // How much of this window is genuinely new. Containment alone is
              // too strict: a read that overlaps an earlier one by 99% and
              // runs three lines past it is not contained, and a model
              // drifting its offset by a few lines a step walked straight
              // through that test for thirty-two steps.
              let fresh = 0;
              for (let line = from; line < to; line++) {
                if (!covered.some((r) => line >= r.from && line < r.to)) fresh += 1;
              }
              const span = Math.max(1, to - from);
              const already = fresh === 0 || (fresh / span < 0.25 && fresh < 40);
              if (already) {
                const seen = covered.reduce((n, r) => Math.max(n, r.to), 0);
                result =
                  `[molt: you have already been shown lines ${from + 1}-${to} of ${path}` +
                  (fresh === 0 ? "" : ` (all but ${fresh} line(s) of it)`) +
                  `. Scroll up rather than reading it again — nothing has changed since. To ` +
                  `see a part you do not have, ask for offset=${seen} or later; if you have ` +
                  `what you need, answer.]`;
                note = "repeat";
                repeated += 1;
              } else {
                covered.push({ from, to });
                shown.set(path, covered);
              }
            }

            // The same call, returning the same bytes it returned before.
            // Send a pointer instead of the payload: the answer is already in
            // the conversation, and saying so is both cheaper and truer than
            // repeating it.
            // Canonical key: {path} and {path, offset: 0} are the same call,
            // and a model that spells out a default must not thereby look like
            // it is asking something new.
            const key = callKey(name, args);
            const sha = createHash("sha256").update(result, "utf8").digest("hex");
            const prior = answered.get(key);
            if (prior && prior.sha === sha) {
              result =
                `[molt: this is the same ${name} call you made at step ${prior.step + 1}, and ` +
                `nothing has changed since. Its result is already above in this conversation. ` +
                `Repeating it cannot tell you anything new — act on what you have, or say ` +
                `plainly what is blocking you.]`;
              note = "repeat";
              repeated += 1;
            }
            answered.set(key, { step, sha });
          }
          // Both branches are recorded. A call that ran without being asked
          // about is exactly the thing an audit needs to be able to find, and
          // it is recorded with the level that let it through.
          log?.append("permission", {
            name,
            detail,
            allowed,
            asked: decision.ask,
            autonomy: this.autonomy,
            ...(decision.why ? { why: decision.why } : {}),
          });
          log?.append("tool_call", { step, name, detail, allowed });
          log?.append("tool_result", {
            name,
            bytes: Buffer.byteLength(result, "utf8"),
            truncated: Boolean(note?.startsWith("capped")),
            note,
            sha256: createHash("sha256").update(result, "utf8").digest("hex").slice(0, 16),
          });
          if ((name === "write_file" || name === "edit_file") && allowed) {
            shown.delete(String(args.path ?? ""));
            this.pinTask(userText);
          }
          called.push(name);
          this.did.push(
            `${allowed ? "" : "refused: "}${name} ${detail}` +
              (note && note !== "repeat" ? ` [${note}]` : ""),
          );
          if (allowed) this.actsSinceBar += 1;
          if (!decision.ask) autoRan += 1;
          // Everything that scrolls is redacted. A transcript is pasted into
          // bug reports and screenshotted into chat windows, which makes the
          // screen a distribution channel like any other — and unlike the
          // prompt above, nobody is judging a command from the scrollback.
          const hide = (t: string) => redact(t, this.secrets());
          yield {
            kind: "tool",
            name,
            detail: hide(detail),
            note,
            durationMs,
            args: hide(capture(call.function?.arguments ?? "")),
            bytes: Buffer.byteLength(result, "utf8"),
            preview: hide(capture(result)),
            auto: !decision.ask,
          };
          this.transcript.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        yield summary(called, "tools");

        // A step whose every call was a repeat produced no new information.
        // One can be a stumble; two in a row is a loop, and a loop with a
        // token meter attached has to be stopped by molt rather than by the
        // step guard thirty steps later.
        // Majority, not unanimity. A step that spends three calls on things it
        // already had and one on something new is thrashing, and requiring
        // every single call to be a repeat is how a loop walked past this
        // guard for thirty-two steps and most of a dollar.
        if (called.length > 0 && repeated * 2 >= called.length) {
          dryStreak += 1;
          if (dryStreak === 1) {
            yield {
              kind: "info",
              text:
                `${repeated} of ${called.length} calls that step were things molt had already ` +
                `answered — little or nothing new came back`,
            };
          }
        } else {
          dryStreak = 0;
        }
        if (dryStreak >= 2) {
          log?.append("loop_stop", {
            step,
            repeatedCalls: called.length,
            sessionTokens: this.sessionTokens,
            costUsd: this.costUsd() ?? null,
          });
          log?.append("session_end", { reason: "no progress" });
          yield {
            kind: "error",
            text:
              `stopped: the model spent two steps repeating calls that had already been ` +
              `answered, and no new information came back. This turn used ` +
              `${this.sessionTokens - turnStartTokens} tokens of the session's ` +
              `${this.sessionTokens}. Nothing was verified — try a narrower request, or ` +
              `shift+V to watch what it is reaching for.`,
          };
          yield* this.salvage(
            "You have spent two steps repeating calls that were already answered.",
            fetchFn,
            log,
          );
          return;
        }
        continue; // let the model see tool results
      }

      yield summary([], "claim");

      // ---- The model believes it is finished. That is a claim. ----
      const claim = msg.content ?? "";

      if (!bar || bar.checks.length === 0) {
        yield {
          kind: "info",
          text: opts.ask
            ? "nothing left in the bar to check a question against — this answer is unverified."
            : "no .molt/done.yml — completion is unverified. run `molt init` to add a bar.",
        };
        if (claim) yield { kind: "assistant_text", text: redact(claim, this.secrets()) };
        return;
      }

      // Nothing has happened since the last bar run, so the bar cannot
      // answer differently. Say so and stop, rather than spending another
      // suite — and another turn's tokens — proving it.
      if (lastResult !== null && this.actsSinceBar === 0) {
        log?.append("bar_skipped", {
          attempt: proofAttempts,
          reason: "no tool calls since the last bar run; state is unchanged",
          failed: lastResult.results.filter((r) => !r.ok).map((r) => r.name).join(", "),
        });
        yield {
          kind: "info",
          text:
            "the model changed nothing since the last check, so re-running the bar would " +
            "produce the same result. Stopping instead of spending another attempt.",
        };
        yield* this.finishUnproven(claim, lastResult, proofAttempts, log);
        return;
      }

      proofAttempts += 1;
      yield {
        kind: "proof_start",
        checks: bar.checks.length,
        names: bar.checks.map((c) => c.name),
      };
      const result = this.runBarGuarded(claim, bar);
      this.actsSinceBar = 0;
      lastResult = result;
      log?.append("bar_run", {
        attempt: proofAttempts,
        ok: result.ok,
        total: result.results.length,
        passed: result.results.filter((r) => r.ok).length,
        failed: result.results.filter((r) => !r.ok).map((r) => r.name).join(", "),
        ms: result.durationMs,
        checks: result.results.map((r) => ({
          name: r.name,
          kind: r.kind,
          detail: r.detail,
          ok: r.ok,
          exitCode: r.exitCode ?? null,
          ms: r.durationMs,
          // A reused result is evidence of a different kind, and the record
          // has to say which kind it is.
          cached: r.cached === true,
        })),
      });
      // A bar failing in exactly the same way it failed last time is a bar the
      // model is not converging on. It spent 1.13M tokens on one such loop,
      // rewriting a correct document to satisfy a check that was wrong about
      // it — so identical twice is enough.
      const signature = result.results
        .filter((r) => !r.ok)
        .map((r) => `${r.name}:${r.output.trim()}`)
        .join("|");
      const stuck = !result.ok && signature === lastFailure;
      lastFailure = signature;
      const exhausted = !result.ok && (stuck || proofAttempts >= maxAttempts);
      const verdict = result.ok ? "accepted" : exhausted ? "exhausted" : "refused";

      if (this.cfg.receipts) {
        const receipt = this.cfg.receipts.write({
          claim,
          result,
          attempt: proofAttempts,
          verdict,
          model: this.cfg.model,
          provider: this.provider,
          sessionTokens: this.sessionTokens,
          session: this.cfg.journal?.sessionId,
          costUsd: this.costUsd(),
          costEstimated: this.costEstimated,
          shedBatches: this.transcript.shedCount,
          changed: this.mergedLedger().map((e) => ({ path: e.path, before: e.before, after: e.after })),
          did: [...this.did],
        });
        log?.append("receipt", { verdict, file: receipt.path, attempt: proofAttempts });
        yield { kind: "receipt", path: receipt.path };
      }

      if (result.ok) {
        log?.append("session_end", { reason: "bar met", attempts: proofAttempts });
        yield { kind: "proof_result", result, attempt: proofAttempts };
        if (claim) yield { kind: "assistant_text", text: redact(claim, this.secrets()) };
        return;
      }

      if (exhausted) {
        log?.append("session_end", { reason: "bar not met", attempts: proofAttempts });
        yield { kind: "proof_exhausted", result, attempts: proofAttempts };
        const onlyWrites = failedOnlyWriteChecks(result);
        if (stuck) {
          yield {
            kind: "info",
            text:
              "the bar failed in exactly the same way twice. Continuing would spend more " +
              "tokens on a check the work is not moving — either the work cannot satisfy " +
              "it, or the check is wrong about the work.",
          };
        }
        yield {
          kind: "error",
          text: onlyWrites
            ? `bar not met: ${onlyWrites} requires this turn to have changed a file, and ` +
              `none changed. molt is reporting failure rather than success. Either the work ` +
              `was not done, or this was a question — ask questions with /ask, or a leading ` +
              `"?", which runs the rest of the bar and drops that one check.`
            : `bar not met after ${proofAttempts} attempts. molt is reporting failure rather ` +
              `than success. See .molt/receipts/ for what was checked.`,
        };
        return;
      }

      yield { kind: "proof_refused", result, attempt: proofAttempts };
      this.pinTask(
        userText,
        result.results.filter((r) => !r.ok && !r.advisory).map((r) => r.name).join(", "),
      );
      this.transcript.pushBarFailure(formatBarFailure(result, proofAttempts, maxAttempts));
    }

    yield {
      kind: "error",
      text:
        `stopped after ${MAX_STEPS} steps (loop guard) · ${this.sessionTokens} tokens` +
        (this.costUsd() === undefined ? "" : ` · ${fmtUsd(this.costUsd() ?? 0)}`) +
        `. Nothing was verified. Narrow the request, or set /budget to put a ceiling on a ` +
        `turn like this.`,
    };
    yield* this.salvage(`You have used all ${MAX_STEPS} steps available for this turn.`, fetchFn, log);
  }

  /** Preflight: is the endpoint reachable, and is the model actually there? */
  async doctor(): Promise<{ ok: boolean; detail: string; modelPresent?: boolean }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/models`, { headers: authHeaders(base, this.cfg.apiKey) });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      // No list at all is not evidence against the model; endpoints that hide
      // /models exist, and refusing them would be a guess dressed as a check.
      if (!ids.length) return { ok: true, detail: `endpoint reachable (${base}) · model list unavailable` };
      const has = ids.includes(this.cfg.model);
      return {
        // A preflight that passes on a model the endpoint does not have is a
        // preflight that only fails once the work has already started.
        ok: has,
        modelPresent: has,
        detail:
          `endpoint reachable · ${ids.length} models` +
          (has
            ? ` · '${this.cfg.model}' available`
            : ` · ⚠ '${this.cfg.model}' NOT in list (try: ${ids.slice(0, 3).join(", ")})`),
      };
    } catch (e) {
      return { ok: false, detail: `cannot reach ${base}: ${String(e)}` };
    }
  }

  /** List model ids from an endpoint's /models route. */
  async listModels(
    baseUrl = this.cfg.baseUrl,
    apiKey = this.cfg.apiKey,
  ): Promise<{ ok: true; ids: string[] } | { ok: false; error: string }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = baseUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/models`, { headers: authHeaders(base, apiKey) });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
