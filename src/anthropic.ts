/**
 * Anthropic's native Messages API, as a translation layer.
 *
 * molt speaks one internal dialect — OpenAI-shaped `Msg` objects — and every
 * other module depends on it: the transcript, shedding, the archive, receipts,
 * the journal, the bar. Changing that to accommodate a second provider would
 * put a wire format into the middle of the evidence path, which is the last
 * place it belongs. So the translation happens here, at the edge, and nothing
 * upstream knows there are two protocols.
 *
 * ## Why this exists at all
 *
 * Anthropic publishes an OpenAI-compatible `/chat/completions`, and molt used
 * it. It works — but it **silently discards `cache_control`**. Measured against
 * the live API:
 *
 * | probe                          | /chat/completions | /v1/messages          |
 * |--------------------------------|-------------------|-----------------------|
 * | `cache_control: {type:"bogus"}`| 200, accepted     | 400, names the field   |
 * | `cache_control: {nonsense:1}`  | 200, accepted     | —                      |
 * | cache fields in `usage`        | none, ever        | creation → read, exact |
 * | `anthropic-beta: prompt-caching`| no change        | —                      |
 *
 * A field the endpoint accepts without parsing is a field it is throwing away.
 * So on the compatibility endpoint an agent loop re-reads its whole
 * conversation at full price on every step, for ever — and on a loop that
 * spends 99% of its input budget on re-reads, that is most of the bill.
 *
 * The native API caches properly: the same 20,702-token prefix was written
 * once and read back on every subsequent request.
 */
import type { Msg, ToolCall } from "./types.js";
import { SseParser, type StreamResult, type Usage } from "./stream.js";

/** Anthropic requires this; there is no "unset". Generous, not a target. */
export const DEFAULT_MAX_TOKENS = 8192;

type TextBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: unknown };
type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  cache_control?: { type: "ephemeral" };
};
type Block = TextBlock | ToolUseBlock | ToolResultBlock;
type WireMsg = { role: "user" | "assistant"; content: Block[] };

/** An OpenAI-shaped tool definition, which is what molt holds internally. */
type OpenAITool = {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
};

/** Is this endpoint Anthropic's own API, where the native protocol lives? */
export function isAnthropicNative(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.endsWith("anthropic.com");
  } catch {
    return false;
  }
}

/** `.../v1` → `.../v1/messages`. The native endpoint, not the compat one. */
export function messagesUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, "")}/messages`;
}

export function toolsFor(tools: readonly OpenAITool[]): unknown[] {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    // Same JSON Schema, different key. Anthropic calls it `input_schema`.
    input_schema: t.function.parameters ?? { type: "object", properties: {} },
  }));
}

/**
 * molt's messages, as Anthropic wants them.
 *
 * Three shape differences matter, and each one is silent if you get it wrong:
 *
 *  1. **System is not a message.** It is a top-level field, and leaving it in
 *     `messages` is a 400.
 *  2. **Tool results are user turns.** OpenAI gives each result its own
 *     `role: "tool"` message; Anthropic carries them as `tool_result` blocks
 *     inside a user turn, and every result belonging to one assistant turn has
 *     to arrive in the *same* user message. Emitting one message per result
 *     looks reasonable and is rejected.
 *  3. **Tool calls are content, not a sibling field.** `tool_calls` becomes
 *     `tool_use` blocks alongside the text, in the same array.
 *
 * `cacheAt` is a set of indices into `messages`, from the shared breakpoint
 * planner, so both protocols place their markers the same way.
 */
export function toRequest(
  messages: Omit<Msg, "molt">[],
  tools: readonly OpenAITool[],
  opts: {
    model: string;
    maxTokens?: number;
    stream?: boolean;
    toolChoice?: "auto" | "none";
    cacheAt?: Set<number>;
    cacheSystem?: boolean;
  },
): Record<string, unknown> {
  const system: TextBlock[] = [];
  const out: WireMsg[] = [];

  messages.forEach((m, i) => {
    const mark = opts.cacheAt?.has(i) ? { cache_control: { type: "ephemeral" as const } } : {};

    if (m.role === "system") {
      if (typeof m.content === "string" && m.content) {
        system.push({ type: "text", text: m.content, ...mark });
      }
      return;
    }

    if (m.role === "tool") {
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content: typeof m.content === "string" ? m.content : "",
        ...mark,
      };
      // Fold into the previous user turn when there is one, so all the results
      // for a single assistant turn arrive together.
      const prev = out.at(-1);
      if (prev?.role === "user" && prev.content.every((b) => b.type === "tool_result")) {
        prev.content.push(block);
      } else {
        out.push({ role: "user", content: [block] });
      }
      return;
    }

    if (m.role === "assistant") {
      const content: Block[] = [];
      if (typeof m.content === "string" && m.content) {
        content.push({ type: "text", text: m.content, ...mark });
      }
      for (const call of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(call.function?.arguments || "{}");
        } catch {
          // A malformed argument string is the model's mistake to see, not a
          // reason to drop the call and leave a dangling tool_result.
          input = {};
        }
        content.push({ type: "tool_use", id: call.id, name: call.function?.name ?? "", input });
      }
      // An assistant turn with nothing in it is not a turn Anthropic accepts.
      if (content.length) out.push({ role: "assistant", content });
      return;
    }

    // user
    if (typeof m.content === "string" && m.content) {
      out.push({ role: "user", content: [{ type: "text", text: m.content, ...mark }] });
    }
  });

  return {
    model: opts.model,
    // Required here, unlike the OpenAI shape where it is optional.
    max_tokens: opts.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(system.length ? { system } : {}),
    messages: out,
    tools: toolsFor(tools),
    tool_choice: { type: opts.toolChoice ?? "auto" },
    ...(opts.stream ? { stream: true } : {}),
  };
}

/** Anthropic's `stop_reason`, in the vocabulary molt's loop already speaks. */
export function finishReasonFor(stop: string | null | undefined): string | undefined {
  switch (stop) {
    case "tool_use":
      return "tool_calls";
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    default:
      return stop ?? undefined;
  }
}

export function usageFor(u: Record<string, unknown> | undefined): Usage {
  const n = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const read = n(u?.cache_read_input_tokens) ?? 0;
  const written = n(u?.cache_creation_input_tokens) ?? 0;
  // `input_tokens` is the uncached remainder only. molt's meter means "what
  // this request cost to send", so the cached parts are added back in — a
  // session that reads 40k from cache every step must not read as 14 tokens.
  const input = (n(u?.input_tokens) ?? 0) + read + written;
  return {
    prompt_tokens: input,
    completion_tokens: n(u?.output_tokens) ?? 0,
    ...(read || written ? { prompt_tokens_details: { cached_tokens: read } } : {}),
    cache_read_input_tokens: read,
    cache_creation_input_tokens: written,
  };
}

/** An Anthropic response body, as one of molt's internal messages. */
export function toMessage(json: {
  content?: { type: string; text?: string; id?: string; name?: string; input?: unknown }[];
}): Msg {
  let text = "";
  const tool_calls: ToolCall[] = [];
  for (const b of json.content ?? []) {
    if (b.type === "text") text += b.text ?? "";
    else if (b.type === "tool_use") {
      tool_calls.push({
        id: b.id ?? "",
        type: "function",
        function: { name: b.name ?? "", arguments: JSON.stringify(b.input ?? {}) },
      });
    }
  }
  return {
    role: "assistant",
    content: text.length ? text : null,
    ...(tool_calls.length ? { tool_calls } : {}),
  };
}

/**
 * Accumulates Anthropic's streaming events into a finished message.
 *
 * The event model is block-oriented rather than choice-oriented: a
 * `content_block_start` opens a block, `content_block_delta` extends it, and a
 * tool call's arguments arrive as `input_json_delta` fragments that are only
 * valid JSON once the block closes. Reassembling those per block index is the
 * part that breaks quietly — a half-parsed argument string becomes an empty
 * tool call, and the agent appears to simply not act.
 */
export class NativeAccumulator {
  private text = "";
  private blocks = new Map<number, { type: string; id?: string; name?: string; json: string }>();
  private usage: Record<string, unknown> = {};
  finishReason?: string;

  /** Returns the text added by this event, for incremental rendering. */
  push(ev: Record<string, unknown>): string {
    const type = ev.type as string;

    if (type === "message_start") {
      const m = ev.message as { usage?: Record<string, unknown> } | undefined;
      if (m?.usage) this.usage = { ...this.usage, ...m.usage };
      return "";
    }
    if (type === "content_block_start") {
      const i = ev.index as number;
      const b = ev.content_block as { type: string; id?: string; name?: string };
      this.blocks.set(i, { type: b.type, id: b.id, name: b.name, json: "" });
      return "";
    }
    if (type === "content_block_delta") {
      const i = ev.index as number;
      const d = ev.delta as { type: string; text?: string; partial_json?: string };
      if (d.type === "text_delta" && d.text) {
        this.text += d.text;
        return d.text;
      }
      if (d.type === "input_json_delta") {
        const slot = this.blocks.get(i);
        if (slot) slot.json += d.partial_json ?? "";
      }
      return "";
    }
    if (type === "message_delta") {
      const d = ev.delta as { stop_reason?: string } | undefined;
      if (d?.stop_reason) this.finishReason = finishReasonFor(d.stop_reason);
      if (ev.usage) this.usage = { ...this.usage, ...(ev.usage as Record<string, unknown>) };
      return "";
    }
    return "";
  }

  finish(): StreamResult {
    const tool_calls: ToolCall[] = [];
    for (const [, b] of [...this.blocks.entries()].sort((a, x) => a[0] - x[0])) {
      if (b.type !== "tool_use") continue;
      tool_calls.push({
        id: b.id ?? "",
        type: "function",
        // An empty argument stream is `{}`, not the empty string — which is
        // not valid JSON and would surface as a parse error the model cannot
        // act on.
        function: { name: b.name ?? "", arguments: b.json || "{}" },
      });
    }
    const u = usageFor(this.usage);
    return {
      message: {
        role: "assistant",
        content: this.text.length ? this.text : null,
        ...(tool_calls.length ? { tool_calls } : {}),
      },
      promptTokens: u.prompt_tokens,
      completionTokens: u.completion_tokens,
      cachedTokens: u.cache_read_input_tokens,
      cacheWriteTokens: u.cache_creation_input_tokens,
      finishReason: this.finishReason,
    };
  }
}

/** Read a native SSE stream to completion, reporting text as it arrives. */
export async function readNativeStream(
  body: ReadableStream<Uint8Array>,
  onText: (fragment: string, accumulated: string) => void,
): Promise<StreamResult> {
  const acc = new NativeAccumulator();
  const parser = new SseParser();
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const feed = (raw: string): void => {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const added = acc.push(ev);
    if (added) onText(added, "");
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const raw of parser.push(decoder.decode(value, { stream: true }))) feed(raw);
    }
    for (const raw of parser.flush()) feed(raw);
  } finally {
    reader.releaseLock();
  }
  return acc.finish();
}
