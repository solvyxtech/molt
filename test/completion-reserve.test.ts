/**
 * A server that counts the completion reserve against its window.
 *
 * GMI Cloud serves qwen/qwen3-235b-a22b-2507 with a 131,072-token TOTAL
 * window. The request carried no max_tokens, the router filled in the model's
 * whole listed output, and even a 2,454-token prompt was refused; Maat then
 * shed history, which cannot fix that, and 11 of 34 runs ended "too large and
 * nothing left to shed". Mock providers only.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { completionOverflow, contextOverflow, Engine, FALLBACK_COMPLETION, fittedCompletion, refusedMaxTokens, reserveFallback } from "../src/engine.js";
import { outputCeiling } from "../src/anthropic.js";
import { allowAll, drain, workspace } from "./helpers.js";

const GMI =
  `{"object":"error","message":"Requested token count exceeds the model's maximum context length of 131072 tokens. ` +
  `You requested a total of 133526 tokens: 2454 tokens from the input messages and 131072 tokens for the completion. ` +
  `Please reduce the number of tokens in the input messages or the completion to fit within the limit.","type":"BadRequestError","param":null,"code":400}`;

const gmiBody = (input: number, completion: number) =>
  GMI.replace("133526", String(input + completion)).replace("2454 tokens", `${input} tokens`).replace("131072 tokens for", `${completion} tokens for`);

type Body = { max_tokens?: number; messages: unknown[] };

const okReply = (message: object, finish = "stop") =>
  ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message, finish_reason: finish }], usage: { prompt_tokens: 900, completion_tokens: 20 } }),
    text: async () => "",
  }) as unknown as Response;
const refused = (text: string) => ({ ok: false, status: 400, text: async () => text, json: async () => ({}) }) as unknown as Response;

function engineWith(dir: string, fetchFn: typeof fetch, over: Record<string, unknown> = {}): Engine {
  return new Engine({ baseUrl: "http://provider.test/v1", model: "m", provider: "test", cwd: dir, bar: null, stream: false, fetchFn, retryBackoffMs: [5, 5, 5], ...over });
}

describe("reading a completion-reserve overflow", () => {
  it("reads the window, the input and the completion out of the GMI body", () => {
    assert.deepEqual(completionOverflow(GMI), { window: 131072, input: 2454, completion: 131072 });
    // The older OpenAI/vLLM wording too.
    assert.deepEqual(
      completionOverflow("This model's maximum context length is 32768 tokens. However, you requested 34000 tokens (1232 in the messages, 32768 in the completion)."),
      { window: 32768, input: 1232, completion: 32768 },
    );
    assert.equal(completionOverflow('{"n_ctx":16384,"n_prompt_tokens":17222}'), null);
    // contextOverflow's "sent" is the prompt's count, the number Maat's estimate is compared with.
    assert.deepEqual(contextOverflow(GMI), { window: 131072, sent: 2454 });
  });

  it("fits the completion when lowering it alone is enough, and says no when the prompt is the problem", () => {
    const fit = fittedCompletion({ window: 131072, input: 2454, completion: 131072 });
    assert.ok(fit !== null && fit >= 1024 && fit <= 131072 - 2454 - 256, String(fit));
    assert.equal(fittedCompletion({ window: 131072, input: 130500, completion: 32768 }), null);
  });

  it("knows a refused max_tokens field and more output-ceiling wordings", () => {
    assert.equal(refusedMaxTokens("Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), true);
    assert.equal(refusedMaxTokens(GMI), false);
    assert.equal(outputCeiling("max_tokens is too large: 32768. This model supports at most 16384 completion tokens, whereas you provided 32768."), 16384);
    assert.equal(outputCeiling("Invalid max_tokens value, the valid range of max_tokens is [1, 8192]"), 8192);
  });
});

/** Each provider's own refusal for a 1000-token prompt and a 32768 cap on a 32768 window. */
const OPENROUTER = (input: number, completion: number) =>
  `{"error":{"message":"This endpoint's maximum context length is 32768 tokens. However, you requested about ${input + completion} tokens ` +
  `(${input - 100} of text input, 100 of tool input, ${completion} in the output). Please reduce the length of either one, ` +
  `or use the \"middle-out\" transform to compress your prompt automatically.","code":400}}`;
const VLLM_NEW = (input: number, completion: number) =>
  `{"object":"error","message":"This model's maximum context length is 32768 tokens. However, you requested ${completion} output tokens ` +
  `and your prompt contains ${input} input tokens, for a total of ${input + completion} tokens. Please reduce the length of the input ` +
  `prompt or the number of requested output tokens.","type":"BadRequestError","param":null,"code":400}`;
const VLLM_OLD = (input: number, completion: number) =>
  `{"object":"error","message":"'max_tokens' or 'max_completion_tokens' is too large: ${completion}. This model's maximum context ` +
  `length is 32768 tokens and your request has ${input} input tokens (${completion} > 32768 - ${input}).","type":"BadRequestError","param":null,"code":400}`;
const OPENAI = (input: number, completion: number) =>
  `{"error":{"message":"This model's maximum context length is 32768 tokens. However, you requested ${input + completion} tokens ` +
  `(${input - 200} in the messages, 200 in the functions, ${completion} in the completion). Please reduce the length of the messages, functions, or completion.",` +
  `"type":"invalid_request_error","param":"messages","code":"context_length_exceeded"}}`;
const ANTHROPIC = (input: number, completion: number) =>
  `{"type":"error","error":{"type":"invalid_request_error","message":"input length and \`max_tokens\` exceed context limit: ${input} + ${completion} > 32768, ` +
  `decrease input length or \`max_tokens\` and try again"}}`;
const LLAMACPP = (input: number) =>
  `{"error":{"code":400,"message":"the request exceeds the available context size, try increasing it","type":"exceed_context_size_error",` +
  `"n_prompt_tokens":${input},"n_ctx":32768}}`;

describe("each provider's refusal wording", () => {
  for (const [name, make] of [
    ["OpenRouter", OPENROUTER],
    ["vLLM (current)", VLLM_NEW],
    ["vLLM 0.8-0.16", VLLM_OLD],
    ["OpenAI", OPENAI],
    ["Anthropic", ANTHROPIC],
  ] as const) {
    it(`${name}: reads the window, the prompt and the completion, and the prompt is what contextOverflow reports`, () => {
      const body = make(1000, 32768);
      assert.deepEqual(completionOverflow(body), { window: 32768, input: 1000, completion: 32768 });
      assert.deepEqual(contextOverflow(body), { window: 32768, sent: 1000 }, "never the output count as sent");
      assert.equal(refusedMaxTokens(body), false, "the field itself was not refused");
      const fit = fittedCompletion(completionOverflow(body)!);
      assert.ok(fit !== null && fit <= 32768 - 1000 - 256 && fit >= 1024, String(fit));
    });
  }

  it("TGI: reads `inputs` + `max_new_tokens` must be <= N", () => {
    const body = "Input validation error: `inputs` tokens + `max_new_tokens` must be <= 4096. Given: 1000 `inputs` tokens and 32768 `max_new_tokens`";
    assert.deepEqual(completionOverflow(body), { window: 4096, input: 1000, completion: 32768 });
  });

  it("llama.cpp: a prompt overflow, not a reserve one — shed, no smaller cap", () => {
    const body = LLAMACPP(40000);
    assert.equal(completionOverflow(body), null);
    assert.deepEqual(contextOverflow(body), { window: 32768, sent: 40000 });
    assert.equal(reserveFallback(body, 32768, 100), null, "the prompt alone does not fit");
  });

  it("Anthropic: a prompt that is too long by itself is read as a prompt overflow", () => {
    const body = `{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 210000 tokens > 200000 maximum"}}`;
    assert.equal(completionOverflow(body), null);
    assert.deepEqual(contextOverflow(body), { window: 200000, sent: 210000 });
    assert.equal(reserveFallback(body, 32768, 100), null);
  });

  it("an unknown window wording with a large cap gets one smaller cap to try; a small cap or an unrelated 400 does not", () => {
    assert.equal(reserveFallback("Error: prompt + max_tokens exceeds the context length of this model", 32768, 1000), FALLBACK_COMPLETION);
    // A window it named, with a prompt count it did not: fitted from molt's own estimate.
    const g = reserveFallback("maximum context length is 32768 tokens; reduce your request", 32768, 1000);
    assert.ok(g !== null && g <= 16384 && g >= 1024, String(g));
    assert.equal(reserveFallback("Error: prompt + max_tokens exceeds the context length of this model", 4096, 1000), null);
    assert.equal(reserveFallback('{"error":{"message":"invalid tool_choice"}}', 32768, 1000), null);
  });

  it("refusedMaxTokens is as narrow as its comment: naming both fields is not a refusal of the field", () => {
    assert.equal(refusedMaxTokens("max_tokens / max_completion_tokens must be <= 4096"), false);
    assert.equal(refusedMaxTokens(VLLM_OLD(1000, 32768)), false);
    assert.equal(refusedMaxTokens(`{"error":{"message":"Unrecognized request argument supplied: max_tokens"}}`), true);
  });
});

/** A server with a 32768 window that counts the reserve against it, refusing in `wording`. */
function reserveServer(wording: (input: number, completion: number) => string, input = 1000) {
  const bodies: Body[] = [];
  let refusals = 0;
  const fetchFn = (async (_u: string, init?: RequestInit) => {
    const b = JSON.parse(String(init?.body ?? "{}")) as Body;
    bodies.push(b);
    const asked = b.max_tokens ?? 32768 - input;
    if (asked + input > 32768) {
      refusals++;
      return refused(wording(input, asked));
    }
    return okReply({ role: "assistant", content: "answered." });
  }) as unknown as typeof fetch;
  return { fetchFn, bodies, refusals: () => refusals };
}

describe("turn 1 against each provider's wording", () => {
  for (const [name, make] of [
    ["OpenRouter", OPENROUTER],
    ["vLLM (current)", VLLM_NEW],
    ["vLLM 0.8-0.16", VLLM_OLD],
    ["OpenAI", OPENAI],
    ["Anthropic wording", ANTHROPIC],
    ["an unknown wording", (i: number, c: number) => `{"error":{"message":"prompt (${i}) + max_tokens (${c}) exceeds the context length of this model"}}`],
  ] as const) {
    it(`${name}: answers on turn 1 with a smaller cap, no shed, max_tokens still sent`, async () => {
      const ws = workspace();
      try {
        const srv = reserveServer(make);
        const engine = engineWith(ws.dir, srv.fetchFn);
        const events = await drain(engine.run("say hi", allowAll));
        assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("answered.")), "the turn answered");
        assert.equal(events.filter((e) => e.kind === "shed").length, 0, "nothing was shed");
        assert.equal(srv.refusals(), 1);
        assert.equal(srv.bodies[0]!.max_tokens, 32768);
        const second = srv.bodies[1]!.max_tokens;
        assert.ok(second !== undefined && second < 32768 - 1000 && second >= 1024, String(second));
        assert.deepEqual(srv.bodies[1]!.messages, srv.bodies[0]!.messages, "the same history went again");
        // The next turn does not pay the refusal again.
        await drain(engine.run("again", allowAll));
        assert.equal(srv.refusals(), 1);
      } finally {
        ws.cleanup();
      }
    });
  }

  it("llama.cpp: a prompt overflow sheds, and is not answered with a smaller cap", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "big.txt"), "x".repeat(6000));
      const bodies: Body[] = [];
      let refusals = 0;
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
        if (bodies.length <= 5) {
          return okReply(
            { role: "assistant", content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name: "read_file", arguments: '{"path":"big.txt"}' } }] },
            "tool_calls",
          );
        }
        if (refusals < 1) {
          refusals++;
          return refused(LLAMACPP(40000));
        }
        return okReply({ role: "assistant", content: "fitted." });
      }) as unknown as typeof fetch;
      const events = await drain(engineWith(ws.dir, fetchFn).run("read it a few times then answer", allowAll));
      assert.equal(refusals, 1);
      assert.ok(events.some((e) => e.kind === "shed"), "the history was shed");
      assert.equal(bodies.at(-1)!.max_tokens, 32768, "max_tokens unchanged");
      assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("fitted.")));
    } finally {
      ws.cleanup();
    }
  });

  it("a smaller cap that is refused too is forgotten, and the refusal goes on to the shed path", async () => {
    const ws = workspace();
    try {
      const bodies: Body[] = [];
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
        if (bodies.length <= 2) return refused(`{"error":{"message":"prompt + max_tokens exceeds the context length of this model"}}`);
        return okReply({ role: "assistant", content: "ok." });
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, fetchFn);
      await drain(engine.run("hi", allowAll));
      assert.equal(bodies[1]!.max_tokens, FALLBACK_COMPLETION, "one smaller cap was tried");
      assert.equal(bodies.length, 2, "then the shed path had nothing to shed on turn 1");
      const events = await drain(engine.run("again", allowAll));
      assert.equal(bodies[2]!.max_tokens, 32768, "the guess was not kept");
      assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("ok.")));
    } finally {
      ws.cleanup();
    }
  });
});

describe("a request whose completion reserve overflows", () => {
  it("is sent again with a smaller max_tokens, the same history and no shed, and the cap stays for the session", async () => {
    const ws = workspace();
    try {
      const bodies: Body[] = [];
      let refusals = 0;
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body ?? "{}")) as Body;
        bodies.push(b);
        if ((b.max_tokens ?? 131072) + 2454 > 131072) {
          refusals++;
          return refused(gmiBody(2454, b.max_tokens ?? 131072));
        }
        return okReply({ role: "assistant", content: "answered." });
      }) as unknown as typeof fetch;
      // As the router did: the model's full listed output.
      const engine = engineWith(ws.dir, fetchFn, { maxTokens: 131072 });
      const events = await drain(engine.run("say hi", allowAll));
      assert.equal(refusals, 1);
      assert.equal(bodies.length, 2);
      assert.equal(bodies[0]!.max_tokens, 131072);
      assert.ok(bodies[1]!.max_tokens! <= 131072 - 2454 - 256 && bodies[1]!.max_tokens! >= 1024, String(bodies[1]!.max_tokens));
      assert.deepEqual(bodies[1]!.messages, bodies[0]!.messages, "the same history went again");
      assert.equal(events.filter((e) => e.kind === "shed").length, 0, "nothing was shed");
      assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("answered.")));
      // Remembered: the next turn does not pay the refusal again.
      await drain(engine.run("again", allowAll));
      assert.equal(refusals, 1);
      assert.equal(bodies[2]!.max_tokens, bodies[1]!.max_tokens);
    } finally {
      ws.cleanup();
    }
  });

  it("a real history overflow still sheds, and leaves max_tokens alone", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "big.txt"), "x".repeat(6000));
      const bodies: Body[] = [];
      let refusals = 0;
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
        if (bodies.length <= 5) {
          return okReply(
            { role: "assistant", content: null, tool_calls: [{ id: `c${bodies.length}`, type: "function", function: { name: "read_file", arguments: '{"path":"big.txt"}' } }] },
            "tool_calls",
          );
        }
        if (refusals < 1) {
          refusals++;
          return refused(gmiBody(130500, 32768));
        }
        return okReply({ role: "assistant", content: "fitted." });
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, fetchFn);
      const events = await drain(engine.run("read it a few times then answer", allowAll));
      assert.equal(refusals, 1);
      assert.ok(events.some((e) => e.kind === "shed"), "the history was shed");
      assert.equal(bodies.at(-1)!.max_tokens, bodies[0]!.max_tokens, "max_tokens unchanged");
      assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("fitted.")));
    } finally {
      ws.cleanup();
    }
  });
});

describe("the default output cap", () => {
  it("is not the model's whole listed output, and doubles only when a reply hits it", async () => {
    const ws = workspace();
    try {
      const bodies: Body[] = [];
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
        return bodies.length === 1
          ? okReply({ role: "assistant", content: "a long answer that stops mid" }, "length")
          : okReply({ role: "assistant", content: "word. Done." });
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, fetchFn);
      const events = await drain(engine.run("write", allowAll));
      assert.equal(bodies[0]!.max_tokens, 32768);
      assert.equal(bodies[1]!.max_tokens, 65536);
      // The cap the reply hit, not the doubled one, in the nudge the model reads and the info line.
      assert.ok(JSON.stringify(bodies[1]!.messages).includes("output ceiling of 32768 tokens"));
      assert.ok(!JSON.stringify(bodies[1]!.messages).includes("output ceiling of 65536"));
      assert.ok(events.some((e) => e.kind === "info" && e.text.includes("cut off at the 32768-token output ceiling")));
      // A new model starts from the default again.
      engine.setModel("other");
      await drain(engine.run("again", allowAll));
      assert.equal(bodies.at(-1)!.max_tokens, 32768);
    } finally {
      ws.cleanup();
    }
  });

  it("a provider that refuses the field gets requests without it", async () => {
    const ws = workspace();
    try {
      const bodies: Body[] = [];
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body ?? "{}")) as Body;
        bodies.push(b);
        return "max_tokens" in b
          ? refused(`{"error":{"message":"Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}`)
          : okReply({ role: "assistant", content: "ok." });
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, fetchFn);
      const events = await drain(engine.run("hi", allowAll));
      assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("ok.")));
      assert.equal("max_tokens" in bodies.at(-1)!, false);
      // The next turn does not pay the refusal again.
      const before = bodies.length;
      await drain(engine.run("again", allowAll));
      assert.equal(bodies.length, before + 1);
      assert.equal("max_tokens" in bodies.at(-1)!, false);
    } finally {
      ws.cleanup();
    }
  });

  it("a retry without the field that also fails puts max_tokens back", async () => {
    const ws = workspace();
    try {
      const bodies: Body[] = [];
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")) as Body);
        if (bodies.length <= 2) return refused(`{"error":{"message":"Unrecognized request argument supplied: max_tokens"}}`);
        return okReply({ role: "assistant", content: "ok." });
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, fetchFn);
      await drain(engine.run("hi", allowAll));
      assert.equal("max_tokens" in bodies[1]!, false, "tried once without");
      await drain(engine.run("again", allowAll));
      assert.equal(bodies.at(-1)!.max_tokens, 32768, "and put it back when that failed too");
    } finally {
      ws.cleanup();
    }
  });
});
