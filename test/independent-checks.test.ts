/**
 * "verified" never rests on checks written by the model that did the work.
 *
 * Who wrote each check is recorded when it is sealed: the worker, a separate
 * judge, a person, or the reference writer. A run is verified only when a
 * passing check that ran the work and asserted a value came from someone
 * other than the worker model (compared by provider-normalized id), or a
 * person wrote or approved a passing check. Otherwise the best it earns is
 * "passed own checks", reported unverified.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { taskChecksFrom } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { claimLabel, independentOf, normalizeModelId, sameModel, tierOf } from "../src/tiers.js";
import type { Check, CheckAuthor } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

describe("model ids, provider spelling aside", () => {
  it("the same model through another provider is the same model", () => {
    assert.ok(sameModel("minimax/minimax-m3", "MiniMax-M3"));
    assert.ok(sameModel("qwen/qwen3-235b-a22b:free", "qwen3-235b-a22b"));
    assert.ok(sameModel("anthropic/claude-opus-4.1", "claude-opus-4-1-20250805"));
    assert.ok(sameModel("us.anthropic.claude-3-5-sonnet-20240620-v1:0", "claude-3.5-sonnet"));
    assert.ok(sameModel("openrouter/nvidia/nemotron-3-ultra-550b-a55b:free", "nemotron-3-ultra-550b-a55b"));
    assert.equal(normalizeModelId("x-ai/Grok-4.6"), "grok-4-6");
  });
  it("different models stay different", () => {
    assert.ok(!sameModel("deepseek-v3", "deepseek-v2"), "a version is not a date suffix");
    assert.ok(!sameModel("qwen3-235b", "qwen3-32b"));
    assert.ok(!sameModel("minimax-m3", "minimax-m2.5"));
    assert.ok(!sameModel("", ""), "an empty id matches nothing");
  });
});

describe("independentOf", () => {
  it("a person is independent; the worker never is; a model only when it is another model", () => {
    assert.ok(independentOf({ kind: "person" }, "m"));
    assert.ok(!independentOf({ kind: "worker", model: "m" }, "m"));
    assert.ok(!independentOf({ kind: "worker", model: "other" }, "m"), "the worker kind is never independent");
    assert.ok(independentOf({ kind: "judge", model: "j" }, "m"));
    assert.ok(!independentOf({ kind: "judge", model: "m" }, "m"));
    assert.ok(!independentOf({ kind: "judge", model: "openrouter/m:free" }, ["m"]));
    assert.ok(!independentOf({ kind: "judge", model: "j" }, ["m", "j"]), "the id the backend reported counts too");
    assert.ok(!independentOf({ kind: "judge" }, "m"), "a judge with no recorded model proves nothing");
    assert.ok(!independentOf(undefined, "m"));
    assert.ok(!independentOf({ kind: "judge", model: "j" }, undefined), "no worker to compare with: not independent");
    assert.ok(independentOf({ kind: "reference", model: "r" }, "m"));
    assert.ok(!independentOf({ kind: "reference", model: "m" }, "m"));
  });
});

describe("tierOf: who wrote the checks", () => {
  const value = (name: string) => ({ name, ok: true, hidden: true as const, tags: ["task", "value"] });
  const by = (a: CheckAuthor, name = "task:v") => new Map([[name, a]]);

  it("worker-authored checks only: not verified", () => {
    const t = tierOf({ results: [value("task:v")], worker: "m", authors: by({ kind: "worker", model: "m" }) });
    assert.equal(t.tier, "passed-own-checks");
    assert.equal(t.basis, "own");
    assert.match(t.reason!, /written by the worker model \(m\)/);
    assert.equal(claimLabel("unverified", t), "passed own checks (m), not verified");
  });

  it("an author nobody recorded on a hidden check counts as the worker's", () => {
    assert.equal(tierOf({ results: [value("task:v")], worker: "m" }).tier, "passed-own-checks");
    assert.equal(tierOf({ results: [value("task:v")] }).tier, "passed-own-checks");
  });

  it("judge-authored: verified, and the label names the judge", () => {
    const t = tierOf({ results: [value("task:v")], worker: "m", authors: by({ kind: "judge", model: "judge-j" }) });
    assert.deepEqual([t.tier, t.basis, t.by], ["verified", "independent", ["judge-j"]]);
    assert.equal(claimLabel("verified", t), "verified (independent checks: judge-j)");
  });

  it("same model id as judge: not independent", () => {
    for (const judge of ["m", "openrouter/m:free", "M"]) {
      const t = tierOf({ results: [value("task:v")], worker: "m", authors: by({ kind: "judge", model: judge }) });
      assert.equal(t.tier, "passed-own-checks", judge);
      assert.equal(claimLabel("unverified", t), "passed own checks (m), not verified");
    }
  });

  it("person-approved: verified, labelled as your checks", () => {
    // A visible check (done.yml, or criteria approved in the window) is a person's.
    const visible = tierOf({ results: [{ name: "task:v", ok: true, tags: ["task"] }], worker: "m" });
    assert.deepEqual([visible.tier, visible.basis], ["verified", "person"]);
    assert.equal(claimLabel("verified", visible), "verified (your checks)");
    // So is a hidden one a person signed off (a mission contract).
    const signed = tierOf({ results: [value("task:v")], worker: "m", authors: by({ kind: "person" }) });
    assert.equal(claimLabel("verified", signed), "verified (your checks)");
  });

  it("one independent runs+value check is enough beside the worker's own", () => {
    const authors = new Map<string, CheckAuthor>([
      ["task:own", { kind: "worker", model: "m" }],
      ["task:judged", { kind: "judge", model: "j" }],
    ]);
    const t = tierOf({ results: [value("task:own"), value("task:judged")], worker: "m", authors });
    assert.equal(claimLabel("verified", t), "verified (independent checks: j)");
    // ...but an independent check that asserted no value does not carry it.
    const weak = tierOf({
      results: [value("task:own"), { name: "task:judged", ok: true, hidden: true, tags: ["task"] }],
      worker: "m",
      authors,
    });
    assert.equal(weak.tier, "passed-own-checks");
  });

  it("a reviewer contradiction still outranks authorship", () => {
    const t = tierOf({ results: [value("task:v")], worker: "m", authors: by({ kind: "judge", model: "j" }), review: { votes: "2/3", violations: [] } });
    assert.equal(t.tier, "passed-checks");
    assert.equal(claimLabel("unverified", t), "unverified");
  });
});

describe("authorship at the seal, in a turn", () => {
  const TASK = "Write out.txt containing exactly the word hello.";
  const work: ScriptedTurn[] = [
    { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
    { text: "Done." },
  ];
  const value = (extra: Partial<Check> = {}): Check =>
    ({ name: "made", kind: "command", run: "grep -qx hello out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true, ...extra }) as Check;

  async function run(checks: Check[]) {
    const ws = workspace();
    try {
      const provider = scriptedProvider(work);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null,
        receipts: new Receipts(ws.dir), stream: false, autonomy: "high",
      });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      const dir = join(ws.dir, ".maat", "receipts");
      const rows = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const receipt = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      return { end, events, rows, receipt };
    } finally {
      ws.cleanup();
    }
  }

  it("checks the worker drafted: passed own checks, unverified, and the receipt says who wrote them", async () => {
    const { end, events, rows, receipt } = await run([value()]);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["unverified", "passed-own-checks", "passed own checks (m), not verified"]);
    assert.deepEqual(end.checkAuthors, { "task:made": "worker m" });
    assert.ok(events.some((e) => e.kind === "info" && /passed own checks \(m\), not verified/.test(e.text)));
    assert.deepEqual([rows.at(-1).tier, rows.at(-1).claim], ["passed-own-checks", "passed own checks (m), not verified"]);
    assert.match(receipt, /written by: the worker model m/);
    assert.match(receipt, /Claim: passed own checks \(m\), not verified\./);
  });

  it("checks a separate judge drafted: verified, naming the judge", async () => {
    const { end, rows, receipt } = await run([value({ author: { kind: "judge", model: "judge-j" } })]);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["verified", "verified", "verified (independent checks: judge-j)"]);
    assert.deepEqual(end.checkAuthors, { "task:made": "judge judge-j" });
    assert.equal(rows.at(-1).claim, "verified (independent checks: judge-j)");
    assert.match(receipt, /written by: the judge model judge-j/);
  });

  it("a judge that is the worker model under another provider's name: not verified", async () => {
    const { end } = await run([value({ author: { kind: "judge", model: "openrouter/m:free" } })]);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["unverified", "passed-own-checks", "passed own checks (m), not verified"]);
  });

  it("checks a person approved (the window, --criterion): verified (your checks), unchanged", async () => {
    const approved = taskChecksFrom({ checks: [{ name: "made", run: "test -s out.txt" }] }).taskChecks;
    assert.deepEqual(approved[0]!.author, { kind: "person" }, "approved criteria are recorded as a person's");
    const { end, receipt } = await run(approved);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["verified", "verified", "verified (your checks)"]);
    assert.match(receipt, /written by: a person \(your check\)/);
  });
});
