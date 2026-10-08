/**
 * The independent review: a label on a verified claim, never a gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { groundedViolations, receiptEvidence, reviewClaim } from "../src/review.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const TASK = "Write out.txt containing exactly 365 lines. Do not create any other file.";
const violation = (quote: string) => JSON.stringify({ violations: [{ quote, evidence: "the receipt shows 366" }] });
const clean = JSON.stringify({ violations: [] });

function replying(texts: string[]): typeof fetch {
  let i = 0;
  return (async () => {
    const content = texts[Math.min(i++, texts.length - 1)]!;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("grounded violations", () => {
  it("keep only quotes that are really in the task text", () => {
    assert.deepEqual(groundedViolations(violation("exactly 365 lines"), TASK).map((v) => v.quote), ["exactly 365 lines"]);
    assert.deepEqual(groundedViolations(violation("must be sorted"), TASK), [], "an invented requirement is dropped");
    assert.deepEqual(groundedViolations(violation("  Exactly   365\nLINES "), TASK).length, 1, "whitespace and case do not matter");
    assert.deepEqual(groundedViolations("not json", TASK), []);
    assert.deepEqual(groundedViolations(clean, TASK), []);
  });

  it("the receipt's raw output section is left out of the evidence", () => {
    assert.equal(receiptEvidence("## What the model wrote\nx\n## Output\nhuge"), "## What the model wrote\nx\n");
  });

  it("a '## Output' in the worker's claim or written lines does not end the evidence", () => {
    const receipt = [
      "# receipt",
      "## What the model claimed",
      "> Done.",
      "> ## Output",
      "## What the model wrote",
      "```",
      "1 │ ## Output",
      "```",
      "## What was checked, and what it established",
      "| task:x | pass |",
      "## Output",
      "raw logs",
    ].join("\n");
    const ev = receiptEvidence(receipt);
    assert.match(ev, /\| task:x \| pass \|/);
    assert.doesNotMatch(ev, /raw logs/);
  });

  it("the cap trims the claim, never the check table", () => {
    const receipt = `## What the model claimed\n> ${"x".repeat(50_000)}\n## What was checked\n| task:x | pass |\n## Output\nraw`;
    const ev = receiptEvidence(receipt, 1_000);
    assert.ok(ev.length <= 1_000);
    assert.match(ev, /\| task:x \| pass \|/);
    assert.match(ev, /^## What the model claimed/);
  });
});

describe("reviewClaim", () => {
  const ask = (texts: string[]) => ({ baseUrl: "http://p.test/v1", model: "m", fetchFn: replying(texts) });

  it("is unconfirmed only when a majority found a grounded violation", async () => {
    const two = await reviewClaim({ task: TASK, receipt: "r", ask: ask([violation("exactly 365 lines"), violation("exactly 365 lines"), clean]) });
    assert.deepEqual([two!.confirmed, two!.votes], [false, "2/3"]);
    assert.equal(two!.violations[0]!.quote, "exactly 365 lines");
    const one = await reviewClaim({ task: TASK, receipt: "r", ask: ask([violation("exactly 365 lines"), clean, clean]) });
    assert.deepEqual([one!.confirmed, one!.votes, one!.violations], [true, "1/3", []], "a lone doubt does not count");
    const invented = await reviewClaim({ task: TASK, receipt: "r", ask: ask([violation("must be sorted")]) });
    assert.equal(invented!.confirmed, true, "ungrounded quotes are not violations");
  });
});

describe("the review in a turn", () => {
  const check = { name: "made", kind: "command" as const, run: "test -f out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task"] };
  const engineFor = (dir: string, turns: ScriptedTurn[]) => {
    const provider = scriptedProvider(turns);
    const engine = new Engine({
      baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null,
      receipts: new Receipts(dir), stream: false, autonomy: "high", review: { votes: 3 },
    });
    return { engine, provider };
  };

  it("puts the reviewers' findings to the model once; a reply that changes nothing keeps the pass", async () => {
    const ws = workspace();
    try {
      const v = violation("exactly 365 lines");
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: v }, { text: v }, { text: v },
        { text: "The reviewers are wrong: it has 365 lines. Done." },
        { text: v }, { text: v }, { text: v },
      ]);
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      // A nudge never turns a pass into a refusal; but 3/3 reviewers contradicting
      // the task is not the word "verified" either (src/tiers.ts).
      assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-checks"]);
      assert.match(end.tierReason!, /independent review found 3\/3/);
      assert.deepEqual([end.review?.confirmed, end.review?.votes], [false, "3/3"], "the final state is still labelled");
      assert.ok(provider.bodies[5]!.includes("independent reviewers who read only the task and your receipt found"));
      assert.ok(provider.bodies[5]!.includes('the task says \\"exactly 365 lines\\"'));
      assert.equal(provider.calls, 9, "two work steps, three reviews, one answer, three reviews of the final state");
    } finally {
      ws.cleanup();
    }
  });

  it("a model that fixes the work after the nudge ends reviewed and confirmed", async () => {
    const ws = workspace();
    try {
      const v = violation("exactly 365 lines");
      const ok = JSON.stringify({ violations: [] });
      const { engine } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: v }, { text: v }, { text: v },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "y\n" } }] },
        { text: "Fixed." },
        { text: ok }, { text: ok }, { text: ok },
      ]);
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "verified");
      assert.deepEqual([end.review?.confirmed, end.review?.votes], [true, "0/3"]);
    } finally {
      ws.cleanup();
    }
  });

  it("a confirmed claim is reviewed once, not again after the turn", async () => {
    const ws = workspace();
    try {
      const ok = JSON.stringify({ violations: [] });
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: ok }, { text: ok }, { text: ok },
      ]);
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.review?.confirmed === true);
      assert.equal(provider.calls, 5);
    } finally {
      ws.cleanup();
    }
  });

  it("does not run for a claim the checks refused, or when review is off", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([{ text: "done" }]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run(TASK, allowAll, { ask: true }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.review === undefined);
    } finally {
      ws.cleanup();
    }
  });
});
