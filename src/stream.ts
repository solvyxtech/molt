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
  content?: string;
  tool_calls?: {
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }[];
};

export type StreamChunk = {
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

export type StreamResult = {
  message: Msg;
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;
};

/**
 * Accumulates deltas into a complete assistant message. Stateful on purpose:
 * the caller feeds chunks as they arrive and can render partial content
 * between calls.
 */
export class StreamAccumulator {
  private content = "";
  private calls = new Map<number, { id: string; name: string; args: string }>();
  promptTokens?: number;
  completionTokens?: number;
  finishReason?: string;

  /** Returns the text added by this chunk, for incremental rendering. */
  push(chunk: StreamChunk): string {
    if (chunk.usage) {
      if (typeof chunk.usage.prompt_tokens === "number") this.promptTokens = chunk.usage.prompt_tokens;
      if (typeof chunk.usage.completion_tokens === "number") {
        this.completionTokens = chunk.usage.completion_tokens;
      }
    }

    const choice = chunk.choices?.[0];
    if (!choice) return "";
    if (choice.finish_reason) this.finishReason = choice.finish_reason;

    const delta = choice.delta;
    if (!delta) return "";

    let added = "";
    if (typeof delta.content === "string" && delta.content.length > 0) {
      this.content += delta.content;
      added = delta.content;
    }

    for (const tc of delta.tool_calls ?? []) {
      // Some providers omit `index` when there is exactly one call.
      const index = typeof tc.index === "number" ? tc.index : 0;
      const slot = this.calls.get(index) ?? { id: "", name: "", args: "" };
      if (tc.id) slot.id = tc.id;
      if (tc.function?.name) slot.name += tc.function.name;
      if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
      this.calls.set(index, slot);
    }

    return added;
  }

  /** Text accumulated so far. */
  get text(): string {
    return this.content;
  }

  finish(): StreamResult {
    const tool_calls: ToolCall[] = [...this.calls.entries()]
      .sort((a, b) => a[0] - b[0])
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
      finishReason: this.finishReason,
    };
  }
}

/**
 * Split a raw SSE byte stream into JSON payloads. Handles events arriving
 * mid-line, `[DONE]`, comment lines, and CRLF — all of which appear in the
 * wild across providers.
 */
export class SseParser {
  private buffer = "";
  done = false;

  /** Feed decoded text; returns whole `data:` payloads found so far. */
  push(text: string): string[] {
    this.buffer += text.replace(/\r\n/g, "\n");
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
      if (payload && payload !== "[DONE]") out.push(payload);
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
): Promise<StreamResult> {
  const acc = new StreamAccumulator();
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
        if (added) onText(added, acc.text);
      }
    }
    for (const raw of parser.flush()) {
      try {
        const added = acc.push(JSON.parse(raw) as StreamChunk);
        if (added) onText(added, acc.text);
      } catch {
        /* ignore a truncated trailing frame */
      }
    }
  } finally {
    reader.releaseLock();
  }

  return acc.finish();
}
