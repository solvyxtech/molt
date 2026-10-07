/**
 * A stalled cloud provider is given up on after a multiple of what it has
 * normally taken this session, not after five minutes (watchdog.ts).
 * Mercury 2.5 answered steps in about a second, stalled now and then, and
 * OpenRouter's 120 s "504 Upstream idle timeout" cost one task 370 of 540 s.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel } from "../src/ask.js";
import { draftCriteriaCritiqued } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { keepAliveOnly, LatencyLearner, Watchdog } from "../src/watchdog.js";

const enc = (s: string) => new TextEncoder().encode(s);

describe("keep-alives", () => {
  it("are SSE comments and blank lines only; anything with data is progress", () => {
    assert.equal(keepAliveOnly(enc(": OPENROUTER PROCESSING\n\n")), true);
    assert.equal(keepAliveOnly(enc("\n\n")), true);
    assert.equal(keepAliveOnly(enc(': x\n\ndata: {"choices":[]}\n\n')), false);
  });
});

describe("LatencyLearner", () => {
  it("leaves the fixed allowance alone until it has seen three completed requests", () => {
    const l = new LatencyLearner();
    l.record({ firstProgressMs: 1_000, maxGapMs: 500 });
    l.record({ firstProgressMs: 1_000, maxGapMs: 500 });
    assert.equal(l.firstByte(300_000), 300_000);
    l.record({ firstProgressMs: 2_000, maxGapMs: 800 });
    assert.equal(l.firstByte(300_000), 45_000, "a fast provider gets the 45 s floor");
    assert.equal(l.idle(300_000), 45_000);
  });

  it("allows eight times the slow end of what the provider has done, never more than the fixed allowance", () => {
    const l = new LatencyLearner();
    for (const ms of [8_000, 9_000, 10_000]) l.record({ firstProgressMs: ms, maxGapMs: 1_000 });
    assert.equal(l.firstByte(300_000), 80_000);
    const slow = new LatencyLearner();
    for (const ms of [60_000, 70_000, 80_000]) slow.record({ firstProgressMs: ms, maxGapMs: 1_000 });
    assert.equal(slow.firstByte(300_000), 300_000);
  });

  it("ignores a request that never made progress", () => {
    const l = new LatencyLearner();
    for (let i = 0; i < 5; i++) l.record({ firstProgressMs: undefined, maxGapMs: 0 });
    assert.equal(l.firstByte(300_000), 300_000);
  });
});

describe("the watchdog on a stream that only keeps the connection alive", () => {
  it("fires on silence even while keep-alive comments keep arriving", async () => {
    const w = new Watchdog(new AbortController().signal, { firstByteMs: 1_000, idleMs: 150 });
    let push: ((s: string) => void) | undefined;
    const body = new ReadableStream<Uint8Array>({ start(c) { push = (s) => c.enqueue(enc(s)); } });
    const res = w.watch(new Response(body, { headers: { "content-type": "text/event-stream" } }));
    const reader = res.body!.getReader();
    const drain = (async () => { try { for (;;) { const r = await reader.read(); if (r.done) break; } } catch { /* aborted */ } })();
    push!('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
    const tick = setInterval(() => push!(": OPENROUTER PROCESSING\n\n"), 30);
    await new Promise((r) => setTimeout(r, 400));
    clearInterval(tick);
    assert.equal(w.reason, "idle");
    assert.ok(w.firstProgressMs !== undefined);
    w.dispose();
    void drain;
  });
});

describe("the drafter's asks seed the learner", () => {
  const reply = (text: string) =>
    (async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text }, finish_reason: "stop" }] }) })) as unknown as typeof fetch;

  it("records a completed ask to a cloud endpoint, so the learner tightens before the first step", async () => {
    const l = new LatencyLearner();
    for (let i = 0; i < 3; i++) {
      const r = await askModel({ baseUrl: "https://cloud.test/v1", model: "m", system: "s", prompt: "p", fetchFn: reply("ok"), latency: l });
      assert.equal(r.ok, true);
    }
    assert.equal(l.firstByte(300_000), 45_000, "three asks were enough to learn");
    assert.equal(l.learnedFirstByte(), 45_000);
  });

  it("does not record a failed ask, or one to a self-hosted server", async () => {
    const l = new LatencyLearner();
    const fail = (async () => ({ ok: false, status: 500, text: async () => "" })) as unknown as typeof fetch;
    for (let i = 0; i < 3; i++) await askModel({ baseUrl: "https://cloud.test/v1", model: "m", system: "s", prompt: "p", fetchFn: fail, latency: l, overloadBackoffMs: [] });
    for (let i = 0; i < 3; i++) await askModel({ baseUrl: "http://127.0.0.1:1/v1", model: "m", system: "s", prompt: "p", fetchFn: reply("ok"), latency: l });
    assert.equal(l.learnedFirstByte(), undefined);
  });

  it("is reached by the criteria drafter and its critic, and the engine offers it only for a cloud endpoint", async () => {
    const l = new LatencyLearner();
    const draft = JSON.stringify({ checks: [{ name: "a", run: "test -f out.txt" }], notes: [] });
    await draftCriteriaCritiqued({ task: "make out.txt", scripts: [], barChecks: [], baseUrl: "https://cloud.test/v1", model: "m", fetchFn: reply(draft), latency: l, emptyRetryDelayMs: 0 });
    assert.ok(l.learnedFirstByte() !== undefined, "at least three asks (draft, critic, ...) completed");
    const cloud = new Engine({ baseUrl: "https://cloud.test/v1", model: "m", bar: null });
    const local = new Engine({ baseUrl: "http://127.0.0.1:8080/v1", model: "m", bar: null });
    assert.ok(cloud.askLatency instanceof LatencyLearner);
    assert.equal(local.askLatency, undefined);
  });
});
