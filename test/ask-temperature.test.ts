import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel, errorMessageOf, refusesTemperature, resetAskMemo } from "../src/ask.js";

const REFUSED = JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } });
const ok = (text: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
const sse = (text: string) =>
  new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

describe("a model that refuses temperature", () => {
  it("is asked again without it, and remembered", async () => {
    resetAskMemo();
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      return "temperature" in body ? new Response(REFUSED, { status: 400 }) : ok("{\"ok\":true}");
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: "https://judge.test/v1", apiKey: "k", model: "judge-model", system: "s", prompt: "p", fetchFn });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(bodies.length, 2);
    assert.ok(!("temperature" in bodies[1]!));
    // Remembered: the next ask goes straight out without it.
    await askModel({ baseUrl: "https://judge.test/v1", apiKey: "k", model: "judge-model", system: "s", prompt: "p", fetchFn });
    assert.equal(bodies.length, 3);
    assert.ok(!("temperature" in bodies[2]!));
  });

  it("on a self-hosted server with one slot, the retry does not wait on its own first request", async () => {
    resetAskMemo();
    let calls = 0;
    const fetchFn = (async (_url: string, init: { body: string }) => {
      calls++;
      const body = JSON.parse(init.body) as Record<string, unknown>;
      return "temperature" in body ? new Response(REFUSED, { status: 400 }) : sse("fine");
    }) as unknown as typeof fetch;
    const r = await Promise.race([
      askModel({ baseUrl: "http://localhost:59999/v1", model: "local-model", system: "s", prompt: "p", fetchFn }),
      new Promise<"hung">((res) => setTimeout(() => res("hung"), 5_000)),
    ]);
    assert.notEqual(r, "hung", "the retry deadlocked on the local slot");
    assert.ok(r !== "hung" && r.ok, JSON.stringify(r));
    assert.equal(calls, 2);
  });

  it("only a refusal of the setting counts, not a body that echoes the request", () => {
    assert.ok(refusesTemperature(REFUSED));
    assert.ok(refusesTemperature("temperature is not supported with this model"));
    assert.ok(!refusesTemperature(JSON.stringify({ detail: [{ msg: "field required", input: { temperature: 0, max_tokens: 5 } }] })));
  });

  it("puts a 400's own message in the error, not an echoed request", async () => {
    const fetchFn = (async () => new Response("bad tool_choice value", { status: 400 })) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: "https://x.test/v1", model: "m", system: "s", prompt: "p", fetchFn });
    assert.ok(!r.ok && /bad tool_choice/.test(r.error));
    assert.equal(errorMessageOf(JSON.stringify({ error: { message: "nope" }, request: { messages: ["SECRET CHECK"] } })), "nope");
  });
});
