/**
 * The shared ask transport, and the reasoning-model trap it exists to hold.
 *
 * Mercury 2.5, asked for three criteria under a 500-token ceiling, spent 491
 * of them reasoning and returned an empty reply marked `length`. Every
 * headless run drafted nothing and said "the reply was empty" — true, and
 * useless. The ceiling is larger now, an empty cut-off reply is retried once
 * with room, and a second one is named for what it is.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ASK_MAX_TOKENS, ASK_RETRY_FACTOR, askModel, jsonIn, notJson } from "../src/ask.js";

type Reply = { content: string | null; finish?: string; status?: number };

/** A provider that answers each request from the script, and records the ceilings asked for. */
function replying(script: Reply[]): { fetchFn: typeof fetch; ceilings: number[] } {
  const ceilings: number[] = [];
  let i = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { max_tokens: number };
    ceilings.push(body.max_tokens);
    const r = script[Math.min(i++, script.length - 1)];
    return {
      ok: (r.status ?? 200) < 400,
      status: r.status ?? 200,
      json: async () => ({ choices: [{ message: { content: r.content }, finish_reason: r.finish ?? "stop" }] }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, ceilings };
}

const ask = (fetchFn: typeof fetch, extra: Record<string, unknown> = {}) =>
  askModel({ baseUrl: "http://provider.test/v1", model: "m", system: "s", prompt: "p", fetchFn, what: "drafting", ...extra });

describe("askModel", () => {
  it("asks with a ceiling large enough to hold hidden reasoning and an answer", async () => {
    const p = replying([{ content: '{"a":1}' }]);
    const r = await ask(p.fetchFn);
    assert.deepEqual(r, { ok: true, text: '{"a":1}', cutOff: false });
    assert.deepEqual(p.ceilings, [ASK_MAX_TOKENS]);
    assert.ok(ASK_MAX_TOKENS >= 2000, `${ASK_MAX_TOKENS} is too small for a model that reasons first`);
  });

  it("retries once, with room, when the whole ceiling went to reasoning", async () => {
    const p = replying([{ content: "", finish: "length" }, { content: '{"a":1}' }]);
    const r = await ask(p.fetchFn);
    assert.deepEqual(r, { ok: true, text: '{"a":1}', cutOff: false });
    assert.deepEqual(p.ceilings, [ASK_MAX_TOKENS, ASK_MAX_TOKENS * ASK_RETRY_FACTOR]);
  });

  it("names the second empty reply for what it is, rather than 'the reply was empty'", async () => {
    const p = replying([{ content: null, finish: "length" }]);
    const r = await ask(p.fetchFn, { maxTokens: 100 });
    assert.equal(r.ok, false);
    assert.equal(
      r.ok ? "" : r.error,
      "the model spent its whole 400-token ceiling reasoning and wrote nothing, twice while drafting — pick a model that answers, or raise --max-tokens",
    );
    assert.deepEqual(p.ceilings, [100, 400]);
  });

  it("does not retry a reply that was cut off mid-answer: that one is the caller's to report", async () => {
    const p = replying([{ content: '{"a":', finish: "length" }]);
    const r = await ask(p.fetchFn);
    assert.deepEqual(r, { ok: true, text: '{"a":', cutOff: true });
    assert.equal(p.ceilings.length, 1);
  });

  it("reports an HTTP failure with what was being asked, and marks a rate limit worth asking again", async () => {
    const p = replying([{ content: null, status: 429 }]);
    const r = await ask(p.fetchFn, { overloadBackoffMs: [] });
    assert.deepEqual(r, { ok: false, error: "HTTP 429 drafting", transient: true });
    const q = replying([{ content: null, status: 400 }]);
    assert.deepEqual(await ask(q.fetchFn, { overloadBackoffMs: [0] }), { ok: false, error: "HTTP 400 drafting" });
    assert.equal(q.ceilings.length, 1, "a request the provider called wrong is not asked again");
  });
});

describe("jsonIn and notJson", () => {
  it("finds the object in a fenced or prefaced reply and refuses arrays and prose", () => {
    assert.deepEqual(jsonIn('Sure:\n```json\n{"x":[1,2]}\n```'), { x: [1, 2] });
    assert.equal(jsonIn("[1,2]"), null);
    assert.equal(jsonIn("no braces here"), null);
    assert.equal(jsonIn("{not json}"), null);
  });

  it("says what came back instead", () => {
    assert.equal(notJson("", false), "the draft reply was not JSON, so nothing was proposed: the reply was empty");
    assert.equal(notJson("I think", true, "plan"), 'the plan reply was not JSON, so nothing was proposed — it was cut off at the token limit: "I think"');
    assert.match(notJson("x".repeat(100), false), /"x{80}…"$/);
  });
});

describe("askModel with a reasoning effort", () => {
  it("sends reasoning.effort only when set", async () => {
    const seen: Record<string, unknown>[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      seen.push(JSON.parse(String(init?.body)));
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: "{}" }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    await askModel({ baseUrl: "http://p.test/v1", model: "m", system: "s", prompt: "p", fetchFn, reasoningEffort: "low" });
    await askModel({ baseUrl: "http://p.test/v1", model: "m", system: "s", prompt: "p", fetchFn });
    assert.deepEqual(seen[0].reasoning, { effort: "low" });
    assert.equal("reasoning" in seen[1], false);
  });
});

