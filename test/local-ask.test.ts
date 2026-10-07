/**
 * Short questions and thinking control against a self-hosted server.
 *
 * The NUC's llama.cpp went on generating a non-streamed ask after Maat had
 * timed out or cancelled it, so the one slot stayed busy for minutes; a
 * streamed request is stopped when the client disconnects. And Qwen3.8 spent
 * 5,700 reasoning tokens (ten minutes) on one question because
 * `reasoning: {effort}` means nothing to llama.cpp. Mock providers only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel } from "../src/ask.js";
import { Engine } from "../src/engine.js";
import { selfHostedThinking } from "../src/providers.js";
import { allowAll, drain, workspace } from "./helpers.js";

const LOCAL = "http://127.0.0.1:8080/v1";
const CLOUD = "https://openrouter.ai/api/v1";

function sse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}
const delta = (d: object, finish: string | null = null) => ({ choices: [{ delta: d, finish_reason: finish }] });

function capture(reply: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_u: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return reply();
  }) as unknown as typeof fetch;
  return { bodies, fetchFn };
}

describe("an ask to a self-hosted server", () => {
  it("is streamed, and returns the answer text without the reasoning", async () => {
    const { bodies, fetchFn } = capture(() =>
      sse([delta({ reasoning_content: "hmm, " }), delta({ reasoning_content: "let me think" }), delta({ content: '{"a":' }), delta({ content: "1}" }, "stop")]),
    );
    const r = await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn });
    assert.deepEqual(r, { ok: true, text: '{"a":1}', cutOff: false });
    assert.equal(bodies[0]!.stream, true);
  });

  it("still reports a cut-off, and retries an empty cut-off reply with a larger ceiling", async () => {
    const ceilings: number[] = [];
    let n = 0;
    const fetchFn = (async (_u: string, init: { body: string }) => {
      ceilings.push(JSON.parse(init.body).max_tokens);
      n += 1;
      return n === 1 ? sse([delta({ reasoning_content: "thinking" }, "length")]) : sse([delta({ content: "done" }, "length")]);
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn, maxTokens: 100 });
    assert.deepEqual(r, { ok: true, text: "done", cutOff: true });
    assert.deepEqual(ceilings, [100, 400]);
  });

  it("treats a provider error inside the stream as a failed, retryable request", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return n === 1
        ? sse([{ choices: [], error: { code: 503, message: "Service temporarily overloaded" } }])
        : sse([delta({ content: "ok" }, "stop")]);
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn, overloadBackoffMs: [0] });
    assert.equal(n, 2);
    assert.deepEqual(r, { ok: true, text: "ok", cutOff: false });
    const only = await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", what: "drafting", fetchFn: (async () => sse([{ choices: [], error: { code: 400, message: "bad" } }])) as unknown as typeof fetch });
    assert.match(!only.ok ? only.error : "", /provider error 400: bad \(drafting\)/);
  });

  it("still reads a plain JSON reply from a server that ignores `stream`", async () => {
    const fetchFn = (async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "plain" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    assert.deepEqual(await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn }), { ok: true, text: "plain", cutOff: false });
  });

  it("ends at the timeout while the stream is still open, closing the request", async () => {
    let aborted = false;
    const fetchFn = (async (_u: string, init: { signal?: AbortSignal }) => {
      init.signal?.addEventListener("abort", () => (aborted = true));
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ reasoning_content: "x" }))}\n\n`));
          init.signal?.addEventListener("abort", () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn, timeoutMs: 30 });
    assert.equal(aborted, true);
    assert.match(!r.ok ? r.error : "", /did not answer within/);
  });

  it("sends the template switch for effort none, and nothing extra for low or unset", async () => {
    for (const [effort, want] of [["none", { enable_thinking: false }], ["low", undefined], [undefined, undefined]] as const) {
      const { bodies, fetchFn } = capture(() => sse([delta({ content: "x" }, "stop")]));
      await askModel({ baseUrl: LOCAL, model: "m", system: "s", prompt: "p", fetchFn, ...(effort ? { reasoningEffort: effort } : {}) });
      assert.deepEqual(bodies[0]!.chat_template_kwargs, want);
    }
  });
});

describe("a cloud ask", () => {
  it("is not streamed and carries no template switch", async () => {
    const { bodies, fetchFn } = capture(() => new Response(JSON.stringify({ choices: [{ message: { content: "c" }, finish_reason: "stop" }] })));
    await askModel({ baseUrl: CLOUD, model: "m", system: "s", prompt: "p", fetchFn, reasoningEffort: "none" });
    assert.deepEqual(Object.keys(bodies[0]!), ["model", "messages", "max_tokens", "temperature", "reasoning"]);
  });
});

describe("selfHostedThinking", () => {
  it("is empty off a self-hosted endpoint", () => {
    assert.deepEqual(selfHostedThinking(CLOUD, "none"), {});
    assert.deepEqual(selfHostedThinking(LOCAL, "none"), { chat_template_kwargs: { enable_thinking: false } });
  });
});

describe("the engine's request body", () => {
  const send = async (baseUrl: string, reasoningEffort?: string) => {
    const w = workspace();
    try {
      const { bodies, fetchFn } = capture(() => new Response(JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }), { headers: { "content-type": "application/json" } }));
      const engine = new Engine({ baseUrl, model: "m", cwd: w.dir, fetchFn, stream: false, bar: null, ...(reasoningEffort ? { reasoningEffort } : {}) });
      await drain(engine.run("say hi", allowAll));
      return bodies[0]!;
    } finally {
      w.cleanup();
    }
  };

  it("turns thinking off on a self-hosted server at effort none, keeping the reasoning field", async () => {
    const b = await send(LOCAL, "none");
    assert.deepEqual(b.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual(b.reasoning, { effort: "none" });
  });

  it("leaves a self-hosted body alone at low, and a cloud body alone at none", async () => {
    assert.equal("chat_template_kwargs" in (await send(LOCAL, "low")), false);
    assert.equal("chat_template_kwargs" in (await send(CLOUD, "none")), false);
  });
});
