/**
 * A seal that cannot be empty: when the time budget cuts the wait for the
 * drafter and nothing has been reviewed yet, the draft is not dropped. It
 * joins the sealed checks at the first claim, the way the reference check
 * does, with the hash of what the drafter read journalled before the work and
 * again at the join. On Mercury 2.5 the drafter's request stalled in 14 of 60
 * runs, a zero-check seal followed, and every correct result went unverified.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { draftInputsHash, Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

// Value-asserting checks (src/tiers.ts): a check that only looks cannot earn "verified".
const mk = (name: string, run: string): Check => ({ name, kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true });
const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const nothing = async () => ({ taskChecks: [] as Check[], taskNotes: [] as string[] });
const TASK = "write hello to out.txt";

function setup(dir: string, id: string) {
  const provider = scriptedProvider([
    { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
    { text: "Done." },
  ]);
  const journal = new Journal(dir, id);
  const engine = new Engine({
    baseUrl: "http://p.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", journal,
  });
  engine.setTurnDeadline(600_000);
  return { engine, journal, provider };
}
const notes = (j: Journal, kind: string) => Journal.read(j.path).filter((e) => e.kind === "note" && e.data.kind === kind);

describe("zero checks at the time budget's cut", () => {
  it("are not sealed empty: the draft joins at the first claim and judges it, the input hash journalled twice", async () => {
    const ws = workspace();
    try {
      const { engine, journal } = setup(ws.dir, "late-1");
      const ev = await drain(
        engine.run(TASK, allowAll, {
          pendingCriteria: later({ taskChecks: [mk("greeting", "grep -qx hello out.txt")], taskNotes: [] }, 400),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
        }),
      );
      assert.ok(ev.some((e) => e.kind === "info" && /none was ready; not sealing an empty set/.test(e.text)));
      assert.ok(ev.some((e) => e.kind === "info" && /joined this turn's checks/.test(e.text)));
      const proof = ev.find((e) => e.kind === "proof_result");
      assert.ok(proof && proof.kind === "proof_result" && proof.result.results.some((r) => r.name === "task:greeting"), "the late check judged the claim");
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified" && end.selfChecked === true);
      const start = notes(journal, "draft-inputs");
      const join = notes(journal, "late-checks");
      assert.equal(start.length, 1);
      assert.equal(join.length, 1);
      assert.equal(start[0]!.data.inputsSha, join[0]!.data.inputsSha, "the drafter's inputs are provably the same at the join");
      assert.equal(start[0]!.data.inputsSha, draftInputsHash(TASK, { files: new Set(), dirs: new Set() }));
    } finally {
      ws.cleanup();
    }
  });

  it("a late check that fails refuses the claim", async () => {
    const ws = workspace();
    try {
      const { engine } = setup(ws.dir, "late-2");
      const ev = await drain(
        engine.run(TASK, allowAll, {
          pendingCriteria: later({ taskChecks: [mk("farewell", "grep -qx goodbye out.txt")], taskNotes: [] }, 300),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
        }),
      );
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome !== "verified");
      assert.ok(ev.some((e) => e.kind === "proof_start"));
    } finally {
      ws.cleanup();
    }
  });

  it("a draft not ready at the claim is not waited on forever: the claim is judged as before", async () => {
    const ws = workspace();
    try {
      const { engine } = setup(ws.dir, "late-3");
      const started = Date.now();
      const ev = await drain(
        engine.run(TASK, allowAll, {
          pendingCriteria: later({ taskChecks: [mk("greeting", "grep -q hello out.txt")], taskNotes: [] }, 2_500),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          lateCriteriaWaitMs: 50,
        }),
      );
      assert.ok(Date.now() - started < 2_400);
      assert.ok(ev.some((e) => e.kind === "info" && /did not arrive within .*judged without them/.test(e.text)));
      assert.ok(ev.some((e) => e.kind === "job_end"));
    } finally {
      ws.cleanup();
    }
  });

  it("a draft with checks ready at the cut is sealed then, as before", async () => {
    const ws = workspace();
    try {
      const { engine, journal } = setup(ws.dir, "late-4");
      const ev = await drain(
        engine.run(TASK, allowAll, {
          pendingCriteria: later({ taskChecks: [], taskNotes: [] }, 5_000),
          criteriaSoFar: async () => ({ taskChecks: [mk("greeting", "grep -q hello out.txt")], taskNotes: [] }),
          criteriaWaitMs: 100,
        }),
      );
      assert.ok(ev.some((e) => e.kind === "info" && /sealing the 1 reviewed so far/.test(e.text)));
      assert.equal(notes(journal, "late-checks").length, 0);
    } finally {
      ws.cleanup();
    }
  });
});
