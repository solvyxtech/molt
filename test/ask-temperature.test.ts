import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel } from "../src/ask.js";

describe("a model that refuses temperature", () => {
  it("is asked again without it, and the error body is kept for other 400s", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchFn = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      bodies.push(body);
      if ("temperature" in body) {
        return new Response(JSON.stringify({ error: { message: "`temperature` is deprecated for this model." } }), { status: 400 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude-haiku-5-5", system: "s", prompt: "p", fetchFn });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(bodies.length, 2);
    assert.ok(!("temperature" in bodies[1]!));
    // Remembered: the next ask goes straight out without it.
    await askModel({ baseUrl: "https://api.anthropic.com/v1", apiKey: "k", model: "claude-haiku-5-5", system: "s", prompt: "p", fetchFn });
    assert.equal(bodies.length, 3);
    assert.ok(!("temperature" in bodies[2]!));
  });

  it("puts a 400's body in the error", async () => {
    const fetchFn = (async () => new Response("bad tool_choice value", { status: 400 })) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: "https://x.test/v1", model: "m", system: "s", prompt: "p", fetchFn });
    assert.ok(!r.ok && /bad tool_choice/.test(r.error));
  });
});
