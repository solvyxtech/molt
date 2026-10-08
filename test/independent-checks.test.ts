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
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { taskChecksFrom } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { assertsValue, claimLabel, goldenOperands, independentOf, jobEndWords, normalizeModelId, sameModel, tierOf } from "../src/tiers.js";
import { parseBar } from "../src/bar.js";
import { proposeBar } from "../src/detect.js";
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
    assert.ok(sameModel("qwen/qwen3-235b-a22b-2507", "Qwen/Qwen3-235B-A22B-Instruct-2507"), "-instruct is a spelling, not a model");
    assert.ok(sameModel("google/gemma-3-27b-it", "gemma-3-27b"));
    assert.ok(sameModel("deepseek-chat", "deepseek"));
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
  const value = (name: string) => ({ name, ok: true, hidden: true as const, kind: "command" as const, tags: ["task", "value"] });
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
    const visible = tierOf({ results: [{ name: "task:v", ok: true, kind: "command" as const, tags: ["task"] }], worker: "m" });
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

  it("Maat's builtins and session checks are nobody's judgment of the task", () => {
    // The default `maat init` bar: work-landed, record-intact, claims-grounded, ... (src/detect.ts).
    const builtin = (name: string) => ({ name, ok: true, kind: "builtin" as const, tags: ["session"] });
    const own = by({ kind: "worker", model: "m" }, "task:out");
    const t = tierOf({ results: [builtin("work-landed"), value("task:out")], worker: ["m"], authors: own });
    assert.deepEqual([t.tier, t.basis], ["passed-own-checks", "own"], "a passing work-landed made a self-judged run 'verified (your checks)'");
    const surface = { name: "task:look", ok: true, hidden: true as const, kind: "command" as const, tags: ["task", "surface"] };
    assert.equal(tierOf({ results: [builtin("work-landed"), surface], worker: "m" }).tier, "passed-checks");
    for (const n of ["work-landed", "record-intact", "claims-grounded", "work-accounted", "spec-intact"]) {
      assert.equal(tierOf({ results: [builtin(n)], worker: "m" }).tier, "passed-checks", `${n} alone is not verified`);
    }
    // A builtin without the session tag (work-complete: imports-tracked) is no different.
    assert.equal(tierOf({ results: [{ name: "work-complete", ok: true, kind: "builtin" as const, tags: [] }], worker: "m" }).tier, "passed-checks");
    // A session-tagged command check is Maat's too.
    assert.equal(tierOf({ results: [{ name: "s", ok: true, kind: "command" as const, tags: ["session"] }], worker: "m" }).tier, "passed-checks");
    // Even recorded as a person's, a builtin is not a person's judgment.
    assert.equal(tierOf({ results: [builtin("work-landed")], worker: "m", authors: by({ kind: "person" }, "work-landed") }).tier, "passed-checks");
    // A result with no recorded kind fails closed.
    assert.equal(tierOf({ results: [{ name: "x", ok: true, tags: [] }], worker: "m" }).tier, "passed-checks");
    // A person's own command still carries it.
    const mine = tierOf({ results: [builtin("work-landed"), { name: "tests", ok: true, kind: "command" as const, tags: [] }], worker: "m" });
    assert.deepEqual([mine.tier, mine.basis], ["verified", "person"]);
  });

  it("review-advisory: a contradicted or missing review qualifies every label", () => {
    const judged = by({ kind: "judge", model: "j" });
    const contradicted = tierOf({ results: [value("task:v")], worker: "m", authors: judged, review: { votes: "2/3", violations: [] }, reviewAdvisory: true });
    assert.deepEqual([contradicted.tier, contradicted.reviewGap], ["verified", "unconfirmed"]);
    assert.equal(claimLabel("verified", contradicted), "verified (independent checks: j), unconfirmed");
    const missing = tierOf({ results: [value("task:v")], worker: "m", authors: judged, unreviewed: true, reviewAdvisory: true });
    assert.equal(claimLabel("verified", missing), "verified (independent checks: j), unreviewed");
    const fine = tierOf({ results: [value("task:v")], worker: "m", authors: judged, review: { votes: "0/3", violations: [] }, reviewAdvisory: true });
    assert.equal(claimLabel("verified", fine), "verified (independent checks: j)");
    const own = tierOf({ results: [value("task:v")], worker: "m", review: { votes: "2/3", violations: [] }, reviewAdvisory: true });
    assert.equal(claimLabel("unverified", own), "passed own checks (m), not verified, unconfirmed");
  });

  it("the terminal and the window print the qualifier before any claim", () => {
    const claim = "verified (independent checks: j)";
    // The engine's own job_end (the claim already carries it) ...
    assert.equal(jobEndWords({ outcome: "verified", tier: "verified", claim: `${claim}, unconfirmed`, review: { confirmed: false } }), `${claim}, unconfirmed`);
    // ... and a claim from a build that did not put it there.
    assert.equal(jobEndWords({ outcome: "verified", tier: "verified", claim, review: { confirmed: false } }), `${claim}, unconfirmed`);
    assert.equal(jobEndWords({ outcome: "verified", tier: "verified", claim, unreviewed: true }), `${claim}, unreviewed`);
    assert.equal(jobEndWords({ outcome: "verified", tier: "verified", claim, review: { confirmed: true } }), `${claim}, independently reviewed`);
    assert.equal(jobEndWords({ outcome: "verified", review: { confirmed: false } }), "passed its checks, unconfirmed");
    assert.equal(jobEndWords({ outcome: "verified", unreviewed: true }), "passed its checks, unreviewed");
    assert.equal(jobEndWords({ outcome: "unverified", tier: "passed-checks", tierReason: "r" }), "passed its checks (not verified: r)");
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

  async function run(checks: Check[], opts: { initBar?: boolean } = {}) {
    const ws = workspace();
    try {
      const provider = scriptedProvider(work);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn,
        bar: opts.initBar ? parseBar(proposeBar(ws.dir).yaml) : null,
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

  it("the default `maat init` bar beside the worker's own checks: still not verified", async () => {
    const { end, receipt } = await run([value()], { initBar: true });
    assert.deepEqual([end.outcome, end.tier, end.claim], ["unverified", "passed-own-checks", "passed own checks (m), not verified"]);
    assert.match(receipt, /check: work-landed[\s\S]*?written by: Maat \(a session check/);
    assert.doesNotMatch(receipt, /check: work-landed\nkind: builtin\nwritten by: a person/);
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

describe("a golden file only stands for a value when it predates the work", () => {
  it("goldenOperands and assertsValue with a pre-work record", () => {
    assert.deepEqual(goldenOperands("diff out.txt expected.txt"), ["expected.txt"]);
    assert.deepEqual(goldenOperands("cmp got.bin 'baseline.bin' && diff -u a golden/x.json"), ["baseline.bin", "golden/x.json"]);
    assert.ok(assertsValue("diff out.txt expected.txt"), "by name alone, as the drafter tags it");
    assert.ok(!assertsValue("diff out.txt expected.txt", () => false), "not there before the work: no value");
    assert.ok(assertsValue("diff out.txt expected.txt", (g) => g === "expected.txt"));
    assert.ok(assertsValue("diff out.txt expected.txt && [ \"$(wc -l < out.txt)\" -eq 3 ]", () => false), "a literal comparison still counts");
    assert.ok(assertsValue("diff out.txt <(printf 'a\\n')", () => false), "a heredoc or <(...) is written in the command");
  });

  const TASK = "Write out.txt with the line hello.";
  const diffCheck: Check = {
    name: "matches", kind: "command", run: "diff out.txt expected.txt", timeoutMs: 5_000, expectExit: 0,
    tags: ["task", "value"], hidden: true, author: { kind: "judge", model: "judge-j" },
  } as Check;
  async function turn(writes: Record<string, string>, before: Record<string, string> = {}) {
    const ws = workspace();
    try {
      for (const [f, c] of Object.entries(before)) writeFileSync(join(ws.dir, f), c);
      const provider = scriptedProvider([
        { calls: Object.entries(writes).map(([path, content]) => ({ name: "write_file", args: { path, content } })) },
        { text: "Done." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [diffCheck] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      return end;
    } finally {
      ws.cleanup();
    }
  }

  it("the worker writes both files: the diff passes and is not a value, so not verified", async () => {
    const end = await turn({ "out.txt": "wrong\n", "expected.txt": "wrong\n" });
    assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-checks"]);
  });

  it("the task shipped expected.txt and the worker left it alone: verified", async () => {
    const end = await turn({ "out.txt": "hello\n" }, { "expected.txt": "hello\n" });
    assert.deepEqual([end.outcome, end.tier, end.claim], ["verified", "verified", "verified (independent checks: judge-j)"]);
  });

  it("the worker rewrote the shipped expected.txt: not verified", async () => {
    const end = await turn({ "out.txt": "wrong\n", "expected.txt": "wrong\n" }, { "expected.txt": "hello\n" });
    assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-checks"]);
  });
});

