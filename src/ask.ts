/**
 * One short question to the model, with no tools, on whatever backend is
 * configured.
 *
 * Three things in molt need this — drafting criteria, the interview, and
 * planning a mission — and each had grown its own copy of the same four
 * branches: HTTP endpoint or an ACP agent (Grok Build). Two
 * copies of a transport is two places for the next backend to be missed,
 * which is the both-surfaces bug in a different coat. This is the one place.
 *
 * Deliberately not a turn. No tools, a small token ceiling, temperature
 * zero, and one reply. What is asked for here is a structured answer a
 * person or a gate will read, never work.
 */
import { acpAgentFor, acpAsk } from "./acp.js";
import { isOpencode, opencodeAsk } from "./opencode.js";
import { removedSubscriptionProblem } from "./endpoint.js";
import { errorText } from "./format.js";
import { authHeaders, isSelfHosted, selfHostedThinking, openRouterProvider } from "./providers.js";
import { LONG_RATE_LIMIT_MS, longQuotaText, providerErrorText, rateLimitResetAt, readStream, transientProviderError, untilText, type ProviderError } from "./stream.js";
import { askError, askTimeoutMs, localSpeed, probeSignal } from "./watchdog.js";
import { takeTurn } from "./localgate.js";

/**
 * Pauses before asking again when the provider said it is overloaded or
 * rate-limited — inside a 200 (`{"error":{"code":503,...}}`) or as a 429/503.
 * Read as a reply, that error was an empty answer: on a free model the critic
 * "could not review" two drafts in five and the reviewer abstained.
 */
export const ASK_OVERLOAD_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];

export type AskOptions = {
  baseUrl: string;
  apiKey?: string;
  model: string;
  system: string;
  prompt: string;
  /** Output ceiling. Small: this is one structured answer. */
  maxTokens?: number;
  /** See EngineConfig.reasoningEffort. Sent only when set. */
  reasoningEffort?: string;
  /** Where the question is asked from. The subprocess transports read it. */
  cwd?: string;
  /** What is being asked, for the error message: "drafting criteria". */
  what?: string;
  fetchFn?: typeof fetch;
  acpSpawn?: typeof import("node:child_process").spawn;
  /** The CLI runner for the opencode ask path. Tests only. */
  cliRun?: (cmd: string, args: string[], opts: object) => Promise<{ stdout: string }>;
  timeoutMs?: number;
  /**
   * The run's time budget, as an epoch ms. No ask, retry or pause waits past
   * it: each ask's allowance is cut to what is left, and none starts after.
   */
  deadlineAt?: number;
  /** Pauses between asks after an overloaded provider (ASK_OVERLOAD_BACKOFF_MS). Tests only. */
  overloadBackoffMs?: number[];
  /**
   * The session's latency learner (Engine.askLatency). A completed ask to a
   * cloud endpoint records how long it took, so the first stall of the engine's
   * own requests is judged against what this provider has shown the drafter
   * and the critic, not the full fixed allowance: three samples are needed
   * before the learner tightens anything, and the drafter supplies two or
   * three before the first step. Never recorded for a self-hosted server.
   */
  latency?: { record(w: { firstProgressMs: number | undefined; maxGapMs: number }): void };
};

export type Asked = { ok: true; text: string; cutOff: boolean } | { ok: false; error: string; transient?: true };

/**
 * The output ceiling for one ask, unless the caller says otherwise.
 *
 * It was 500, sized for the JSON the drafter wants. A reasoning model spends
 * the ceiling before it writes a word: Mercury 2.5, asked for three criteria,
 * used 491 tokens thinking and returned an empty reply with `finish_reason:
 * length`, and every headless run drafted nothing. Hidden reasoning is billed
 * against the same ceiling as the answer, so the ceiling has to hold both.
 */
export const ASK_MAX_TOKENS = 2_000;

/** How much larger the retry is when a reply came back empty at the ceiling. */
export const ASK_RETRY_FACTOR = 4;
/** The most a cut-off retry asks for, whatever the first ceiling was. */
export const ASK_RETRY_MAX_TOKENS = ASK_MAX_TOKENS * ASK_RETRY_FACTOR * 2;

/** Milliseconds left before `deadlineAt`, or undefined when there is none. */
function leftMs(deadlineAt: number | undefined): number | undefined {
  return deadlineAt === undefined ? undefined : deadlineAt - Date.now();
}

/** The answer when the time budget is spent before an ask could be made. */
function outOfTime(opts: AskOptions): Asked {
  return { ok: false, error: `the time budget ran out${opts.what ? ` before ${opts.what}` : ""}` };
}

/** Endpoint+model pairs that refused `temperature`; asked without it from then on. */
const noTemperature = new Set<string>();

/** Forget which endpoints refused `temperature` (tests). */
export function resetAskMemo(): void {
  noTemperature.clear();
}

/** A 400 body that refuses the `temperature` setting itself. */
export function refusesTemperature(body: string): boolean {
  const msg = errorMessageOf(body);
  return /temperature/i.test(msg) && /deprecated|not supported|unsupported|does not support|doesn't support|not allowed|only supports|cannot be set|is not available/i.test(msg);
}

/**
 * What a 400 says, for the error text: the provider's own `error.message` when
 * the body is JSON, else its first 300 characters. Not the whole body: some
 * gateways echo the request, and the request holds the hidden checks.
 */
export function errorMessageOf(body: string): string {
  try {
    const o = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof o.error === "string" ? o.error : typeof o.error?.message === "string" ? o.error.message : typeof o.message === "string" ? o.message : undefined;
    if (m !== undefined) return m.slice(0, 300);
  } catch {
    /* not JSON */
  }
  return body.slice(0, 300);
}

export async function askModel(opts: AskOptions): Promise<Asked> {
  const pauses = opts.overloadBackoffMs ?? ASK_OVERLOAD_BACKOFF_MS;
  if ((leftMs(opts.deadlineAt) ?? 1) <= 0) return outOfTime(opts);
  let asked = await askSized(opts);
  for (let i = 0; i < pauses.length && !asked.ok && asked.transient; i++) {
    // A pause that would end past the budget is not taken: the ask after it
    // could not be waited for anyway.
    const left = leftMs(opts.deadlineAt);
    if (left !== undefined && left <= (pauses[i] ?? 0)) break;
    await new Promise((r) => setTimeout(r, pauses[i]));
    asked = await askSized(opts);
  }
  return asked;
}

async function askSized(opts: AskOptions): Promise<Asked> {
  const first = await askOnce(opts, opts.maxTokens ?? ASK_MAX_TOKENS);
  // Empty AND cut off means the model spent the whole ceiling reasoning and
  // never started the answer. Once, with room: a model that empties a four
  // times larger ceiling the same way is not going to answer, and the second
  // failure says exactly that instead of "the reply was empty".
  // Cut off with text written is retried the same way: a draft of exact,
  // edge-case checks is longer than the ceiling allowed for, and half a JSON
  // reply proposes nothing (2026-10-07: 3 of 20 runs drafted no checks).
  if (first.ok && first.cutOff && (leftMs(opts.deadlineAt) ?? 1) > 0) {
    const asked = opts.maxTokens ?? ASK_MAX_TOKENS;
    // Never past ASK_RETRY_MAX_TOKENS: a caller that already asks for a large
    // ceiling (a reference check's 16k) would ask for 64k, which many
    // providers refuse with a 400, and which holds a self-hosted server's
    // only slot for hours.
    const bigger = Math.min(asked * ASK_RETRY_FACTOR, Math.max(asked, ASK_RETRY_MAX_TOKENS));
    if (bigger <= asked) return first;
    const second = await askOnce(opts, bigger);
    // A retry that failed outright says less than the first reply did: keep
    // the clear "cut off at the token limit" result for the caller.
    if (!second.ok && first.text.trim() !== "") return first;
    if (second.ok && second.cutOff && second.text.trim() === "") {
      return {
        ok: false,
        error:
          `the model spent its whole ${bigger}-token ceiling reasoning and wrote nothing, twice` +
          (opts.what ? ` while ${opts.what}` : "") +
          " — pick a model that answers, or raise --max-tokens",
      };
    }
    return second;
  }
  return first;
}

async function askOnce(opts: AskOptions, maxTokens: number): Promise<Asked> {
  // Sized from this question's own prompt, and at local-hardware rates for a
  // self-hosted server (watchdog.ts localSpeed): the NUC's drafter timed out
  // on a fixed 2,000-token guess and a laptop's rates, and sealed nothing.
  const sized = askTimeoutMs(maxTokens, opts.timeoutMs, {
    promptTokens: Math.ceil((opts.system.length + opts.prompt.length) / 4),
    ...(isSelfHosted(opts.baseUrl) ? { speed: localSpeed() } : {}),
  });
  // Never past the run's time budget, whichever transport answers. A limit
  // of 0 means "none" to every transport below, so a spent budget is refused
  // here rather than passed on as 0.
  const left = leftMs(opts.deadlineAt);
  if (left !== undefined && left <= 0) return outOfTime(opts);
  const limitMs = left === undefined ? sized : sized > 0 ? Math.min(sized, left) : left;

  const removed = removedSubscriptionProblem(opts.baseUrl);
  if (removed) return { ok: false, error: removed };

  if (isOpencode(opts.baseUrl)) {
    const asked = await opencodeAsk({
      timeoutMs: limitMs,
      deadlineAt: opts.deadlineAt,
      model: opts.model,
      systemPrompt: opts.system,
      prompt: opts.prompt,
      ...(opts.cliRun ? { run: opts.cliRun } : {}),
    });
    if (asked.ok) return { ok: true, text: asked.text, cutOff: false };
    return { ok: false, error: longQuotaText(asked.error) ?? asked.error, ...(asked.transient ? { transient: true as const } : {}) };
  }

  const acp = acpAgentFor(opts.baseUrl);
  if (acp) {
    const asked = await acpAsk({
      timeoutMs: limitMs,
      spec: acp,
      model: opts.model,
      systemPrompt: opts.system,
      prompt: opts.prompt,
      cwd: opts.cwd,
      ...(opts.acpSpawn ? { spawnFn: opts.acpSpawn } : {}),
    });
    if (asked.ok) return { ok: true, text: asked.text, cutOff: false };
    return { ok: false, error: longQuotaText(asked.error) ?? asked.error };
  }

  const f = opts.fetchFn ?? fetch;
  const base = opts.baseUrl.replace(/\/$/, "");
  // One request at a time to a self-hosted server, and the timeout below
  // starts only once this one has its turn (src/localgate.ts).
  const release = await takeTurn(base);
  // A self-hosted server is asked with a streamed request. llama.cpp keeps
  // generating a non-streamed request after the client has gone: on the NUC
  // every ask Maat timed out or cancelled went on holding the only slot for
  // minutes, with nobody to read the answer. It stops a streamed request when
  // the connection closes. The reply is the same text either way; reasoning
  // deltas are read and dropped. The timeout is unchanged: still one bound on
  // the whole answer.
  const stream = isSelfHosted(base);
  const sentAt = Date.now();
  try {
    const res = await f(`${base}/chat/completions`, {
      method: "POST",
      signal: probeSignal(limitMs),
      headers: { "content-type": "application/json", ...authHeaders(base, opts.apiKey) },
      body: JSON.stringify({
        model: opts.model,
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.prompt },
        ],
        max_tokens: maxTokens,
        ...(noTemperature.has(`${base} ${opts.model}`) ? {} : { temperature: 0 }),
        ...(opts.reasoningEffort ? { reasoning: { effort: opts.reasoningEffort } } : {}),
        ...selfHostedThinking(base, opts.reasoningEffort),
        ...openRouterProvider(base, opts.model),
        ...(stream ? { stream: true } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // Some models refuse a sampling setting outright ("`temperature` is
      // deprecated for this model"). Remember it and ask again without,
      // rather than leaving every judge call on that model refused. Only a
      // refusal of the setting: a validation error that merely echoes the
      // request (and so the word) is not one.
      if (res.status === 400 && refusesTemperature(body) && !noTemperature.has(`${base} ${opts.model}`)) {
        noTemperature.add(`${base} ${opts.model}`);
        // Give the turn back first: a self-hosted server allows one request
        // at a time (localgate.ts), and the retry would wait on this one.
        release();
        return askOnce(opts, maxTokens);
      }
      const resetAt = res.status === 429 ? rateLimitResetAt(body) : undefined;
      if (resetAt !== undefined && resetAt - Date.now() > LONG_RATE_LIMIT_MS) {
        return { ok: false, error: `the provider's rate limit is reached ${untilText(resetAt)}${opts.what ? ` (${opts.what})` : ""}` };
      }
      return { ok: false, error: `HTTP ${res.status}${opts.what ? ` ${opts.what}` : ""}${res.status === 400 && body ? `: ${errorMessageOf(body)}` : ""}`, ...(res.status === 429 || res.status === 503 ? { transient: true } : {}) };
    }
    type Reply = {
      choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
      error?: ProviderError;
    };
    let content: string;
    let finish: string | null | undefined;
    let error: ProviderError | undefined;
    // A server that was sent `stream: true` and answers with plain JSON (a
    // proxy that buffers, or an error body) is read as JSON, as it always was.
    if (stream && res.body && /text\/event-stream/i.test(res.headers.get("content-type") ?? "")) {
      const done = await readStream(res.body, () => {});
      content = done.message.content ?? "";
      finish = done.finishReason;
      error = done.error;
    } else {
      const json = (await res.json()) as Reply;
      content = json.choices?.[0]?.message?.content ?? "";
      finish = json.choices?.[0]?.finish_reason;
      error = json.error && typeof json.error === "object" ? json.error : undefined;
    }
    if (error) {
      const resetAt = rateLimitResetAt({ error });
      if (resetAt !== undefined && resetAt - Date.now() > LONG_RATE_LIMIT_MS) {
        return { ok: false, error: `the provider's rate limit is reached ${untilText(resetAt)}${opts.what ? ` (${opts.what})` : ""}` };
      }
      return { ok: false, error: `${providerErrorText(error)}${opts.what ? ` (${opts.what})` : ""}`, ...(transientProviderError(error) ? { transient: true } : {}) };
    }
    // The answer is small and read whole, so the time it took is both the wait
    // for the first byte and the longest silence: the slow end of what this
    // provider does, which is what the learner wants to know.
    if (!stream && opts.latency) {
      const took = Date.now() - sentAt;
      opts.latency.record({ firstProgressMs: took, maxGapMs: took });
    }
    return { ok: true, text: content, cutOff: finish === "length" };
  } catch (e) {
    return { ok: false, error: askError(e, limitMs, errorText) };
  } finally {
    release();
  }
}

/**
 * The JSON object in a reply, or null.
 *
 * Models fence their JSON whatever the instructions say, and sometimes
 * preface it. Anything before the first `{` and after the last `}` is
 * discarded; what is between them must parse.
 */
export function jsonIn(text: string): Record<string, unknown> | null {
  const body = text.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "").trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    const raw: unknown = JSON.parse(body.slice(start, end + 1));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Why a reply could not be used, said the way the drafter always said it. */
export function notJson(text: string, cutOff: boolean, noun = "draft"): string {
  const said = text.trim().replace(/\s+/g, " ");
  return (
    `the ${noun} reply was not JSON, so nothing was proposed` +
    (cutOff ? " — it was cut off at the token limit" : "") +
    (said ? `: "${said.slice(0, 80)}${said.length > 80 ? "…" : ""}"` : ": the reply was empty")
  );
}
