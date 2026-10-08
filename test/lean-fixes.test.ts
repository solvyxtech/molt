/**
 * Two defects found by the lean-sessions study (reports/lean-sessions-study.md),
 * fixed as defaults. Each test is built from the real case.
 *
 * 1. Shed min-free. Maat's own notes (acceptance criteria, a bar refusal) are
 *    user messages, so the cut on user turns could land near the start of a
 *    long single-request turn: the duration-bug run shed 6 messages, 60,788 ->
 *    60,387 tokens (0.7%), lost its whole prompt cache, and shed again a step
 *    later. With a short first exchange the plan came back null on every step
 *    and auto-shed never fired again that turn.
 * 2. Per-call elision. Elision was keyed by step: a step that read dur.py and
 *    test_dur.py together lost test_dur.py when dur.py was rewritten, under a
 *    marker saying the current copy was further down. It was not.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { ELIDED_PREFIX, SHED_MIN_FREE, Transcript } from "../src/transcript.js";
import { allowAll, drain, scriptedProvider, toolCall, workspace } from "./helpers.js";

describe("shed min-free (default)", () => {
  /**
   * The shape of the duration-bug run: the request and a small first
   * exchange (six messages), Maat's acceptance-criteria note, a long tool
   * run, a bar refusal, another long tool run. Two exchanges kept puts the
   * cut on the criteria note. `"short"` is the tiny first exchange (one
   * short read) that makes the digest cost more than the cut frees.
   */
  function durationBugShape(firstRead = "f".repeat(800)): Transcript {
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "Fix the duration parser so `1h30m` parses." });
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("read_file", { path: "dur.py" }, "r0")] });
    t.push({ role: "tool", tool_call_id: "r0", content: firstRead });
    if (firstRead !== "short") {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("read_file", { path: "test_dur.py" }, "r1")] });
      t.push({ role: "tool", tool_call_id: "r1", content: firstRead });
      t.push({ role: "assistant", content: "Reading done." });
    }
    t.push({ role: "user", content: "Acceptance criteria for this task: ..." });
    for (let i = 0; i < 40; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `s${i}` }, `a${i}`)] });
      t.push({ role: "tool", tool_call_id: `a${i}`, content: `${i}:${"o".repeat(3000)}` });
    }
    t.push({ role: "user", content: "[molt] You indicated the task is complete, but 1 of 3 checks did not pass." });
    for (let i = 0; i < 40; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `t${i}` }, `b${i}`)] });
      t.push({ role: "tool", tool_call_id: `b${i}`, content: `${i}:${"p".repeat(3000)}` });
    }
    return t;
  }

  it("is on by default at a quarter of the history", () => {
    assert.equal(SHED_MIN_FREE, 0.25);
    assert.equal(new Transcript("S").shedMinFree, SHED_MIN_FREE);
  });

  it("the 0.7% shed: without min-free the cut drops 6 messages and frees under 1%", () => {
    const t = durationBugShape();
    t.shedMinFree = 0;
    const plan = t.planShed()!;
    assert.equal(plan.droppedCount, 6);
    assert.ok(plan.afterTokens / plan.beforeTokens > 0.99, `${plan.beforeTokens} -> ${plan.afterTokens}`);
  });

  it("the 0.7% shed: by default it is a real shed", () => {
    const plan = durationBugShape().planShed()!;
    assert.ok(plan.afterTokens / plan.beforeTokens < 0.75, `${plan.beforeTokens} -> ${plan.afterTokens}`);
    assert.ok(plan.afterTokens / plan.beforeTokens < 0.1, "it cuts on recent messages, as a single request does");
  });

  it("the empty plan: without min-free a short first exchange gives no shed at all", () => {
    const t = durationBugShape("short");
    t.shedMinFree = 0;
    assert.equal(t.planShed(), null);
  });

  it("the empty plan: by default the shed happens, and keeps happening as the turn goes on", () => {
    const t = durationBugShape("short");
    const auto = 20_000;
    let sheds = 0;
    let peak = 0;
    for (let i = 0; i < 60; i++) {
      // The engine's auto-shed, once per step.
      if (t.historyTokens() > auto) {
        const plan = t.planShed();
        assert.ok(plan, `no shed at step ${i} with ${t.historyTokens()} tokens of history`);
        t.commitShed(plan);
        sheds++;
      }
      peak = Math.max(peak, t.historyTokens());
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `u${i}` }, `c${i}`)] });
      t.push({ role: "tool", tool_call_id: `c${i}`, content: `${i}:${"q".repeat(3000)}` });
    }
    assert.ok(sheds >= 3, `only ${sheds} shed(s)`);
    assert.ok(peak < auto * 1.5, `history reached ${peak}`);
  });

  it("leaves a cut on user turns alone when it frees enough", () => {
    const t = new Transcript("S");
    for (let k = 0; k < 4; k++) {
      t.push({ role: "user", content: `ask ${k}` });
      for (let i = 0; i < 5; i++) {
        t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `${k}.${i}` }, `c${k}.${i}`)] });
        t.push({ role: "tool", tool_call_id: `c${k}.${i}`, content: "x".repeat(2000) });
      }
    }
    const plan = t.planShed()!;
    // Two of four exchanges go: the cut is the user turn, not the recent fallback.
    assert.equal(plan.droppedCount, 22);
  });
});

describe("per-call elision (default)", () => {
  function step(t: Transcript, calls: [string, Record<string, unknown>, string, string][]) {
    t.push({ role: "assistant", content: null, tool_calls: calls.map(([n, a, id]) => toolCall(n, a, id)) });
    for (const [, , id, out] of calls) t.push({ role: "tool", tool_call_id: id, content: out });
  }
  const body = (s: string) => `${s}\n${"x".repeat(2000)}`;

  it("dur.py / test_dur.py: a write elides the read of that file only, not the rest of its step", () => {
    const t = new Transcript("S");
    t.push({ role: "user", content: "task" });
    step(t, [
      ["read_file", { path: "dur.py" }, "a", body("DUR_OLD")],
      ["read_file", { path: "test_dur.py" }, "b", body("TESTS")],
    ]);
    step(t, [["write_file", { path: "dur.py", content: "new" }, "w", "wrote"]]);
    assert.equal(t.elideSupersededReads().elided, 1);
    const results = t.all().filter((m) => m.role === "tool");
    assert.ok(results[0].content!.startsWith(ELIDED_PREFIX), "dur.py's stale copy goes");
    assert.match(results[1].content!, /^TESTS/, "test_dur.py was never rewritten and stays");
  });

  it("a write to ./dur.py is a write to dur.py", () => {
    const t = new Transcript("S");
    step(t, [["read_file", { path: "dur.py" }, "a", body("DUR_OLD")]]);
    step(t, [["edit_file", { path: "./dur.py", old: "a", new: "b" }, "e", "edited"]]);
    assert.equal(t.elideSupersededReads().elided, 1);
  });

  it("a bash rerun that came back different elides the earlier output", () => {
    const t = new Transcript("S");
    step(t, [["bash", { command: "pytest -q" }, "a", body("3 failed")]]);
    step(t, [["bash", { command: "pytest  -q" }, "b", body("3 passed")]]);
    assert.equal(t.elideSupersededReads().elided, 1);
    const wire = JSON.stringify(t.wire());
    assert.ok(!wire.includes("3 failed") && wire.includes("3 passed"));
    assert.match(wire, /newer output of the same command/);
  });

  it("a rerun with different options (a longer timeout_s) is a different call: the timeout note stays", () => {
    const t = new Transcript("S");
    step(t, [["bash", { command: "make" }, "a", body("timeout after 120s; call again with timeout_s")]]);
    step(t, [["bash", { command: "make", timeout_s: 600 }, "b", body("built")]]);
    assert.equal(t.elideSupersededReads().elided, 0);
  });

  it("a rerun that came back the same keeps the earlier output it points at", () => {
    const t = new Transcript("S");
    step(t, [["bash", { command: "ls" }, "a", body("files")]]);
    step(t, [["bash", { command: "ls" }, "b", "[molt: this is the same bash call you made at step 1, and nothing has changed since.]"]]);
    assert.equal(t.elideSupersededReads().elided, 0);
  });

  it("cat or sed -n of a file is a read a later write makes stale; a pipeline is not", () => {
    const t = new Transcript("S");
    step(t, [["bash", { command: "sed -n '1,80p' src/a.py" }, "a", body("OLD A")]]);
    step(t, [["bash", { command: "cat src/b.py | head" }, "b", body("B PIPE")]]);
    step(t, [["edit_file", { path: "src/a.py", old: "x", new: "y" }, "e", "edited"]]);
    step(t, [["edit_file", { path: "src/b.py", old: "x", new: "y" }, "f", "edited"]]);
    assert.equal(t.elideSupersededReads().elided, 1);
    const wire = JSON.stringify(t.wire());
    assert.ok(!wire.includes("OLD A") && wire.includes("B PIPE"));
  });

  it("in an engine run: rewriting dur.py keeps test_dur.py on the wire", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "dur.py"), `def parse(s):\n    return 0\n${"# pad\n".repeat(300)}`);
      writeFileSync(join(ws.dir, "test_dur.py"), `def test_hours():\n    assert parse('1h30m') == 5400  # TEST_MARK\n${"# pad\n".repeat(300)}`);
      const p = scriptedProvider([
        { calls: [{ name: "read_file", args: { path: "dur.py" } }, { name: "read_file", args: { path: "test_dur.py" } }] },
        { calls: [{ name: "write_file", args: { path: "dur.py", content: "def parse(s):\n    return 5400\n" } }] },
        { text: "Done." },
      ] as never);
      const e = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", maxSteps: 0 });
      await drain(e.run("fix dur.py", allowAll));
      const last = p.bodies.at(-1)!;
      assert.match(last, /TEST_MARK/, "test_dur.py was elided with dur.py");
      assert.doesNotMatch(last, /return 0/, "dur.py's stale copy is still on the wire");
      assert.match(readFileSync(join(ws.dir, "dur.py"), "utf8"), /5400/);
    } finally {
      ws.cleanup();
    }
  });
});
