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
import { barFingerprint, formatBarFailure, runBar, type BarContext } from "./bar.js";
import { Journal } from "./journal.js";
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
  type Msg,
  type Spend,
} from "./types.js";

export const SYSTEM_PROMPT = [
  "You are molt, a coding agent working in the current directory.",
  "Use the tools to read files, write files, and run shell commands (grep/find/git via bash).",
  "Read only what you need. Be terse.",
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
 * Tool results are the bulk of a session's tokens: every result is resent on
 * every subsequent request. 2048 bytes is roughly 512 tokens each — still
 * enough to be useful, and truncation is always visible, never silent.
 */
export const TOOL_RESULT_MAX_BYTES = 2048;
export const MAX_STEPS = 32;
export const MAX_PROOF_ATTEMPTS = 4;
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Create or overwrite a UTF-8 text file.",
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
      name: "bash",
      description: "Run a shell command in the current directory.",
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
  /** Shed automatically once working history exceeds this many tokens. */
  autoShedAtTokens?: number;
  /** Drop tool results that later work superseded. On by default. */
  elideSuperseded?: boolean;
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
 * Verbatim head, capped. Never a summary — a transparency view that
 * paraphrases is just another claim to check, and molt does not summarize
 * with a model anywhere else either.
 */
export const CAPTURE_MAX_CHARS = 600;

function capture(s: string): string {
  return s.length <= CAPTURE_MAX_CHARS ? s : s.slice(0, CAPTURE_MAX_CHARS) + "…";
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
  }
  setBudget(tokens?: number): void {
    this.budgetTokens = tokens;
  }
  setBar(bar: Bar | null): void {
    this.cfg.bar = bar;
    this.barHash = barFingerprint(this.cwd);
  }

  /** Point at a different endpoint. Resets the session — different world. */
  setBaseUrl(url: string, apiKey?: string, provider?: string): void {
    this.cfg.baseUrl = url;
    this.cfg.apiKey = apiKey;
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
        return readFileSync(resolve(this.cwd, String(args.path ?? "")), "utf8");

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
  private runBarGuarded(claim?: string): BarResult {
    const bar = this.cfg.bar!;
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

  /** Run the bar without touching the loop — backs the /prove command. */
  proveNow(claim?: string): BarResult | null {
    if (!this.cfg.bar) return null;
    return this.runBarGuarded(claim);
  }

  async *run(userText: string, confirm: Confirm): AsyncGenerator<EngineEvent> {
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

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.overBudget()) {
        yield {
          kind: "error",
          text: `budget hit (${this.budgetTokens} tokens) — loop stopped. /budget to raise.`,
        };
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
            text: `pruned ${pruned.elided} superseded tool result(s) · −${pruned.tokensSaved} tokens`,
          };
        }
      }

      const auto = this.cfg.autoShedAtTokens;
      if (auto !== undefined && this.transcript.historyTokens() > auto) {
        const shed = this.shed();
        if (shed) {
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
            ...(this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {}),
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
        for (const call of msg.tool_calls) {
          const name = call.function?.name ?? "unknown";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
          } catch {
            /* model sent malformed args; run with empty */
          }
          const detail = toolDetail(name, args);
          const target = resolve(this.cwd, String(args.path ?? ""));
          const outsideCwd =
            name === "read_file" && !target.startsWith(this.cwd + "/") && target !== this.cwd;
          const needsGate = name === "bash" || name === "write_file" || outsideCwd;
          const allowed = needsGate ? await confirm(name, detail) : true;

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
              const t = truncateResult(this.runTool(name, args, call.id));
              result = t.text;
              note = t.note;
            } catch (e) {
              result = `tool error: ${String(e)}`;
              note = "error";
            }
            durationMs = Date.now() - toolStartedAt;
          }
          if (needsGate) log?.append("permission", { name, detail, allowed });
          log?.append("tool_call", { step, name, detail, allowed });
          log?.append("tool_result", {
            name,
            bytes: Buffer.byteLength(result, "utf8"),
            truncated: Boolean(note?.startsWith("capped")),
            note,
            sha256: createHash("sha256").update(result, "utf8").digest("hex").slice(0, 16),
          });
          called.push(name);
          yield {
            kind: "tool",
            name,
            detail,
            note,
            durationMs,
            args: capture(call.function?.arguments ?? ""),
            bytes: Buffer.byteLength(result, "utf8"),
            preview: capture(result),
          };
          this.transcript.push({ role: "tool", tool_call_id: call.id, content: result });
        }
        yield summary(called, "tools");
        continue; // let the model see tool results
      }

      yield summary([], "claim");

      // ---- The model believes it is finished. That is a claim. ----
      const claim = msg.content ?? "";

      if (!this.cfg.bar || this.cfg.bar.checks.length === 0) {
        yield {
          kind: "info",
          text: "no .molt/done.yml — completion is unverified. run `molt init` to add a bar.",
        };
        if (claim) yield { kind: "assistant_text", text: claim };
        return;
      }

      proofAttempts += 1;
      yield {
        kind: "proof_start",
        checks: this.cfg.bar.checks.length,
        names: this.cfg.bar.checks.map((c) => c.name),
      };
      const result = this.runBarGuarded(claim);
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
        })),
      });
      const exhausted = !result.ok && proofAttempts >= maxAttempts;
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
          shedBatches: this.transcript.shedCount,
        });
        log?.append("receipt", { verdict, file: receipt.path, attempt: proofAttempts });
        yield { kind: "receipt", path: receipt.path };
      }

      if (result.ok) {
        log?.append("session_end", { reason: "bar met", attempts: proofAttempts });
        yield { kind: "proof_result", result, attempt: proofAttempts };
        if (claim) yield { kind: "assistant_text", text: claim };
        return;
      }

      if (exhausted) {
        log?.append("session_end", { reason: "bar not met", attempts: proofAttempts });
        yield { kind: "proof_exhausted", result, attempts: proofAttempts };
        yield {
          kind: "error",
          text:
            `bar not met after ${proofAttempts} attempts. molt is reporting failure rather ` +
            `than success. See .molt/receipts/ for what was checked.`,
        };
        return;
      }

      yield { kind: "proof_refused", result, attempt: proofAttempts };
      this.transcript.pushBarFailure(formatBarFailure(result, proofAttempts, maxAttempts));
    }

    yield { kind: "error", text: `stopped after ${MAX_STEPS} steps (loop guard)` };
  }

  /** Preflight: is the endpoint reachable, and is the model actually there? */
  async doctor(): Promise<{ ok: boolean; detail: string }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/models`, {
        headers: this.cfg.apiKey ? { authorization: `Bearer ${this.cfg.apiKey}` } : {},
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      if (!ids.length) return { ok: true, detail: `endpoint reachable (${base})` };
      const has = ids.includes(this.cfg.model);
      return {
        ok: true,
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
      const res = await fetchFn(`${base}/models`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
