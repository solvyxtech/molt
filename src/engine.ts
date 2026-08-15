/**
 * molt's engine — a deliberately tiny agent loop (~250 lines) that speaks
 * the OpenAI-compatible /chat/completions wire format. That one format
 * covers OpenAI, OpenRouter, Groq, Mistral, and — the point — local
 * llama.cpp / Ollama / vLLM servers. Any base URL + any key + any model.
 *
 * Design rules:
 *  - Three tools. Everything else is bash.
 *  - The system prompt is measured and shown, not hidden.
 *  - Every turn has a Bill of Materials (/bom) and counts against an
 *    optional hard budget (/budget). molt stops the loop, not your wallet.
 *  - Tool results are byte-capped; truncation is visible, never silent.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type EngineEvent =
  | { kind: "assistant_text"; text: string }
  | { kind: "tool"; name: string; detail: string; note?: string }
  | {
      kind: "usage";
      promptTokens: number;
      completionTokens: number;
      sessionTokens: number;
      costUsd?: number;
    }
  | { kind: "info"; text: string }
  | { kind: "error"; text: string };

export type Confirm = (name: string, detail: string) => Promise<boolean>;

export type EngineConfig = {
  baseUrl: string; // e.g. http://localhost:11434/v1 or https://openrouter.ai/api/v1
  apiKey?: string; // optional: local servers don't need one
  model: string;
  priceInPerMtok?: number; // USD per 1M prompt tokens (optional)
  priceOutPerMtok?: number; // USD per 1M completion tokens (optional)
  bashTimeoutMs?: number;
  fetchFn?: typeof fetch; // injectable for tests
};

export const SYSTEM_PROMPT = [
  "You are molt, a minimal coding agent working in the current directory.",
  "Use the tools to read files, write files, and run shell commands",
  "(grep/find/git via bash). Read only what you need. Be terse.",
  "When finished, summarize what changed in one to three sentences.",
].join(" ");

export const TOOL_RESULT_MAX_BYTES = 4096;
export const MAX_STEPS = 24;
export const DEFAULT_BASH_TIMEOUT_MS = 60_000;

/** Honest estimate (≈ chars/4). Real usage comes from the API response. */
export const estTokens = (s: string): number => Math.ceil(s.length / 4);

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

type Msg = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: {
    id: string;
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
};

export type Bom = {
  systemTokens: number;
  toolSchemaTokens: number;
  historyTokens: number;
  requestTotalEst: number;
  sessionPromptTokens: number;
  sessionCompletionTokens: number;
  costUsd?: number;
  budgetTokens?: number;
};

function truncateResult(s: string): { text: string; note?: string } {
  const bytes = Buffer.byteLength(s, "utf8");
  if (bytes <= TOOL_RESULT_MAX_BYTES) return { text: s };
  const cut = Buffer.from(s, "utf8")
    .subarray(0, TOOL_RESULT_MAX_BYTES)
    .toString("utf8");
  return {
    text: cut + `\n[molt: truncated ${bytes - TOOL_RESULT_MAX_BYTES} bytes]`,
    note: `capped at ${TOOL_RESULT_MAX_BYTES}B (was ${bytes}B)`,
  };
}

const SECRET_ENV = [
  "MOLT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
];

function scrubbedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of SECRET_ENV) delete env[k];
  return env;
}

function runTool(
  name: string,
  args: Record<string, unknown>,
  bashTimeoutMs: number,
): string {
  switch (name) {
    case "read_file":
      return readFileSync(resolve(String(args.path ?? "")), "utf8");
    case "write_file": {
      const p = resolve(String(args.path ?? ""));
      mkdirSync(dirname(p), { recursive: true });
      const content = String(args.content ?? "");
      writeFileSync(p, content, "utf8");
      return `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${p}`;
    }
    case "bash":
      try {
        return execSync(String(args.command ?? ""), {
          timeout: bashTimeoutMs,
          maxBuffer: 1024 * 1024,
          encoding: "utf8",
          env: scrubbedEnv(),
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (e) {
        const err = e as {
          stdout?: string;
          stderr?: string;
          status?: number;
          signal?: string;
        };
        const tag = err.signal === "SIGTERM" ? "timeout" : `exit ${err.status ?? "?"}`;
        return `${tag}\n${err.stdout ?? ""}${err.stderr ?? ""}`;
      }
    default:
      return `unknown tool: ${name}`;
  }
}

export function toolDetail(name: string, args: Record<string, unknown>): string {
  const raw =
    name === "bash"
      ? String(args.command ?? "")
      : String(args.path ?? JSON.stringify(args));
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return [...oneLine].slice(0, 80).join("");
}

export class Engine {
  cfg: EngineConfig;
  private messages: Msg[] = [{ role: "system", content: SYSTEM_PROMPT }];
  private sessionPrompt = 0;
  private sessionCompletion = 0;
  budgetTokens?: number;
  /** Exact JSON body of the most recent request — the wire, unhidden. */
  lastRequestBody?: string;

  constructor(cfg: EngineConfig) {
    this.cfg = cfg;
  }

  get model(): string {
    return this.cfg.model;
  }

  get baseUrl(): string {
    return this.cfg.baseUrl;
  }

  setModel(m: string): void {
    this.cfg.model = m;
  }

  setApiKey(k?: string): void {
    this.cfg.apiKey = k;
  }

  /** Point at a different endpoint. Resets the session (different provider = different world). */
  setBaseUrl(url: string, apiKey?: string): void {
    this.cfg.baseUrl = url;
    this.cfg.apiKey = apiKey;
    this.reset();
  }

  /** List model ids from an endpoint's /models route (defaults to current). */
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
      const json = (await res.json().catch(() => null)) as {
        data?: { id?: string }[];
      } | null;
      const ids = (json?.data ?? []).map((m) => m.id).filter(Boolean) as string[];
      return { ok: true, ids };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  reset(): void {
    this.messages = [{ role: "system", content: SYSTEM_PROMPT }];
  }

  setBudget(tokens?: number): void {
    this.budgetTokens = tokens;
  }

  costUsd(): number | undefined {
    const { priceInPerMtok: pin, priceOutPerMtok: pout } = this.cfg;
    if (pin === undefined || pout === undefined) return undefined;
    return (
      (this.sessionPrompt / 1e6) * pin + (this.sessionCompletion / 1e6) * pout
    );
  }

  bom(): Bom {
    const historyTokens = this.messages
      .slice(1)
      .reduce(
        (n, m) =>
          n +
          estTokens(m.content ?? "") +
          estTokens(JSON.stringify(m.tool_calls ?? "")),
        0,
      );
    const systemTokens = estTokens(SYSTEM_PROMPT);
    const toolSchemaTokens = estTokens(JSON.stringify(TOOLS));
    return {
      systemTokens,
      toolSchemaTokens,
      historyTokens,
      requestTotalEst: systemTokens + toolSchemaTokens + historyTokens,
      sessionPromptTokens: this.sessionPrompt,
      sessionCompletionTokens: this.sessionCompletion,
      costUsd: this.costUsd(),
      budgetTokens: this.budgetTokens,
    };
  }

  private overBudget(): boolean {
    return (
      this.budgetTokens !== undefined &&
      this.sessionPrompt + this.sessionCompletion >= this.budgetTokens
    );
  }

  async *run(userText: string, confirm: Confirm): AsyncGenerator<EngineEvent> {
    this.messages.push({ role: "user", content: userText });
    const fetchFn = this.cfg.fetchFn ?? fetch;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.overBudget()) {
        yield {
          kind: "error",
          text: `budget hit (${this.budgetTokens} tokens) — loop stopped. /budget to raise.`,
        };
        return;
      }

      let res: Response;
      try {
        res = await fetchFn(`${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.apiKey
              ? { authorization: `Bearer ${this.cfg.apiKey}` }
              : {}),
          },
          body: (this.lastRequestBody = JSON.stringify({
            model: this.cfg.model,
            messages: this.messages,
            tools: TOOLS,
            tool_choice: "auto",
          })),
        });
      } catch (e) {
        yield { kind: "error", text: `network: ${String(e)}` };
        return;
      }

      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        yield { kind: "error", text: `HTTP ${res.status}: ${body}` };
        return;
      }

      let json: {
        choices?: { message?: Msg }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      try {
        json = (await res.json()) as typeof json;
      } catch {
        yield { kind: "error", text: "provider returned non-JSON response" };
        return;
      }

      const msg = json.choices?.[0]?.message;
      if (!msg) {
        yield { kind: "error", text: "provider response missing choices[0].message" };
        return;
      }

      const pTok =
        json.usage?.prompt_tokens ??
        estTokens(JSON.stringify(this.messages));
      const cTok =
        json.usage?.completion_tokens ?? estTokens(JSON.stringify(msg));
      this.sessionPrompt += pTok;
      this.sessionCompletion += cTok;

      this.messages.push({
        role: "assistant",
        content: msg.content ?? null,
        ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      });

      if (msg.tool_calls?.length) {
        for (const call of msg.tool_calls) {
          const name = call.function?.name ?? "unknown";
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(call.function?.arguments || "{}");
          } catch {
            /* model sent malformed args; run with empty */
          }
          const detail = toolDetail(name, args);
          const outsideCwd =
            name === "read_file" &&
            !resolve(String(args.path ?? "")).startsWith(process.cwd() + "/") &&
            resolve(String(args.path ?? "")) !== process.cwd();
          const needsGate =
            name === "bash" || name === "write_file" || outsideCwd;
          const allowed = needsGate ? await confirm(name, detail) : true;

          let result: string;
          let note: string | undefined;
          if (!allowed) {
            result = "User denied this action.";
            note = "denied";
          } else {
            try {
              const t = truncateResult(
                runTool(name, args, this.cfg.bashTimeoutMs ?? DEFAULT_BASH_TIMEOUT_MS),
              );
              result = t.text;
              note = t.note;
            } catch (e) {
              result = `tool error: ${String(e)}`;
              note = "error";
            }
          }
          yield { kind: "tool", name, detail, note };
          this.messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: result,
          });
        }
        continue; // let the model see tool results
      }

      if (msg.content) yield { kind: "assistant_text", text: msg.content };
      yield {
        kind: "usage",
        promptTokens: pTok,
        completionTokens: cTok,
        sessionTokens: this.sessionPrompt + this.sessionCompletion,
        costUsd: this.costUsd(),
      };
      return;
    }
    yield { kind: "error", text: `stopped after ${MAX_STEPS} steps (loop guard)` };
  }

  /**
   * The molt: shed old context DETERMINISTICALLY — no model call, zero
   * tokens spent, zero hallucination risk. The full dropped history is
   * returned as an exuvia (markdown) for the caller to archive; a
   * mechanical digest replaces it in context. Nothing is ever lost.
   */
  shed(keepExchanges = 2): {
    beforeTokens: number;
    afterTokens: number;
    droppedCount: number;
    exuvia: string;
  } | null {
    const isDigest = (m: Msg) =>
      m.role === "user" && (m.content ?? "").startsWith("[molt digest");
    const body = this.messages.slice(1);
    // Digest messages are bookkeeping, not exchanges — they don't count
    // toward keepExchanges and are never the *only* thing shed (that
    // would be re-digesting a digest for no new information).
    const userIdxs = body
      .map((m, i) => (m.role === "user" && !isDigest(m) ? i : -1))
      .filter((i) => i >= 0);
    if (userIdxs.length <= keepExchanges) return null;
    const cutAt = userIdxs[userIdxs.length - keepExchanges];
    const dropped = body.slice(0, cutAt);
    const kept = body.slice(cutAt);
    if (dropped.length === 0 || dropped.every(isDigest)) return null;

    const before = this.bom().historyTokens;

    const cap = (t: string, n = 300) =>
      t.length > n ? t.slice(0, n) + "…" : t;
    const asks: string[] = [];
    const answers: string[] = [];
    const actions: string[] = [];
    for (const m of dropped) {
      if (m.role === "user" && m.content) asks.push(cap(m.content));
      if (m.role === "assistant" && m.content) answers.push(cap(m.content));
      for (const c of m.tool_calls ?? []) {
        try {
          const a = JSON.parse(c.function.arguments || "{}");
          actions.push(`${c.function.name}: ${toolDetail(c.function.name, a)}`);
        } catch {
          actions.push(c.function.name);
        }
      }
    }
    const digest = [
      "[molt digest of shed context — mechanical, verbatim excerpts, not a summary]",
      asks.length ? "Earlier requests:\n- " + asks.join("\n- ") : "",
      answers.length ? "Earlier results:\n- " + answers.join("\n- ") : "",
      actions.length
        ? "Actions taken:\n- " + actions.slice(0, 25).join("\n- ")
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    const exuvia = [
      `# molt exuvia — ${new Date().toISOString()}`,
      "",
      "Full, unabridged history shed from context. Re-attach with /regrow.",
      "",
      ...dropped.map((m) => {
        const tools = m.tool_calls?.length
          ? "\n\n```json\n" + JSON.stringify(m.tool_calls, null, 2) + "\n```"
          : "";
        return `## ${m.role}\n\n${m.content ?? ""}${tools}\n`;
      }),
    ].join("\n");

    const prev = this.messages;
    this.messages = [
      this.messages[0],
      { role: "user", content: digest },
      ...kept,
    ];
    const after = this.bom().historyTokens;
    if (after >= before) {
      // Digest would GROW context (tiny sessions). Revert — shedding
      // must only ever shrink. Nothing changed, nothing written.
      this.messages = prev;
      return null;
    }
    return {
      beforeTokens: before,
      afterTokens: after,
      droppedCount: dropped.length,
      exuvia,
    };
  }

  /** Re-attach previously shed context (or any text) as a user message. */
  attach(text: string): void {
    this.messages.push({
      role: "user",
      content: "[re-attached shed context]\n" + text,
    });
  }

  /** Preflight: is the endpoint reachable, and is the model actually there? */
  async doctor(): Promise<{ ok: boolean; detail: string }> {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const base = this.cfg.baseUrl.replace(/\/$/, "");
    try {
      const res = await fetchFn(`${base}/models`, {
        headers: this.cfg.apiKey
          ? { authorization: `Bearer ${this.cfg.apiKey}` }
          : {},
      });
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status} from ${base}/models` };
      const json = (await res.json().catch(() => null)) as {
        data?: { id?: string }[];
      } | null;
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

  /**
   * One isolated, tool-less completion against an arbitrary model —
   * the primitive behind /race. Fresh context; does not touch the session.
   */
  async probe(
    prompt: string,
    model = this.cfg.model,
  ): Promise<
    | { ok: true; text: string; promptTokens: number; completionTokens: number; ms: number }
    | { ok: false; error: string }
  > {
    const fetchFn = this.cfg.fetchFn ?? fetch;
    const t0 = Date.now();
    try {
      const res = await fetchFn(
        `${this.cfg.baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.cfg.apiKey
              ? { authorization: `Bearer ${this.cfg.apiKey}` }
              : {}),
          },
          body: JSON.stringify({
            model,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              { role: "user", content: prompt },
            ],
          }),
        },
      );
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null } }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = json.choices?.[0]?.message?.content ?? "";
      return {
        ok: true,
        text,
        promptTokens: json.usage?.prompt_tokens ?? estTokens(prompt),
        completionTokens: json.usage?.completion_tokens ?? estTokens(text),
        ms: Date.now() - t0,
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }
}
