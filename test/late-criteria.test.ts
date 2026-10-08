/**
 * A seal that cannot be empty: when the time budget cuts the wait for the
 * drafter and nothing has been reviewed yet, the draft is not dropped. It
 * joins the sealed checks at the first claim, the way the reference check
 * does, with the hash of what the drafter read journalled before the work and
 * again at the join. On Mercury 2.5 the drafter's request stalled in 14 of 60
 * runs, a zero-check seal followed, and every correct result went unverified.
 */
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { claimWaitForDraftsMs, draftInputsHash, Engine, lateCriteriaWaitMs } from "../src/engine.js";
import type { EngineEvent } from "../src/types.js";
import { Journal } from "../src/journal.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

// Value-asserting checks (src/tiers.ts): a check that only looks cannot earn "verified".
const mk = (name: string, run: string): Check => ({ name, kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true, author: { kind: "judge", model: "judge-j" } });
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

/**
 * A claim of done waits for drafts still on their way until the time budget's
 * margin — not a fixed two minutes — when the drafter's inputs were frozen
 * before the work (RunOptions.draftInputs). Measured 2026-10-07: a separate
 * judge drafting for 170–300 s (a local model past 6 min) finished after the
 * claim's 120 s, and correct work was labelled plain unverified.
 */
describe("a claim waits for late drafts until the time budget's margin", () => {
  const realTimeout = setTimeout;
  const slow = (name: string, run: string): Check => ({ ...mk(name, run), timeoutMs: 10_000_000 });
  /** Run a turn on a virtual clock: one simulated second per real 2 ms. */
  async function onVirtualClock(start: (at: <T>(v: T, ms: number) => Promise<T>) => AsyncGenerator<EngineEvent>): Promise<{ ev: EngineEvent[]; simMs: number }> {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
    const t0 = Date.now();
    try {
      const ev: EngineEvent[] = [];
      let done = false;
      let err: unknown;
      const run = (async () => {
        for await (const e of start((v, ms) => new Promise((r) => setTimeout(() => r(v), ms)))) ev.push(e);
      })().then(
        () => { done = true; },
        (e: unknown) => { err = e; done = true; },
      );
      for (let i = 0; i < 2_000 && !done; i++) {
        await new Promise((r) => realTimeout(r, 2));
        mock.timers.tick(1_000);
      }
      await run;
      if (err) throw err;
      return { ev, simMs: Date.now() - t0 };
    } finally {
      mock.timers.reset();
    }
  }
  const infos = (ev: EngineEvent[]) => ev.filter((e) => e.kind === "info").map((e) => (e as { text: string }).text);
  const outcome = (ev: EngineEvent[]) => {
    const end = ev.find((e) => e.kind === "job_end");
    return end && end.kind === "job_end" ? end.outcome : undefined;
  };
  const sealed = { sha: "frozen-inputs", used: () => ["frozen-inputs"] };

  it("the numbers: a 600 s budget waits to its 90 s margin, never less than before; no budget keeps 120 s", () => {
    assert.equal(claimWaitForDraftsMs(590_000, 600_000), 500_000);
    assert.ok(claimWaitForDraftsMs(590_000, 600_000) > 200_000, "drafts at 200 s are inside the wait");
    assert.equal(lateCriteriaWaitMs(590_000), 120_000, "the old wait ended before them");
    // The margin is the larger of 60 s and 15% of the budget.
    assert.equal(claimWaitForDraftsMs(250_000, 300_000), 190_000);
    // Late in the budget it never waits less than the old rule.
    assert.equal(claimWaitForDraftsMs(80_000, 600_000), lateCriteriaWaitMs(80_000));
    assert.equal(claimWaitForDraftsMs(undefined, 0), 120_000);
  });

  it("drafts arriving at 200 s of a 600 s budget are used, and judge the claim", async () => {
    const ws = workspace();
    try {
      const { engine, journal } = setup(ws.dir, "late-wait-1");
      const { ev, simMs } = await onVirtualClock((at) =>
        engine.run(TASK, allowAll, {
          pendingCriteria: at({ taskChecks: [slow("greeting", "grep -qx hello out.txt")], taskNotes: [] }, 200_000),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          draftInputs: sealed,
        }),
      );
      assert.ok(infos(ev).some((t) => /^waited (19\d|20\d)s for the drafted checks \(waited to the time budget's margin.*1 arrived and joined/.test(t)), infos(ev).join("\n"));
      const proof = ev.find((e) => e.kind === "proof_result");
      assert.ok(proof && proof.kind === "proof_result" && proof.result.results.some((r: { name: string }) => r.name === "task:greeting"));
      assert.equal(outcome(ev), "verified");
      assert.ok(simMs < 600_000);
      const join = notes(journal, "late-checks");
      assert.equal(join.length, 1);
      assert.equal(join[0]!.data.arrived, true);
      assert.ok(Number(join[0]!.data.waitedMs) >= 195_000);
      assert.equal(notes(journal, "draft-inputs")[0]!.data.inputsSha, "frozen-inputs");
      assert.equal(join[0]!.data.inputsSha, "frozen-inputs");
    } finally {
      ws.cleanup();
    }
  });

  it("a late check that fails the work goes down the refusal path, never dropped", async () => {
    const ws = workspace();
    try {
      const { engine } = setup(ws.dir, "late-wait-2");
      const { ev } = await onVirtualClock((at) =>
        engine.run(TASK, allowAll, {
          pendingCriteria: at({ taskChecks: [slow("farewell", "grep -qx goodbye out.txt")], taskNotes: [] }, 200_000),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          draftInputs: sealed,
        }),
      );
      assert.ok(infos(ev).some((t) => /1 arrived and joined/.test(t)));
      assert.ok(ev.some((e) => (e.kind === "proof_refused" || e.kind === "proof_exhausted") && e.result.results.some((r: { name: string; ok: boolean }) => r.name === "task:farewell" && !r.ok)));
      assert.notEqual(outcome(ev), "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("drafts that never arrive: the claim is judged without them at the deadline margin", async () => {
    const ws = workspace();
    try {
      const { engine, journal } = setup(ws.dir, "late-wait-3");
      const { ev, simMs } = await onVirtualClock(() =>
        engine.run(TASK, allowAll, {
          pendingCriteria: new Promise(() => {}),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          draftInputs: sealed,
        }),
      );
      const said = infos(ev).find((t) => /did not arrive/.test(t));
      assert.ok(said, infos(ev).join("\n"));
      // 600 s budget, 90 s margin: about 510 s waited, then judged in what is left.
      const waited = Number(/^waited (\d+)s/.exec(said!)?.[1]);
      assert.ok(waited >= 500 && waited <= 512, said);
      assert.match(said!, /judged without them/);
      assert.notEqual(outcome(ev), "verified");
      assert.ok(ev.some((e) => e.kind === "job_end"));
      assert.ok(simMs < 600_000, `ended inside the budget (${simMs} ms)`);
      assert.equal(notes(journal, "late-checks")[0]!.data.arrived, false);
    } finally {
      ws.cleanup();
    }
  });

  it("with no time budget the old 120 s applies", async () => {
    const ws = workspace();
    try {
      const { engine } = setup(ws.dir, "late-wait-4");
      engine.setTurnDeadline(0);
      const { ev } = await onVirtualClock((at) =>
        engine.run(TASK, allowAll, {
          pendingCriteria: at({ taskChecks: [slow("greeting", "grep -qx hello out.txt")], taskNotes: [] }, 200_000),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          draftInputs: sealed,
        }),
      );
      assert.ok(infos(ev).some((t) => /^waited 12\ds for the drafted checks; they did not arrive within 120s/.test(t)), infos(ev).join("\n"));
      assert.notEqual(outcome(ev), "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("drafts whose inputs are not the frozen snapshot get the old 120 s, not the long wait", async () => {
    const ws = workspace();
    try {
      const { engine } = setup(ws.dir, "late-wait-5");
      const { ev } = await onVirtualClock((at) =>
        engine.run(TASK, allowAll, {
          pendingCriteria: at({ taskChecks: [slow("greeting", "grep -qx hello out.txt")], taskNotes: [] }, 200_000),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          draftInputs: { sha: "frozen-inputs", used: () => ["frozen-inputs", "read-the-live-folder"] },
        }),
      );
      assert.ok(infos(ev).some((t) => /^waited 12\ds for the drafted checks; they did not arrive within 120s/.test(t)), infos(ev).join("\n"));
      assert.notEqual(outcome(ev), "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("drafts that arrive having used other inputs are not joined, and the claim is not verified by them", async () => {
    const ws = workspace();
    try {
      const { engine, journal } = setup(ws.dir, "late-wait-6");
      const used = ["frozen-inputs"];
      const { ev } = await onVirtualClock((at) =>
        engine.run(TASK, allowAll, {
          // A later stage read the changed folder; that shows once it is done.
          pendingCriteria: at(null, 150_000).then(() => {
            used.push("read-the-live-folder");
            return { taskChecks: [slow("greeting", "grep -qx hello out.txt")], taskNotes: [] };
          }),
          criteriaSoFar: nothing,
          criteriaWaitMs: 100,
          draftInputs: { sha: "frozen-inputs", used: () => [...used] },
        }),
      );
      assert.ok(infos(ev).some((t) => /arrived after \d+s but were drafted from a view of the project that differs/.test(t)), infos(ev).join("\n"));
      assert.ok(!ev.some((e) => e.kind === "proof_result" && e.result.results.some((r: { name: string }) => r.name === "task:greeting")));
      assert.notEqual(outcome(ev), "verified");
      const n = notes(journal, "late-checks");
      assert.equal(n.length, 1);
      assert.match(String(n[0]!.data.text), /NOT joined/);
    } finally {
      ws.cleanup();
    }
  });
});
