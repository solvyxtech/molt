/**
 * Server-Sent Events parsing for streamed completions.
 *
 * Kept in its own module, free of network and React, because the part that
 * breaks is not the transport — it is delta reassembly. Tool call arguments
 * arrive split across arbitrary chunk boundaries:
 *
 *   {"index":0,"function":{"arguments":"{\"path\":\"src/a"}}
 *   {"index":0,"function":{"arguments":"uth.ts\"}"}}
 *
 * Reassemble by `index` or you get malformed JSON, which fails silently as
 * an empty tool call — the agent appears to do nothing and no error is
 * raised. That is why this is tested against split points chosen to be
 * hostile rather than convenient.
 */
import type { Msg, ToolCall } from "./types.js";

export type StreamDelta = {
  /** A string, or — from a few providers — a list of `{type: "text", text}` parts. */
  content?: string | { type?: string; text?: string }[];
  /**
   * The model's reasoning, where the server streams it apart from the answer.
   * DeepSeek, llama.cpp and vLLM say `reasoning_content`; OpenRouter says
   * `reasoning`. Neither is ever part of the message.
   */
  reasoning_content?: string;
  reasoning?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    /** `arguments` is a JSON string by contract; some servers send the object itself. */
    function?: { name?: string; arguments?: string | Record<string, unknown> };
  }[];
};

/** Text of a `content` field, whether it came as a string or as a list of text parts. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (typeof p === "string" ? p : p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .join("");
}

/** Arguments as the string the wire format promises: an object is serialised, nothing becomes "". */
function argsText(a: unknown): string {
  if (typeof a === "string") return a;
  if (a && typeof a === "object") return JSON.stringify(a);
  return "";
}

/**
 * A non-streamed assistant message, made to say what it means.
 *
 * Three drifts, each unambiguous and each otherwise silent:
 *  - `arguments` as an object. `JSON.parse(object)` reads "[object Object]",
 *    so the call was refused as invalid JSON the model never wrote — and the
 *    object, kept in the transcript, is then rejected by the next request.
 *  - A missing or repeated tool-call id. Results are matched to calls by id;
 *    two calls sharing one cannot be answered separately, and strict
 *    providers refuse the whole conversation.
 *  - `content` as a list of text parts, which `.trim()` throws on.
 */
export function normalizeMessage(msg: Msg): Msg {
  const out: Msg = { ...msg };
  if (out.content !== null && typeof out.content !== "string") out.content = contentText(out.content) || null;
  if (Array.isArray(msg.tool_calls)) {
    const used = new Set<string>();
    out.tool_calls = msg.tool_calls.map((c, i) => {
      let id = typeof c.id === "string" && c.id ? c.id : "";
      for (let n = 0; !id || used.has(id); n++) id = `call_${i}${n ? `_${n}` : ""}`;
      used.add(id);
      return { ...c, id, type: "function" as const, function: { ...c.function, name: c.function?.name ?? "", arguments: argsText(c.function?.arguments) } };
    });
  }
  return out;
}

/**
 * The usage block, as the OpenAI-compatible providers actually send it.
 *
 * `prompt_tokens` alone is not enough to price a turn. Cached prompt tokens
 * bill at a fraction of the standard rate, so a session that reuses context
 * — which is every agent session — is over-billed on paper by a meter that
 * ignores the itemisation. `cost` appears on providers that resell (notably
 * OpenRouter) and is the only figure here that needs no arithmetic at all.
 */
export type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  /**
   * Anthropic's own names for the same two facts.
   *
   * Its compatibility layer is not guaranteed to translate them into
   * `prompt_tokens_details`, and a meter that reads only the OpenAI shape
   * would report a perfectly working cache as 0% — which reads as "caching is
   * broken" and invites someone to go and break something that was fine.
   * Cheap to accept both.
   */
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  /** USD, as billed by the provider. Present on some, absent on most. */
  cost?: number;
};

export type StreamChunk = {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: Usage;
  /**
   * A provider error delivered inside a 200 stream. OpenRouter does this when
   * the upstream is overloaded: `choices: []` and `error: {code: 503, ...}`,
   * then the stream ends. Read as a chunk with no delta it became an empty
   * assistant message, which cost a step and drew the empty-turn nudge
   * instead of a retry — on a free model that was half of all requests.
   */
  error?: ProviderError;
};

export type ProviderError = { code?: number | string; message?: string; metadata?: { error_type?: string } };

/**
 * Whether a provider error is worth asking again: overload, rate limit,
 * timeout, or any 5xx. A 400/401/403-shaped error is about the request or
 * the key and will not change.
 */
export function transientProviderError(e: ProviderError): boolean {
  const code = Number(e.code);
  if (code === 408 || code === 429 || (code >= 500 && code < 600)) return true;
  return /overload|rate.?limit|temporar|timeout|unavailable|capacity/i.test(`${e.message ?? ""} ${e.metadata?.error_type ?? ""}`);
}

/**
 * When a rate limit lifts, as epoch ms, from a provider's error body.
 *
 * OpenRouter's free tier answers its daily cap with a 429 whose body carries
 * `metadata.headers["X-RateLimit-Reset"]` (epoch ms) and a message naming
 * the limit ("free-models-per-day-high-balance"). Retrying that for two
 * minutes buys nothing: on 2026-10-05 eleven local tasks per arm spent 140 s
 * each retrying a limit that lifted at midnight UTC, and recorded as failed
 * work what was a closed door.
 */
export function rateLimitResetAt(body: unknown): number | undefined {
  let j: unknown = body;
  if (typeof body === "string") {
    try {
      j = JSON.parse(body);
    } catch {
      return undefined;
    }
  }
  const e = (j as { error?: { metadata?: { headers?: Record<string, unknown> } } } | undefined)?.error ?? (j as { metadata?: { headers?: Record<string, unknown> } });
  const raw = e?.metadata?.headers?.["X-RateLimit-Reset"] ?? e?.metadata?.headers?.["x-ratelimit-reset"];
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/**
 * When a quota lifts, from a CLI's plain-text error rather than an HTTP body.
 *
 * A subscription CLI answers an exhausted plan with text like `RESOURCE_EXHAUSTED (code 429):
 * Individual quota reached ... Resets in 3h16m8s` (OpenCode: `Free usage limit reached. Rate limit: resets in 3h20m`). It is the same closed door
 * as OpenRouter's daily cap — nothing inside a turn gets past it — and was
 * treated as an ordinary task error. Returns epoch ms, or undefined when the
 * text is not a quota error that says when it resets.
 */
export function quotaResetAt(text: string, now = Date.now()): number | undefined {
  if (!/RESOURCE_EXHAUSTED|quota (?:reached|exceeded|exhausted)|rate.?limit/iu.test(text)) return undefined;
  const m = /resets?\s+in\s+((?:\d+\s*d(?:ays?)?\s*)?(?:\d+\s*h(?:ours?)?\s*)?(?:\d+\s*m(?:in(?:ute)?s?)?\s*)?(?:\d+(?:\.\d+)?\s*s(?:ec(?:ond)?s?)?)?)/iu.exec(text);
  if (!m || !m[1].trim()) return undefined;
  const part = (u: string) => Number(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*${u}`, "iu").exec(m[1])?.[1] ?? 0);
  const ms = ((part("d") * 24 + part("h")) * 60 + part("m")) * 60_000 + part("s") * 1000;
  return ms > 0 ? now + ms : undefined;
}

/** A rate limit that lifts later than a turn can sensibly wait: five minutes. */
export const LONG_RATE_LIMIT_MS = 5 * 60_000;

/** "until 17:00", in local time, for a limit that lifts at `at`. */
export function untilText(at: number): string {
  const d = new Date(at);
  const hm = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at - Date.now() > 20 * 3_600_000 ? `until ${d.toLocaleString()}` : `until ${hm}`;
}

/**
 * The one-line report for a CLI error that is a long quota wall, or null for
 * any other error. Same phrase as the HTTP path's, so a harness that stops on
 * "rate limit is reached until" stops on this too.
 */
export function longQuotaText(err: string, now = Date.now()): string | null {
  const at = quotaResetAt(err, now);
  if (at === undefined || at - now <= LONG_RATE_LIMIT_MS) return null;
  return `the provider's rate limit is reached ${untilText(at)} — ${err.replace(/\s+/g, " ").slice(0, 300)}`;
}

/** One line naming a provider error, for the log and the retry notice. */
export function providerErrorText(e: ProviderError): string {
  return `provider error${e.code !== undefined ? ` ${e.code}` : ""}: ${(e.message ?? "no message").slice(0, 300)}`;
}

export type StreamResult = {
  message: Msg;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Tokens written to the cache this request, billed above the base rate. */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  finishReason?: string;
  /** The first provider error the stream carried, if any (see StreamChunk.error). */
  error?: ProviderError;
};

/**
 * Accumulates deltas into a complete assistant message. Stateful on purpose:
 * the caller feeds chunks as they arrive and can render partial content
 * between calls.
 */
export class StreamAccumulator {
  private content = "";
  /** Names announced already, so a call is never reported twice. */
  private announced = new Set<number>();
  /** Names seen and not yet drained. */
  private pending: string[] = [];
  /**
   * Calls in the order they began. Keyed by an internal sequence rather than
   * the provider's `index`, because `index` is not reliable: some servers omit
   * it, some send 0 for every call, and a Map keyed by it fuses two calls into
   * one — `write_file` + `write_file` became a single call with two JSON
   * objects as its arguments.
   */
  private calls = new Map<number, { id: string; name: string; args: string; index: number }>();
  private byIndex = new Map<number, number>();
  private byId = new Map<string, number>();
  private lastKey: number | undefined;
  /** Reasoning fragments seen and not yet drained. Never part of the message. */
  private thoughts: string[] = [];
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;
  /** Tokens written to the cache this request, billed above the base rate. */
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  finishReason?: string;
  error?: ProviderError;

  /** Returns the text added by this chunk, for incremental rendering. */
  push(chunk: StreamChunk): string {
    if (chunk.error && typeof chunk.error === "object" && !this.error) this.error = chunk.error;
    if (chunk.usage) {
      const u = chunk.usage;
      if (typeof u.prompt_tokens === "number") this.promptTokens = u.prompt_tokens;
      if (typeof u.completion_tokens === "number") this.completionTokens = u.completion_tokens;
      // Itemisation arrives in the same frame as the totals, or not at all.
      // Absent is absent: left undefined rather than defaulted to zero, so a
      // provider that does not itemise cannot be read as one that cached
      // nothing.
      if (typeof u.prompt_tokens_details?.cached_tokens === "number") {
        this.cachedTokens = u.prompt_tokens_details.cached_tokens;
      } else if (typeof u.cache_read_input_tokens === "number") {
        this.cachedTokens = u.cache_read_input_tokens;
      }
      if (typeof u.cache_creation_input_tokens === "number") {
        this.cacheWriteTokens = u.cache_creation_input_tokens;
      }
      if (typeof u.completion_tokens_details?.reasoning_tokens === "number") {
        this.reasoningTokens = u.completion_tokens_details.reasoning_tokens;
      }
      if (typeof u.cost === "number") this.costUsd = u.cost;
    }

    const choice = chunk.choices?.[0];
    if (!choice) return "";
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return "";

    const thought = delta.reasoning_content ?? delta.reasoning;
    if (typeof thought === "string" && thought.length > 0) this.thoughts.push(thought);

    let added = "";
    const said = contentText(delta.content);
    if (said.length > 0) {
      this.content += said;
      added = said;
    }

    for (const tc of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const named = typeof tc.index === "number" ? tc.index : undefined;
      const id = typeof tc.id === "string" ? tc.id : "";
      // Which call this fragment belongs to. A repeated id is the same call;
      // a new id is a new call whatever `index` says; with neither, the
      // fragment continues the call before it (the one-call case, where
      // providers omit `index`).
      let key = id ? this.byId.get(id) : undefined;
      if (key === undefined && named !== undefined) {
        const k = this.byIndex.get(named);
        const there = k === undefined ? undefined : this.calls.get(k);
        if (there && (!id || !there.id || there.id === id)) key = k;
      }
      if (key === undefined && !id && named === undefined) key = this.lastKey;
      if (key === undefined && id && named === undefined && this.lastKey !== undefined && !this.calls.get(this.lastKey)!.id) key = this.lastKey;
      if (key === undefined) {
        key = this.calls.size;
        this.calls.set(key, { id: "", name: "", args: "", index: named ?? key });
      }
      const index = key;
      if (named !== undefined) this.byIndex.set(named, key);
      if (id) this.byId.set(id, key);
      this.lastKey = key;
      const slot = this.calls.get(key)!;
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) {
        // Assemble the name across fragments — `"write"` then `"_file"` must
        // become `"write_file"` — but not across re-sends. Some providers
        // split the name over deltas; aggregation/adaptor layers instead
        // re-deliver the whole tool-call shape on later deltas, and appending
        // that would turn `read_file` into `read_fileread_file`. A fragment
        // extends the name; a re-send is already a suffix of it, so appending
        // only when the new part is not already a suffix covers both.
        if (!slot.name.endsWith(tc.function.name)) {
          slot.name += tc.function.name;
        }
        // The first moment anyone can know a tool is coming.
        //
        // A step streams its narration, then its tool calls, and until now the
        // window showed the prose and then nothing until the call completed.
        // That gap is where a person decides whether the model is working or
        // waffling — and three runs in one session were cancelled inside it,
        // one of them three seconds before `list_files` would have fired. The
        // name is known here, several hundred milliseconds before the call is
        // complete, so it is announced here — once per call, not per chunk.
        if (!this.announced.has(index)) {
          this.announced.add(index);
          this.pending.push(slot.name);
        }
      }
      slot.args += argsText(tc.function?.arguments);
    }

    return added;
  }

  /** Text accumulated so far. */
  /** Reasoning fragments since the last call, oldest first. */
  drainThoughts(): string[] {
    if (this.thoughts.length === 0) return [];
    const out = this.thoughts;
    this.thoughts = [];
    return out;
  }

  get text(): string {
    return this.content;
  }

  /**
   * Tool names seen since the last time this was asked, and cleared by asking.
   *
   * Drained rather than read so a caller polling between chunks reports each
   * name once. The alternative — a flag the caller inspects — announces the
   * same call on every subsequent chunk of its arguments.
   */
  drainPending(): string[] {
    if (this.pending.length === 0) return [];
    const out = [...this.pending];
    this.pending.length = 0;
    return out;
  }

  finish(): StreamResult {
    const tool_calls: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[1].index - b[1].index || a[0] - b[0])
      .map(([index, slot], i) => ({
        id: slot.id || `call_${index}_${i}`,
        type: "function" as const,
        function: { name: slot.name, arguments: slot.args },
      }));

    const message: Msg = {
      role: "assistant",
      content: this.content.length > 0 ? this.content : null,
      ...(tool_calls.length ? { tool_calls } : {}),
    };

    return {
      message,
      promptTokens: this.promptTokens,
      completionTokens: this.completionTokens,
      cachedTokens: this.cachedTokens,
      ...(this.cacheWriteTokens !== undefined ? { cacheWriteTokens: this.cacheWriteTokens } : {}),
      reasoningTokens: this.reasoningTokens,
      costUsd: this.costUsd,
      finishReason: this.finishReason,
      ...(this.error ? { error: this.error } : {}),
    };
  }
}

/**
 * Split a raw SSE byte stream into JSON payloads. Handles events arriving
 * mid-line, `[DONE]`, comment lines, and CRLF or bare-CR line endings — all of
 * which appear in the wild across providers.
 */
export class SseParser {
  private buffer = "";
  done = false;

  /** Feed decoded text; returns whole `data:` payloads found so far. */
  push(text: string): string[] {
    // Normalize CRLF *and* bare CR to LF. The SSE spec terminates a line with
    // `\r`, `\n`, or `\r\n`, and an event with a blank line that may be `\r\r`,
    // `\n\n`, `\r\n\r\n`, or `\n\r`. Collapsing every CR to LF folds all four
    // event separators onto the single `\n\n` this parser splits on — otherwise
    // a `\r`-terminated stream is silently dropped, taking whole events with
    // the line terminator it uses.
    this.buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const out: string[] = [];

    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const event = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue; // comments, `event:`, ignored
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          this.done = true;
          continue;
        }
        if (payload) out.push(payload);
      }
    }
    return out;
  }

  /** Any trailing event not terminated by a blank line. */
  flush(): string[] {
    if (!this.buffer.trim()) return [];
    const rest = this.buffer;
    this.buffer = "";
    const out: string[] = [];
    for (const line of rest.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") this.done = true;
      else if (payload) out.push(payload);
    }
    return out;
  }
}

/**
 * Read a streamed response to completion, calling `onText` with each
 * fragment. Malformed chunks are skipped rather than fatal — a provider
 * emitting one bad frame should not lose an otherwise good turn.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  onText: (fragment: string, accumulated: string) => void,
  /**
   * Called once with the accumulator, before the first byte is read.
   *
   * The caller needs it to drain pending tool names mid-stream: the model
   * names a tool several hundred milliseconds before its arguments finish, and
   * that is the earliest anyone can say the model is about to act rather than
   * merely talk.
   */
  onStart?: (acc: StreamAccumulator) => void,
  /** Reasoning fragments, as they arrive. Absent, they are read and dropped. */
  onThought?: (fragment: string) => void,
): Promise<StreamResult> {
  const acc = new StreamAccumulator();
  onStart?.(acc);
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const payloads = parser.push(decoder.decode(value, { stream: true }));
      for (const raw of payloads) {
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(raw) as StreamChunk;
        } catch {
          continue;
        }
        const added = acc.push(chunk);
        for (const t of acc.drainThoughts()) onThought?.(t);
        if (added) onText(added, acc.text);
      }
    }
    for (const raw of parser.flush()) {
      try {
        const added = acc.push(JSON.parse(raw) as StreamChunk);
        for (const t of acc.drainThoughts()) onThought?.(t);
        if (added) onText(added, acc.text);
      } catch {
        /* ignore a truncated trailing frame */
      }
    }
  } finally {
    reader.releaseLock();
  }

  // A stream that closes without a `finish_reason` or `[DONE]` was cut off —
  // a dropped connection, a proxy timeout — not finished. Returned as it
  // stood, half a sentence was read as the model's answer (and a call with
  // half its arguments as the model's mistake). An error frame is its own
  // verdict and is handled by the caller.
  if (!acc.finishReason && !parser.done && !acc.error) {
    throw new Error("the stream ended before the model finished (no finish_reason and no [DONE])");
  }

  return acc.finish();
}
