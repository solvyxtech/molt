/**
 * Asks on the worker's own model outside a turn — the interview and mission
 * planning — are metered as worker spend. Before this they used tokens no
 * meter saw (the judge's asks were metered in #56; these are not the judge's).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { judgeSpendLine } from "../src/format.js";
import { Journal } from "../src/journal.js";
import { JudgeMeter } from "../src/judge-meter.js";
import { interviewTurn } from "../src/interview.js";
import { draftMission } from "../src/mission.js";
import { workspace } from "./helpers.js";

const URL = "http://provider.test/v1";
const reply = (body: unknown) =>
  (async () => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), headers: new Headers() }) as unknown as Response) as unknown as typeof fetch;

describe("the interview's ask is worker spend", () => {
  it("adds its reported tokens to the session meter and the journal", async () => {
    const ws = workspace();
    try {
      const journal = new Journal(ws.dir);
      const engine = new Engine({ baseUrl: URL, model: "m", cwd: ws.dir, bar: null, journal, priceInPerMtok: 2, priceOutPerMtok: 10 });
      const fetchFn = reply({
        choices: [{ message: { content: JSON.stringify({ questions: [{ id: "q1", prompt: "What counts as done?", options: ["a", "b"] }] }) } }],
        usage: { prompt_tokens: 900, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 300 } },
      });
      const r = await interviewTurn({ task: "t", scripts: [], barChecks: [], history: [], round: 1, baseUrl: URL, model: "m", fetchFn, meter: engine.workerAskMeter });
      assert.notEqual(r.kind, "error");
      const b = engine.bom();
      assert.equal(b.sessionPromptTokens, 900);
      assert.equal(b.sessionCompletionTokens, 100);
      assert.equal(b.sessionCachedTokens, 300);
      assert.ok(Math.abs(b.costUsd! - (900 * 2 + 100 * 10) / 1e6) < 1e-12, "priced as the worker");
      assert.equal(b.judge, undefined, "not the judge's");
      const e = Journal.read(journal.path).filter((x) => x.kind === "worker_ask");
      assert.equal(e.length, 1);
      assert.equal((e[0]!.data as Record<string, unknown>).what, "interviewing");
      assert.match(Journal.summarize(e)[0]!, /ask m \(interviewing\) · 900 in \/ 100 out/);
    } finally {
      ws.cleanup();
    }
  });

  it("estimates, and marks it, when the provider reports no usage", async () => {
    const ws = workspace();
    try {
      const engine = new Engine({ baseUrl: URL, model: "m", cwd: ws.dir, bar: null });
      const fetchFn = reply({ choices: [{ message: { content: JSON.stringify({ proposal: { criteria: [] } }) } }] });
      await interviewTurn({ task: "t", scripts: [], barChecks: [], history: [], round: 3, baseUrl: URL, model: "m", fetchFn, meter: engine.workerAskMeter });
      assert.ok(engine.sessionTokens > 0);
      assert.equal(engine.costEstimated, true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("mission planning is worker spend", () => {
  it("reports the plan's tokens and cost on a meter priced as the worker", async () => {
    const meter = new JudgeMeter(() => ({ baseUrl: URL, model: "m", pricing: { in: 2, out: 10, source: "test" } }));
    const fetchFn = reply({ choices: [{ message: { content: "not a plan" }, finish_reason: "stop" }], usage: { prompt_tokens: 5000, completion_tokens: 1000 } });
    await draftMission({ goal: "a CLI", ask: { baseUrl: URL, model: "m", fetchFn, meter } });
    const s = meter.total();
    assert.equal(s.calls, 1);
    assert.equal(s.promptTokens, 5000);
    assert.ok(Math.abs(s.costUsd! - (5000 * 2 + 1000 * 10) / 1e6) < 1e-12);
    assert.equal(judgeSpendLine(s, undefined, "worker (planning)"), "worker (planning) 1 call · 5000 in · 1000 out · $0.020");
  });
});
