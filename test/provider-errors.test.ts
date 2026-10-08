/**
 * A provider error that arrives inside a 200.
 *
 * OpenRouter's free Nemotron answered half of all requests with HTTP 200 and
 * `{"choices":[],"error":{"code":503,"message":"Upstream error from Nvidia:
 * Service temporarily overloaded"}}` — as a JSON body, and as the only SSE
 * chunk of a stream. Read as a reply, that was an empty assistant message:
 * the turn spent a step on it and nudged the model about an empty reply it
 * never sent, and the critic, reviewer and drafter took the empty text as
 * "could not review". It is a failed request, and is retried like one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel } from "../src/ask.js";
import { Engine } from "../src/engine.js";
import { takeTurn } from "../src/localgate.js";
import { rateLimitResetAt, StreamAccumulator, transientProviderError } from "../src/stream.js";
import type { Msg } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

const OVERLOADED = { code: 503, message: "Upstream error from Nvidia: Service temporarily overloaded", metadata: { error_type: "provider_overloaded" } };

function sseResponse(chunks: unknown[]): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("provider errors inside a 200", () => {
  it("are recorded by the stream accumulator, not read as an empty message", () => {
    const acc = new StreamAccumulator();
    acc.push({ choices: [], error: OVERLOADED });
    const r = acc.finish();
    assert.deepEqual(r.error, OVERLOADED);
    assert.equal(r.message.content, null);
  });

  it("are transient when overloaded, rate-limited or 5xx, and not when the request is wrong", () => {
    assert.equal(transientProviderError(OVERLOADED), true);
    assert.equal(transientProviderError({ code: 429, message: "slow down" }), true);
    assert.equal(transientProviderError({ message: "Rate limit exceeded" }), true);
    assert.equal(transientProviderError({ code: 400, message: "invalid tool schema" }), false);
    assert.equal(transientProviderError({ code: 401, message: "No auth credentials found" }), false);
  });

  it("make a streamed turn retry the request instead of spending a step on an empty reply", async () => {
    const w = workspace();
    try {
      let n = 0;
      const bodies: { messages: Msg[] }[] = [];
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        n += 1;
        bodies.push(JSON.parse(String(init?.body)) as { messages: Msg[] });
        if (n <= 2) return sseResponse([{ choices: [], error: OVERLOADED }]);
        return sseResponse([
          { choices: [{ delta: { content: "the answer" }, finish_reason: null }] },
          { choices: [{ delta: {}, finish_reason: "stop" }] },
        ]);
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: true, bar: null, retryBackoffMs: [0, 0, 0] });
      const events = await drain(engine.run("answer me", allowAll));
      assert.equal(n, 3, "two overloaded requests, then the one that answered");
      const infos = events.filter((e) => e.kind === "info").map((e) => (e as { text: string }).text);
      assert.equal(infos.filter((t) => /provider error 503/.test(t)).length, 2);
      const texts = events.filter((e) => e.kind === "assistant_text").map((e) => (e as { text: string }).text);
      assert.deepEqual(texts, ["the answer"]);
      assert.deepEqual(bodies[2]!.messages.map((m) => m.role), bodies[0]!.messages.map((m) => m.role), "the retry replays the request; no empty assistant message was added");
    } finally {
      w.cleanup();
    }
  });

  it("make an unstreamed turn retry too, and give up on one that is not transient", async () => {
    const w = workspace();
    try {
      let n = 0;
      const fetchFn = (async () => {
        n += 1;
        return new Response(JSON.stringify({ choices: [], error: { code: 400, message: "invalid tool schema" } }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: false, bar: null, retryBackoffMs: [0, 0, 0] });
      const events = await drain(engine.run("answer me", allowAll));
      assert.equal(n, 1, "a request the provider called wrong is not sent again");
      assert.ok(events.some((e) => e.kind === "error" && /invalid tool schema/.test((e as { text: string }).text)));
    } finally {
      w.cleanup();
    }
  });

  it("make a short question ask again after a pause, and say what happened when it never clears", async () => {
    let n = 0;
    const replies = [{ error: OVERLOADED }, { error: OVERLOADED }, { choices: [{ message: { content: '{"ok":1}' }, finish_reason: "stop" }] }];
    const fetchFn = (async () => {
      const body = replies[Math.min(n++, replies.length - 1)];
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: "http://provider.test/v1", model: "m", system: "s", prompt: "p", fetchFn, overloadBackoffMs: [0, 0, 0] });
    assert.deepEqual(r, { ok: true, text: '{"ok":1}', cutOff: false });
    assert.equal(n, 3);

    let m = 0;
    const always = (async () => {
      m += 1;
      return new Response(JSON.stringify({ error: OVERLOADED }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const r2 = await askModel({ baseUrl: "http://provider.test/v1", model: "m", system: "s", prompt: "p", fetchFn: always, what: "reviewing", overloadBackoffMs: [0, 0] });
    assert.equal(r2.ok, false);
    assert.match(!r2.ok ? r2.error : "", /provider error 503: Upstream error from Nvidia/);
    assert.equal(m, 3, "the first ask and one per pause");
  });
});

describe("a rate limit that lifts hours from now", () => {
  const daily = (resetAt: number) =>
    JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day-high-balance. ", code: 429, metadata: { headers: { "X-RateLimit-Limit": "1000", "X-RateLimit-Remaining": "0", "X-RateLimit-Reset": String(resetAt) } } } });

  it("is read from the error body, in ms or seconds", () => {
    assert.equal(rateLimitResetAt(daily(1791244800000)), 1791244800000);
    assert.equal(rateLimitResetAt(daily(1791244800)), 1791244800000);
    assert.equal(rateLimitResetAt("not json"), undefined);
  });

  it("ends the turn at the first refusal and says when it lifts, instead of retrying for minutes", async () => {
    const w = workspace();
    try {
      let n = 0;
      const fetchFn = (async () => {
        n += 1;
        return new Response(daily(Date.now() + 2 * 3_600_000), { status: 429, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: false, bar: null });
      const events = await drain(engine.run("answer me", allowAll));
      assert.ok(n <= 2, `one request and at most one closing-summary attempt, not a retry loop (${n})`);
      assert.ok(events.some((e) => e.kind === "error" && /rate limit is reached until/.test((e as { text: string }).text)));
    } finally {
      w.cleanup();
    }
  });

  it("is still retried when it lifts within minutes", async () => {
    const w = workspace();
    try {
      let n = 0;
      const fetchFn = (async () => {
        n += 1;
        if (n === 1) return new Response(daily(Date.now() + 30_000), { status: 429, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: false, bar: null, retryBackoffMs: [0, 0, 0] });
      const events = await drain(engine.run("answer me", allowAll));
      assert.equal(n, 2);
      assert.ok(events.some((e) => e.kind === "assistant_text"));
    } finally {
      w.cleanup();
    }
  });

  it("stops a short question at once too", async () => {
    let n = 0;
    const fetchFn = (async () => {
      n += 1;
      return new Response(daily(Date.now() + 2 * 3_600_000), { status: 429 });
    }) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: "http://provider.test/v1", model: "m", system: "s", prompt: "p", fetchFn, what: "drafting", overloadBackoffMs: [0, 0, 0] });
    assert.equal(n, 1);
    assert.match(!r.ok ? r.error : "", /rate limit is reached until .* \(drafting\)/);
  });
});

describe("a request's turn at a self-hosted server", () => {
  const daily = (resetAt: number) => JSON.stringify({ error: { message: "Rate limit exceeded", code: 429, metadata: { headers: { "X-RateLimit-Reset": String(resetAt) } } } });

  it("is given back when the request ends in a refusal that stops the retries", async () => {
    const w = workspace();
    const url = "http://localhost:18931/v1";
    try {
      const fetchFn = (async () => new Response(daily(Date.now() + 2 * 3_600_000), { status: 429 })) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: url, model: "m", cwd: w.dir, fetchFn, stream: false, bar: null });
      await drain(engine.run("answer me", allowAll));
      // A leaked slot would leave every later request to this server (the
      // drafter, the critic, the next turn) waiting for ever.
      const next = await Promise.race([takeTurn(url).then((r) => (r(), "free")), new Promise<string>((r) => setTimeout(() => r("held"), 500))]);
      assert.equal(next, "free", "the turn the failed request held was released");
    } finally {
      w.cleanup();
    }
  });
});
