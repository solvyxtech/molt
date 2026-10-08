/**
 * Every turn ends with a verdict: a turn the clock or the provider stopped is
 * still judged by the sealed bar on the tree it left, and a check that hangs
 * is retired rather than allowed to end the run with nothing.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine, type RunOptions } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { LatencyLearner } from "../src/watchdog.js";
import type { Check, EngineEvent } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const greet = (hidden = true): Check => ({
  name: "greeting", kind: "command", run: "grep -qx hello out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", "exact"], hidden,
  // Drafted by a separate judge model, not the worker "m".
  author: { kind: "judge", model: "judge-j" },
});

function end(events: Awaited<ReturnType<typeof drain>>) {
  const e = events.find((x) => x.kind === "job_end");
  assert.ok(e && e.kind === "job_end");
  return e;
}

/** Writes out.txt, then spends longer than the 400 ms budget on a command. */
const slowWrite = (content: string) => [
  { calls: [{ name: "write_file", args: { path: "out.txt", content } }, { name: "bash", args: { command: "sleep 0.7" } }] },
  { text: "never asked for" },
];

/**
 * Run the turn with its 400 ms budget armed once out.txt is being written.
 *
 * Armed at the start, the budget raced the engine's start-up: under 150 CPU
 * burners (2026-10-08) it ran out before the scripted reply was read ("time
 * budget reached (414ms of 400ms) — no more tool calls"), nothing was
 * written, and the bar rightly failed the empty tree; `passedAtEnd` failed
 * 14 runs in 20. The budget is read live (`deadlineAt`), so arming it at the
 * write makes the clock stop the turn after the work, under any load: during
 * the 0.7 s command if the write came early, at once if it came late.
 */
async function stoppedAfterWrite(engine: Engine, opts?: RunOptions) {
  const events: EngineEvent[] = [];
  for await (const e of engine.run("write out.txt", allowAll, opts)) {
    events.push(e);
    if (e.kind === "tool" && e.name === "write_file") engine.setTurnDeadline(400);
  }
  return events;
}

describe("a turn stopped by the clock", () => {
  // Mercury 2.5: three half-finished trees passed weak drafted checks at the
  // deadline and were "verified"; the grader failed all three.
  it("runs the sealed bar on the tree, and a pass there is recorded but unverified: the model never said done", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider(slowWrite("hello\n"));
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false,
        autonomy: "high", receipts: new Receipts(ws.dir),
      });
      const events = await stoppedAfterWrite(engine, { taskChecks: [greet()] });
      const e = end(events);
      assert.equal(e.outcome, "unverified");
      assert.equal(e.passedAtEnd, true);
      assert.equal(e.deadline, true);
      assert.equal(e.endedBy, "deadline");
      assert.ok(events.some((x) => x.kind === "proof_result"));
      assert.equal(p.calls, 1, "no closing summary was asked for once the bar had judged");
      const dir = join(ws.dir, ".maat", "receipts");
      const receipt = readdirSync(dir).find((f) => f.endsWith("-accepted.md"));
      assert.ok(receipt, "a receipt was written");
      assert.match(readFileSync(join(dir, receipt), "utf8"), /time budget ran out/);
    } finally {
      ws.cleanup();
    }
  });

  it("is not proven when the work on disk is wrong", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider(slowWrite("goodbye\n"));
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false,
        autonomy: "high",
      });
      // A person's check, so the refusal is not softened to "unverified".
      const events = await stoppedAfterWrite(engine, { taskChecks: [greet(false)] });
      const e = end(events);
      assert.equal(e.outcome, "not proven");
      assert.equal(e.deadline, true);
    } finally {
      ws.cleanup();
    }
  });

  it("stays unverified when nothing was sealed", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([...slowWrite("hello\n"), { text: "Wrote out.txt; ran out of time." }]);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false,
        autonomy: "high",
      });
      const e = end(await stoppedAfterWrite(engine));
      assert.equal(e.outcome, "unverified");
      assert.equal(e.deadline, true);
    } finally {
      ws.cleanup();
    }
  });
});

describe("a provider that gives up after work happened", () => {
  function failing(content: string) {
    const ok = scriptedProvider([{ calls: [{ name: "write_file", args: { path: "out.txt", content } }] }]);
    let n = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      n += 1;
      if (n === 1) return ok.fetchFn(url, init);
      return { ok: false, status: 400, text: async () => "bad request", json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;
    return fetchFn;
  }

  // A pass is recorded (passedAtEnd) but is not "verified": the provider
  // stopped the model before it said the work was done.
  it("still runs the bar: a fail is not proven, a pass is recorded but unverified", async () => {
    for (const [content, outcome] of [["hello\n", "unverified"], ["nope\n", "not proven"]] as const) {
      const ws = workspace();
      try {
        const engine = new Engine({
          baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: failing(content), bar: null, stream: false,
          autonomy: "high", retryBackoffMs: [0],
        });
        const events = await drain(engine.run("write out.txt", allowAll, { taskChecks: [greet(false)] }));
        const e = end(events);
        assert.equal(e.outcome, outcome);
        assert.equal(e.endedBy, "provider");
        assert.equal(e.deadline, undefined);
        assert.ok(events.some((x) => x.kind === "error"), "the provider failure is still reported");
      } finally {
        ws.cleanup();
      }
    }
  });
});

describe("a check that exceeds its timeout", () => {
  const hang: Check = { name: "hangs", kind: "command", run: "sleep 5", timeoutMs: 300, expectExit: 0, tags: ["task"], hidden: true, author: { kind: "judge", model: "judge-j" } };

  it("is retired as a timeout, and the others judge", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
      ]);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high",
      });
      const events = await drain(engine.run("write out.txt", allowAll, { taskChecks: [greet(), hang] }));
      assert.equal(end(events).outcome, "verified");
      assert.ok(events.some((x) => x.kind === "info" && /hangs timed out.*retired/.test(x.text)));
      const proof = events.find((x) => x.kind === "proof_result");
      assert.ok(proof && proof.kind === "proof_result");
      assert.deepEqual(proof.result.results.map((r) => r.name), ["task:greeting"]);
    } finally {
      ws.cleanup();
    }
  });

  it("never lets a timeout carry a verdict by itself", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
      ]);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high",
      });
      const e = end(await drain(engine.run("write out.txt", allowAll, { taskChecks: [{ ...hang, hidden: false }] })));
      assert.equal(e.outcome, "unverified", "the only check retired leaves nothing that judged the claim");
    } finally {
      ws.cleanup();
    }
  });
});

describe("the independent review and the clock", () => {
  // Six of eight no-verdict runs on Mercury 2.5 passed their bar and died
  // inside the review's asks, past the runner's grace.
  const run = async (deadlineMs: number | undefined) => {
    const ws = workspace();
    try {
      const p = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
        { text: "{}" },
      ]);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false,
        autonomy: "high", review: { votes: 3 }, receipts: new Receipts(ws.dir), ...(deadlineMs ? { turnDeadlineMs: deadlineMs } : {}),
      });
      const events = await drain(engine.run("write out.txt", allowAll, { taskChecks: [greet()] }));
      return { events, calls: p.calls };
    } finally {
      ws.cleanup();
    }
  };

  it("is skipped when the turn has too little time left, and the verdict says unreviewed", async () => {
    const { events, calls } = await run(30_000);
    const e = end(events);
    // Asked-for review that did not run cannot have found nothing: not "verified" (tiers.ts).
    assert.equal(e.outcome, "unverified");
    assert.equal(e.tier, "passed-checks");
    assert.equal(e.unreviewed, true);
    assert.equal(e.review, undefined);
    assert.equal(calls, 2, "no review request was sent");
    assert.ok(events.some((x) => x.kind === "info" && /skipping the independent review/.test(x.text)));
  });

  it("runs when the budget leaves room for it, and is then not labelled unreviewed", async () => {
    const { events, calls } = await run(900_000);
    const e = end(events);
    assert.equal(e.outcome, "verified");
    assert.equal(e.unreviewed, undefined);
    assert.ok(calls > 2, "the reviewers were asked");
  });

  it("learns the first-byte time the provider has shown, for the review to be sized by", () => {
    const l = new LatencyLearner();
    assert.equal(l.learnedFirstByte(), undefined);
    for (const ms of [8_000, 9_000, 10_000]) l.record({ firstProgressMs: ms, maxGapMs: 1_000 });
    assert.equal(l.learnedFirstByte(), 80_000);
  });
});
