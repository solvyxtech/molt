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
import { completionOverflow, contextOverflow, Engine, fittedCompletion, refusedMaxTokens } from "../src/engine.js";
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
      await drain(engine.run("write", allowAll));
      assert.equal(bodies[0]!.max_tokens, 32768);
      assert.equal(bodies[1]!.max_tokens, 65536);
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
      const events = await drain(engineWith(ws.dir, fetchFn).run("hi", allowAll));
      assert.ok(events.some((e) => e.kind === "assistant_text" && e.text.includes("ok.")));
      assert.equal("max_tokens" in bodies.at(-1)!, false);
    } finally {
      ws.cleanup();
    }
  });
});
