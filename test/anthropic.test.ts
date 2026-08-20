/**
 * Anthropic's native Messages API.
 *
 * molt reached Anthropic through its OpenAI-compatible endpoint until that
 * endpoint was measured: it **accepts `cache_control` and throws it away**.
 * `{"type":"bogus"}` returns 200 there and 400 on the native API, and no
 * response from the compatibility layer has ever carried a cache field. A
 * field accepted without being parsed is a field being discarded — so an agent
 * loop on that endpoint re-reads its whole conversation at full price on every
 * step, for ever.
 *
 * These pin the translation between molt's internal OpenAI-shaped messages and
 * the native wire. Every difference below is one that fails silently or
 * confusingly if it is wrong.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  NativeAccumulator,
  finishReasonFor,
  isAnthropicNative,
  messagesUrl,
  readNativeStream,
  toMessage,
  toRequest,
  toolsFor,
  usageFor,
} from "../src/anthropic.js";
import { anthropicPricing } from "../src/providers.js";
import type { Msg } from "../src/types.js";

const TOOLS = [
  {
    type: "function" as const,
    function: {
      name: "read_file",
      description: "Read a text file.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
];

type Wire = {
  system?: { type: string; text: string; cache_control?: unknown }[];
  messages: { role: string; content: { type: string; [k: string]: unknown }[] }[];
  tools: { name: string; input_schema: unknown }[];
  max_tokens: number;
  tool_choice: { type: string };
};

describe("choosing the protocol", () => {
  it("uses the native API for Anthropic and the compatible one elsewhere", () => {
    assert.equal(isAnthropicNative("https://api.anthropic.com/v1"), true);
    assert.equal(isAnthropicNative("https://openrouter.ai/api/v1"), false);
    assert.equal(isAnthropicNative("https://api.x.ai/v1"), false);
    assert.equal(isAnthropicNative("not a url"), false);
    assert.equal(messagesUrl("https://api.anthropic.com/v1"), "https://api.anthropic.com/v1/messages");
    assert.equal(messagesUrl("https://api.anthropic.com/v1/"), "https://api.anthropic.com/v1/messages");
  });
});

describe("molt's messages, as Anthropic wants them", () => {
  const conversation: Omit<Msg, "molt">[] = [
    { role: "system", content: "the system prompt" },
    { role: "user", content: "read both files" },
    {
      role: "assistant",
      content: "Reading them now.",
      tool_calls: [
        { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
        { id: "c2", type: "function", function: { name: "read_file", arguments: '{"path":"b.txt"}' } },
      ],
    },
    { role: "tool", tool_call_id: "c1", content: "alpha" },
    { role: "tool", tool_call_id: "c2", content: "beta" },
  ];

  const wire = (): Wire =>
    toRequest(conversation, TOOLS, { model: "claude-sonnet-5" }) as unknown as Wire;

  it("lifts the system prompt out of the message list", () => {
    // It is a top-level field here. Leaving it among the messages is a 400.
    const w = wire();
    assert.equal(w.system?.[0]?.text, "the system prompt");
    assert.ok(
      !w.messages.some((m) => m.role === "system"),
      "left the system prompt in the message list, which the API rejects",
    );
  });

  it("carries tool results as one user turn, not one turn each", () => {
    // OpenAI gives every result its own `role: "tool"` message. Anthropic wants
    // every result belonging to a single assistant turn inside the *same* user
    // message — emitting one per result looks reasonable and is rejected.
    const w = wire();
    const results = w.messages.filter((m) => m.content.some((b) => b.type === "tool_result"));
    assert.equal(results.length, 1, `split tool results across ${results.length} turns`);
    assert.equal(results[0]!.role, "user", "tool results must arrive as a user turn");
    assert.deepEqual(
      results[0]!.content.map((b) => b.tool_use_id),
      ["c1", "c2"],
      "lost a result, or reordered them away from their calls",
    );
  });

  it("turns tool calls into content blocks beside the text", () => {
    const w = wire();
    const asst = w.messages.find((m) => m.role === "assistant")!;
    assert.deepEqual(
      asst.content.map((b) => b.type),
      ["text", "tool_use", "tool_use"],
      "the assistant turn did not carry its text and both calls together",
    );
    const [, first] = asst.content;
    assert.equal(first!.name, "read_file");
    // Arguments are an object here, not the JSON string OpenAI uses.
    assert.deepEqual(first!.input, { path: "a.txt" });
  });

  it("renames the tool schema without changing it", () => {
    const t = toolsFor(TOOLS)[0] as { name: string; input_schema: unknown };
    assert.equal(t.name, "read_file");
    assert.deepEqual(t.input_schema, TOOLS[0]!.function.parameters, "the schema itself changed");
  });

  it("always sends max_tokens, which this API requires", () => {
    assert.ok(wire().max_tokens > 0);
    const custom = toRequest(conversation, TOOLS, { model: "m", maxTokens: 4096 }) as unknown as Wire;
    assert.equal(custom.max_tokens, 4096);
  });

  it("sends tool_choice as an object", () => {
    assert.deepEqual(wire().tool_choice, { type: "auto" });
    const none = toRequest(conversation, TOOLS, { model: "m", toolChoice: "none" }) as unknown as Wire;
    assert.deepEqual(none.tool_choice, { type: "none" }, "the salvage could not ask for no tools");
  });

  it("puts cache breakpoints where it is asked to, and nowhere else", () => {
    const marked = toRequest(conversation, TOOLS, {
      model: "m",
      cacheAt: new Set([0, 4]),
    }) as unknown as Wire;
    assert.ok(marked.system?.[0]?.cache_control, "the system prompt carries no breakpoint");
    const results = marked.messages.find((m) => m.content.some((b) => b.type === "tool_result"))!;
    assert.ok(results.content.at(-1)!.cache_control, "the tip of the conversation is unmarked");

    const plain = wire();
    assert.ok(!plain.system?.[0]?.cache_control, "marked the prompt when nothing asked for it");
  });

  it("does not send an assistant turn with nothing in it", () => {
    // A content-less turn is not one the API accepts.
    const w = toRequest(
      [{ role: "assistant", content: null }, { role: "user", content: "hi" }],
      TOOLS,
      { model: "m" },
    ) as unknown as Wire;
    assert.ok(w.messages.every((m) => m.content.length > 0));
  });

  it("keeps a malformed tool call rather than dropping it", () => {
    // Dropping it would leave the following tool_result pointing at nothing,
    // which is a 400 about a dangling id rather than the model's own mistake.
    const w = toRequest(
      [
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c9", type: "function", function: { name: "bash", arguments: "{not json" } }],
        },
      ],
      TOOLS,
      { model: "m" },
    ) as unknown as Wire;
    const call = w.messages[0]!.content[0]!;
    assert.equal(call.type, "tool_use");
    assert.equal(call.id, "c9");
  });
});

describe("Anthropic's answers, in molt's terms", () => {
  it("reads text and tool calls back out of the content blocks", () => {
    const m = toMessage({
      content: [
        { type: "text", text: "Looking now." },
        { type: "tool_use", id: "c1", name: "read_file", input: { path: "a.txt" } },
      ],
    });
    assert.equal(m.content, "Looking now.");
    assert.equal(m.tool_calls?.[0]?.id, "c1");
    // molt holds arguments as a JSON string, the way the rest of it expects.
    assert.equal(m.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
  });

  it("translates stop reasons into the ones the loop already handles", () => {
    assert.equal(finishReasonFor("tool_use"), "tool_calls");
    assert.equal(finishReasonFor("end_turn"), "stop");
    assert.equal(finishReasonFor("max_tokens"), "length");
  });

  it("reports the whole prompt, not just the uncached remainder", () => {
    // `input_tokens` is what was *not* served from cache. A meter that showed
    // only that would report a session reading 40k from cache every step as
    // having sent 14 tokens — which reads as a bug in the meter, and hides the
    // one number that proves caching is working.
    const u = usageFor({
      input_tokens: 14,
      cache_read_input_tokens: 20702,
      cache_creation_input_tokens: 0,
      output_tokens: 4,
    });
    assert.equal(u.prompt_tokens, 20716);
    assert.equal(u.completion_tokens, 4);
    assert.equal(u.prompt_tokens_details?.cached_tokens, 20702);
  });

  it("counts a cache write as prompt tokens too", () => {
    const u = usageFor({ input_tokens: 14, cache_creation_input_tokens: 20702, output_tokens: 4 });
    assert.equal(u.prompt_tokens, 20716);
    assert.equal(u.cache_creation_input_tokens, 20702);
  });
});

describe("the native stream", () => {
  /** The event sequence the API actually sends, as an SSE body. */
  function sse(events: unknown[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream({
      start(c) {
        for (const e of events) c.enqueue(enc.encode(`event: x\ndata: ${JSON.stringify(e)}\n\n`));
        c.close();
      },
    });
  }

  it("reassembles text and a tool call split across frames", async () => {
    // Tool arguments arrive as `input_json_delta` fragments that are only valid
    // JSON once the block closes. Reassembling them per block index is the part
    // that breaks quietly: a half-parsed argument string becomes an empty call
    // and the agent appears to simply not act.
    const got: string[] = [];
    const result = await readNativeStream(
      sse([
        { type: "message_start", message: { usage: { input_tokens: 10, cache_read_input_tokens: 90 } } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Reading " } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the file." } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "c1", name: "read_file" } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"pa' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'th":"a.' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: 'txt"}' } },
        { type: "content_block_stop", index: 1 },
        { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } },
        { type: "message_stop" },
      ]),
      (f) => got.push(f),
    );

    assert.equal(result.message.content, "Reading the file.");
    assert.equal(got.join(""), "Reading the file.", "the text did not arrive incrementally");
    assert.equal(result.message.tool_calls?.length, 1);
    assert.equal(result.message.tool_calls?.[0]?.function.arguments, '{"path":"a.txt"}');
    assert.equal(result.finishReason, "tool_calls");
    // Usage arrives split across message_start and message_delta.
    assert.equal(result.completionTokens, 7);
    assert.equal(result.cachedTokens, 90);
    assert.equal(result.promptTokens, 100);
  });

  it("gives an argument-less call valid JSON rather than an empty string", () => {
    const acc = new NativeAccumulator();
    acc.push({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "c1", name: "ls" } });
    const out = acc.finish();
    assert.equal(
      out.message.tool_calls?.[0]?.function.arguments,
      "{}",
      "an empty stream became an empty string, which is not JSON the loop can parse",
    );
  });

  it("keeps two tool calls apart when their fragments interleave", async () => {
    const result = await readNativeStream(
      sse([
        { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "a", name: "read_file" } },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "b", name: "bash" } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"path":' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"command":' } },
        { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '"a.txt"}' } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"ls"}' } },
        { type: "message_delta", delta: { stop_reason: "tool_use" } },
      ]),
      () => {},
    );
    const calls = result.message.tool_calls ?? [];
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.function.arguments, '{"path":"a.txt"}');
    assert.equal(calls[1]!.function.arguments, '{"command":"ls"}');
  });
});

describe("what an Anthropic session costs", () => {
  it("knows the published rates, since there is no endpoint to ask", () => {
    // Every other provider molt talks to publishes a price list. Anthropic does
    // not, so the meter read "no price for this model" on precisely the
    // endpoint where caching does the most work.
    const sonnet = anthropicPricing("claude-sonnet-5")!;
    assert.equal(sonnet.in, 3);
    assert.equal(sonnet.out, 15);
    // A cache read is a tenth of input — the whole reason the native protocol
    // was worth writing.
    assert.equal(sonnet.cached, 0.3);

    assert.equal(anthropicPricing("claude-opus-5")!.in, 5);
    assert.equal(anthropicPricing("claude-haiku-4-5")!.out, 5);
    assert.equal(anthropicPricing("claude-fable-5")!.in, 10);
    // Reached through a router, the model is still the model.
    assert.equal(anthropicPricing("anthropic/claude-sonnet-5")!.in, 3);
    // And nothing else is guessed at.
    assert.equal(anthropicPricing("grok-4.6"), null);
    assert.equal(anthropicPricing("gpt-5"), null);
  });
});
