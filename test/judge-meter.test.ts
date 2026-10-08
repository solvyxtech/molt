/**
 * The judge's meter: every ask made around the work (drafting, critic,
 * reference, review, audit, arbiter) is counted and priced apart from the
 * worker's requests, reported on job_end, the receipt, the journal and the
 * CLI line, and counted by a budget.
 *
 * A bench run on 2026-10-08 could only estimate the judge's cost; the exact
 * figure was visible only in the provider's console.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { askModel } from "../src/ask.js";
import { Engine } from "../src/engine.js";
import { judgeSpendLine } from "../src/format.js";
import { Journal } from "../src/journal.js";
import { JudgeMeter, priceTokens } from "../src/judge-meter.js";
import { Receipts } from "../src/receipts.js";
import type { Check, EngineEvent } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

const URL = "http://provider.test/v1";
const JUDGE = "judge-j";
const PRICE = { in: 2, out: 10, cached: 0.2, source: "test" };
/** What the scripted judge reports for every ask. */
const JUDGE_USAGE = { prompt_tokens: 1000, completion_tokens: 200, prompt_tokens_details: { cached_tokens: 400 }, cache_creation_input_tokens: 50 };
/** 600 fresh x $2 + 400 cached x $0.2 + 200 out x $10, per 1M. */
const PER_CALL = (600 * 2 + 400 * 0.2 + 200 * 10) / 1e6;

const reply = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() }) as unknown as Response;

/**
 * One endpoint serving two models: the worker ("m") writes out.txt and says
 * done; the judge answers every review ask with no violations and JUDGE_USAGE.
 */
function twoModels() {
  const sent: { model: string }[] = [];
  let worker = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model: string };
    sent.push(body);
    if (body.model === JUDGE) {
      return reply({ choices: [{ message: { role: "assistant", content: '{"violations":[]}' }, finish_reason: "stop" }], usage: JUDGE_USAGE });
    }
    worker += 1;
    const message =
      worker === 1
        ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "out.txt", content: "hello\n" }) } }] }
        : { role: "assistant", content: "Done." };
    return reply({ choices: [{ message, finish_reason: worker === 1 ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 20 } });
  }) as unknown as typeof fetch;
  return { fetchFn, sent, judgeCalls: () => sent.filter((b) => b.model === JUDGE).length };
}

const greet: Check = {
  name: "greeting", kind: "command", run: "grep -qx hello out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", "exact"], hidden: true,
  author: { kind: "judge", model: JUDGE },
};

function jobEnd(events: EngineEvent[]) {
  const e = events.find((x) => x.kind === "job_end");
  assert.ok(e && e.kind === "job_end");
  return e;
}

describe("the judge's meter on a reviewed turn", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.MAAT_JUDGE_MODEL;
    process.env.MAAT_JUDGE_MODEL = JUDGE;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MAAT_JUDGE_MODEL;
    else process.env.MAAT_JUDGE_MODEL = saved;
  });

  const run = async (priced: boolean) => {
    const ws = workspace();
    const p = twoModels();
    const journal = new Journal(ws.dir);
    const engine = new Engine({
      baseUrl: URL, model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high",
      review: { votes: 3 }, receipts: new Receipts(ws.dir), journal,
      priceInPerMtok: 1, priceOutPerMtok: 5,
    });
    if (priced) engine.judgeMeter.setPricing(URL, JUDGE, PRICE);
    // The drafting the CLI does before the turn, on the same meter.
    engine.judgeMeter.record({ baseUrl: URL, model: JUDGE, what: "drafting criteria", promptTokens: 1000, completionTokens: 200, cacheReadTokens: 400, cacheWriteTokens: 50, estimated: false });
    const events = await drain(engine.run("write out.txt", allowAll, { taskChecks: [greet] }));
    return { ws, engine, events, p, journal };
  };

  it("reports the judge's tokens and $ on job_end, apart from the worker's", async () => {
    const { ws, events, p, engine } = await run(true);
    try {
      const e = jobEnd(events);
      assert.equal(p.judgeCalls(), 3, "three review votes went to the judge");
      assert.ok(e.judge, "job_end carries the judge's spend");
      // The drafting before the turn and the three review votes.
      assert.equal(e.judge.calls, 4);
      assert.equal(e.judge.promptTokens, 4000);
      assert.equal(e.judge.completionTokens, 800);
      assert.equal(e.judge.cacheReadTokens, 1600);
      assert.equal(e.judge.cacheWriteTokens, 200);
      assert.ok(Math.abs(e.judge.costUsd! - 4 * PER_CALL) < 1e-12, `judge $ ${e.judge.costUsd}`);
      assert.deepEqual(e.judge.models, [JUDGE]);
      // The worker's spend is its own two requests, untouched by the judge's.
      assert.equal(e.spend.promptTokens, 200);
      assert.equal(e.spend.completionTokens, 40);
      assert.equal(engine.sessionTokens, 240, "sessionTokens stays the worker's");
      assert.equal(engine.spentTokens, 240 + 4800, "a budget counts both");
    } finally {
      ws.cleanup();
    }
  });

  it("writes the judge's spend to the receipt row, the receipt and the journal", async () => {
    const { ws, journal } = await run(true);
    try {
      const rows = new Receipts(ws.dir).records();
      const row = rows.find((r) => r.verdict === "accepted");
      assert.ok(row?.judge, "the receipt row carries the judge's spend");
      // Brought up to date at the job's end: the review ran after the receipt was written.
      assert.equal(row.judge.calls, 4);
      assert.ok(Math.abs(row.judge.costUsd! - 4 * PER_CALL) < 1e-12);
      assert.equal(row.costUsd, (200 * 1 + 40 * 5) / 1e6, "the worker's cost stays the worker's");
      // The receipt file, written at the claim, says what the judge had spent by then.
      const dir = join(ws.dir, ".maat", "receipts");
      const file = readdirSync(dir).find((f) => f.endsWith("-accepted.md"));
      assert.ok(file);
      const body = readFileSync(join(dir, file), "utf8");
      assert.match(body, /- session cost: \$0\.0004 \(worker\)/);
      assert.match(body, /- judge 1 call · 1000 in \(400 cached, 50 cache write\) · 200 out · \$0\.0033 so far/);
      const entries = Journal.read(journal.path).filter((x) => x.kind === "judge_usage");
      assert.equal(entries.length, 4);
      const d = entries[1]!.data as Record<string, unknown>;
      assert.equal(d.model, JUDGE);
      assert.equal(d.what, "reviewing the claim");
      assert.equal(d.promptTokens, 1000);
      assert.equal(d.cacheReadTokens, 400);
      assert.equal(d.cacheWriteTokens, 50);
      assert.ok(Math.abs((d.costUsd as number) - PER_CALL) < 1e-12);
      assert.ok(Journal.summarize(entries.slice(1)).every((l) => /judge judge-j \(reviewing the claim\) · 1000 in \(400 cached\) \/ 200 out · \$0\.0032/.test(l)));
    } finally {
      ws.cleanup();
    }
  });

  it("an unpriced judge model reports its tokens and $ unknown, never $0", async () => {
    const { ws, events, journal } = await run(false);
    try {
      const e = jobEnd(events);
      assert.ok(e.judge);
      assert.equal(e.judge.promptTokens, 4000);
      assert.equal(e.judge.costUsd, undefined, "no price means no dollar figure");
      assert.equal(e.judge.unpricedCalls, 4);
      assert.deepEqual(e.judge.unpricedModels, [JUDGE]);
      assert.match(judgeSpendLine(e.judge), /^judge 4 calls · 4000 in \(1600 cached, 200 cache write\) · 800 out · \$ unknown \(no price for judge-j\)$/);
      const row = new Receipts(ws.dir).records().find((r) => r.verdict === "accepted");
      assert.equal(row?.judge?.costUsd, undefined);
      const entries = Journal.read(journal.path).filter((x) => x.kind === "judge_usage");
      assert.equal((entries[0]!.data as Record<string, unknown>).costUsd, null, "null, not 0");
      assert.ok(Journal.summarize(entries).every((l) => /\$ unknown$/.test(l)));
      // The receipt file says so in words.
      const dir = join(ws.dir, ".maat", "receipts");
      const file = readdirSync(dir).find((f) => f.endsWith("-accepted.md"));
      assert.ok(file);
      const body = readFileSync(join(dir, file), "utf8");
      assert.match(body, /- judge 1 call · 1000 in \(400 cached, 50 cache write\) · 200 out · \$ unknown \(no price for judge-j\) so far/);
      assert.doesNotMatch(body, /judge \d+ calls? · .*\$0\.0000/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("a budget counts the judge's spend", () => {
  it("a token budget the judge has used up stops the worker before its first step", async () => {
    const ws = workspace();
    try {
      let asked = 0;
      const fetchFn = (async () => {
        asked += 1;
        return reply({ choices: [{ message: { role: "assistant", content: "Done." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: URL, model: "m", cwd: ws.dir, fetchFn, bar: null, stream: false, autonomy: "high" });
      engine.setBudget(5_000);
      // The drafting before the turn: on the judge's meter, not the worker's.
      engine.judgeMeter.record({ baseUrl: URL, model: JUDGE, what: "drafting criteria", promptTokens: 4_800, completionTokens: 400, estimated: false });
      assert.equal(engine.sessionTokens, 0);
      const events = await drain(engine.run("anything", allowAll));
      const hit = events.find((x) => x.kind === "error" && x.ceiling === "budget");
      assert.ok(hit && hit.kind === "error", "the budget was hit");
      assert.match(hit.text, /budget hit \(5000 tokens, 5200 of them the judge's\)/);
      assert.equal(asked, 1, "only the closing summary was asked for; no work step ran");
      const e = jobEnd(events);
      assert.equal(e.judge?.promptTokens, 4_800, "the pre-turn drafting is reported with the turn it was for");
    } finally {
      ws.cleanup();
    }
  });

  it("a money ceiling counts the judge's dollars", async () => {
    const ws = workspace();
    try {
      const fetchFn = (async () =>
        reply({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "list_files", arguments: "{}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 5 } })) as unknown as typeof fetch;
      const engine = new Engine({
        baseUrl: URL, model: "m", cwd: ws.dir, fetchFn, bar: null, stream: false, autonomy: "high",
        priceInPerMtok: 1, priceOutPerMtok: 1, maxTurnUsd: 0.01, maxSteps: 3,
      });
      engine.judgeMeter.setPricing(URL, JUDGE, { in: 1000, out: 1000, source: "test" });
      const gen = engine.run("anything", allowAll);
      const events: EngineEvent[] = [];
      for await (const ev of gen) {
        events.push(ev);
        // The judge spends $0.02 mid-turn: past the $0.01 ceiling on its own.
        if (ev.kind === "usage" && events.filter((x) => x.kind === "usage").length === 1) {
          engine.judgeMeter.record({ baseUrl: URL, model: JUDGE, promptTokens: 10, completionTokens: 10, estimated: false });
        }
      }
      assert.equal(engine.totalCostUsd()! > 0.02, true);
      assert.ok(
        events.some((x) => (x.kind === "error" || x.kind === "info") && /\$0\.0\d+ of \$0\.01/.test(x.text)),
        "the turn's money ceiling saw the judge's spend",
      );
    } finally {
      ws.cleanup();
    }
  });
});

describe("JudgeMeter", () => {
  const u = { baseUrl: URL, model: JUDGE, promptTokens: 1000, completionTokens: 200, cacheReadTokens: 400, estimated: false };

  it("prices a call with a set price, keyed on the judge's model id", () => {
    const m = new JudgeMeter();
    m.setPricing(URL, JUDGE, PRICE);
    m.record(u);
    assert.ok(Math.abs(m.total().costUsd! - PER_CALL) < 1e-12);
    assert.equal(priceTokens(PRICE, u), m.total().costUsd);
  });

  it("prices a call again once a price arrives after it", () => {
    const m = new JudgeMeter();
    m.record(u);
    assert.equal(m.total().costUsd, undefined);
    m.setPricing(URL, JUDGE, PRICE);
    assert.ok(Math.abs(m.total().costUsd! - PER_CALL) < 1e-12);
  });

  it("uses the provider's billed figure when it sends one", () => {
    const m = new JudgeMeter();
    m.record({ ...u, billedUsd: 0.5 });
    assert.equal(m.total().costUsd, 0.5);
    assert.equal(m.total().billed, true);
  });

  it("is unknown, not a partial sum, when any call is unpriced", () => {
    const m = new JudgeMeter();
    m.setPricing(URL, JUDGE, PRICE);
    m.record(u);
    m.record({ ...u, model: "other" });
    const s = m.total();
    assert.equal(s.costUsd, undefined);
    assert.equal(s.unpricedCalls, 1);
    assert.deepEqual(s.unpricedModels, ["other"]);
  });

  it("a judge that is the worker's own model is priced as the worker is", () => {
    const m = new JudgeMeter(() => ({ baseUrl: URL, model: "m", pricing: PRICE }));
    m.record({ ...u, model: "m" });
    assert.ok(Math.abs(m.total().costUsd! - PER_CALL) < 1e-12);
  });

  it("knows Anthropic's published rates on Anthropic's API", () => {
    const m = new JudgeMeter();
    m.record({ ...u, baseUrl: "https://api.anthropic.com/v1", model: "claude-haiku-4-5", cacheReadTokens: 0 });
    // Haiku 4.5: $1 in, $5 out.
    assert.ok(Math.abs(m.total().costUsd! - (1000 * 1 + 200 * 5) / 1e6) < 1e-12);
  });

  it("a subscription judge is paid by its plan: no dollar figure, said as the plan", () => {
    const m = new JudgeMeter();
    m.record({ ...u, baseUrl: "grok-build://subscription", estimated: true });
    const s = m.total();
    assert.equal(s.costUsd, undefined);
    assert.equal(s.unpricedCalls, 0);
    assert.match(judgeSpendLine(s), /your .+ plan, not metered$/);
  });

  it("since() reports only the calls after a mark", () => {
    const m = new JudgeMeter();
    m.record(u);
    const at = m.mark();
    m.record({ ...u, promptTokens: 7 });
    assert.equal(m.since(at).calls, 1);
    assert.equal(m.since(at).promptTokens, 7);
  });
});

describe("askModel reports usage to its meter", () => {
  it("reads the provider's usage block, cache read and write included", async () => {
    const m = new JudgeMeter();
    const fetchFn = (async () => reply({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { ...JUDGE_USAGE, cost: 0.004 } })) as unknown as typeof fetch;
    const r = await askModel({ baseUrl: URL, model: JUDGE, system: "S", prompt: "P", fetchFn, meter: m, what: "drafting criteria" });
    assert.equal(r.ok, true);
    const [c] = m.all();
    assert.deepEqual(
      { p: c!.promptTokens, c: c!.completionTokens, r: c!.cacheReadTokens, w: c!.cacheWriteTokens, b: c!.billedUsd, e: c!.estimated, what: c!.what },
      { p: 1000, c: 200, r: 400, w: 50, b: 0.004, e: false, what: "drafting criteria" },
    );
  });

  it("estimates, and says so, when the provider reports no usage", async () => {
    const m = new JudgeMeter();
    const fetchFn = (async () => reply({ choices: [{ message: { content: "abcdefgh" }, finish_reason: "stop" }] })) as unknown as typeof fetch;
    await askModel({ baseUrl: URL, model: JUDGE, system: "SSSS", prompt: "PPPP", fetchFn, meter: m });
    const [c] = m.all();
    assert.equal(c!.estimated, true);
    assert.equal(c!.promptTokens, 2);
    assert.equal(c!.completionTokens, 2);
  });

  it("records nothing for a refused ask", async () => {
    const m = new JudgeMeter();
    const fetchFn = (async () => ({ ok: false, status: 500, text: async () => "", json: async () => ({}) }) as unknown as Response) as unknown as typeof fetch;
    await askModel({ baseUrl: URL, model: JUDGE, system: "S", prompt: "P", fetchFn, meter: m, overloadBackoffMs: [] });
    assert.equal(m.mark(), 0);
  });
});
