/**
 * Two defects found by the lean-sessions study (PR #50), fixed as defaults.
 * Each test is built from the real case.
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
import { spawnSync } from "node:child_process";
import { readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { FILE_FP_HASH_MAX_BYTES, fileFingerprint } from "../src/files.js";
import { ELIDED_PREFIX, SHED_MIN_FREE, Transcript, canonPath } from "../src/transcript.js";
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
    t.push({ role: "user", content: "Acceptance criteria for this task: ...", molt: { criteria: true } });
    for (let i = 0; i < 40; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `s${i}` }, `a${i}`)] });
      t.push({ role: "tool", tool_call_id: `a${i}`, content: `${i}:${"o".repeat(3000)}` });
    }
    t.pushBarFailure("[molt] You indicated the task is complete, but 1 of 3 checks did not pass.");
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

  it("keeps the criteria and the live bar refusal verbatim through a fallback shed (review probe)", () => {
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "Fix the duration parser so `1h30m` parses." });
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("read_file", { path: "dur.py" }, "r0")] });
    t.push({ role: "tool", tool_call_id: "r0", content: "f".repeat(800) });
    const criteria = `Acceptance criteria for this task: ${"c".repeat(560)} CRITERIA_END`;
    t.push({ role: "user", content: criteria, molt: { criteria: true } });
    for (let i = 0; i < 40; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `s${i}` }, `a${i}`)] });
      t.push({ role: "tool", tool_call_id: `a${i}`, content: `${i}:${"o".repeat(3000)}` });
    }
    const failure = `[molt] attempt 1 was refused: ${"e".repeat(1150)} FAILURE_END`;
    t.pushBarFailure(failure);
    const steps = (from: number, n: number) => {
      for (let i = from; i < from + n; i++) {
        t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `t${i}` }, `b${i}`)] });
        t.push({ role: "tool", tool_call_id: `b${i}`, content: `${i}:${"p".repeat(3000)}` });
      }
    };
    steps(0, 4);
    const plan = t.planShed()!;
    assert.ok(plan.afterTokens / plan.beforeTokens < 0.5, `${plan.beforeTokens} -> ${plan.afterTokens}`);
    assert.equal(plan.carried.length, 2);
    t.commitShed(plan);
    const onWire = () => t.wire().map((m) => m.content ?? "");
    assert.ok(onWire().includes(failure), "the refusal's detail was digested");
    assert.ok(onWire().includes(criteria), "the criteria were digested");
    // And the next shed, a few steps on, keeps them too.
    steps(4, 10);
    const again = t.planShed()!;
    t.commitShed(again);
    assert.ok(onWire().includes(failure) && onWire().includes(criteria), "lost on the second shed");
    // A stale refusal is not carried: the next one replaces it.
    t.pushBarFailure("[molt] attempt 2 was refused: SECOND");
    steps(14, 10);
    t.commitShed(t.planShed()!);
    assert.ok(!onWire().includes(failure));
    assert.ok(onWire().some((c) => c.includes("SECOND")) && onWire().includes(criteria));
  });

  it("an interactive session whose last two exchanges hold most of the history is unchanged", () => {
    const t = new Transcript("S");
    for (let k = 0; k < 3; k++) {
      t.push({ role: "user", content: `ask ${k}` });
      const n = k === 0 ? 1 : 15;
      for (let i = 0; i < n; i++) {
        t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `${k}.${i}` }, `c${k}.${i}`)] });
        t.push({ role: "tool", tool_call_id: `c${k}.${i}`, content: "x".repeat(2000) });
      }
    }
    const plan = t.planShed()!;
    // The first exchange alone goes, though it frees well under 25%: the
    // two kept exchanges are the person's, not Maat's notes.
    assert.ok(plan.beforeTokens - plan.afterTokens < 0.25 * plan.beforeTokens);
    assert.equal(plan.cutAt, 3);
    assert.equal(plan.droppedCount, 3);
    assert.equal(plan.carried.length, 0);
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

  it("a plain cat whose rerun came back as a pointer is still invalidated by a write", () => {
    const t = new Transcript("S");
    step(t, [["bash", { command: "cat dur.py" }, "a", body("DUR_OLD")]]);
    step(t, [["bash", { command: "cat dur.py" }, "b", "[molt: this is the same bash call you made at step 1, and nothing has changed since.]"]]);
    step(t, [["write_file", { path: "dur.py", content: "new" }, "w", "wrote"]]);
    assert.equal(t.elideSupersededReads().elided, 1);
    assert.ok(!JSON.stringify(t.wire()).includes("DUR_OLD"));
  });

  it("a read_file answered with a pointer keeps the copy it points at, and a write still finds it", () => {
    const t = new Transcript("S");
    step(t, [["read_file", { path: "dur.py" }, "a", body("DUR_OLD")]]);
    step(t, [["read_file", { path: "dur.py" }, "b", "[molt: you have already been shown lines 1-40 of dur.py. Scroll up.]"]]);
    step(t, [["read_file", { path: "dur.py" }, "c", "[molt: this is the same read_file call you made at step 1, and nothing has changed since.]"]]);
    assert.equal(t.elideSupersededReads().elided, 0, "the original was elided under its own pointer");
    assert.ok(JSON.stringify(t.wire()).includes("DUR_OLD"));
    step(t, [["write_file", { path: "dur.py", content: "new" }, "w", "wrote"]]);
    assert.equal(t.elideSupersededReads().elided, 1);
    assert.ok(!JSON.stringify(t.wire()).includes("DUR_OLD"));
  });

  it("the rerun key does not depend on argument order", () => {
    const t = new Transcript("S");
    t.push({ role: "assistant", content: null, tool_calls: [{ id: "a", type: "function", function: { name: "bash", arguments: '{"timeout_s":600,"command":"make"}' } }] });
    t.push({ role: "tool", tool_call_id: "a", content: body("1 error") });
    t.push({ role: "assistant", content: null, tool_calls: [{ id: "b", type: "function", function: { name: "bash", arguments: '{"command":"make","timeout_s":600}' } }] });
    t.push({ role: "tool", tool_call_id: "b", content: body("built") });
    assert.equal(t.elideSupersededReads().elided, 1);
  });

  it("a background rerun is left alone: its result is the handle for the job", () => {
    const t = new Transcript("S");
    step(t, [["bash", { command: "npm run dev", background: true }, "a", body("started job 1")]]);
    step(t, [["bash", { command: "npm run dev", background: true }, "b", body("started job 2")]]);
    assert.equal(t.elideSupersededReads().elided, 0);
  });
});

/**
 * The engine's read-coverage map (`shown`) keyed a path as spelled. A read of
 * `dur.py`, then an edit of `./dur.py`, cleared the `./dur.py` key and left
 * `dur.py` marked as shown: the re-read came back as "you have already been
 * shown … nothing has changed since", while the transcript (which strips the
 * `./`) had already elided the old copy. The model held no copy of the file
 * it had just edited and was told not to read it again.
 */
describe("shown map: one spelling per file", () => {
  async function editThenReread(readAs: string, editAs: (dir: string) => string, rereadAs: string) {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "dur.py"), `def parse(s):\n    return 0  # OLD_MARK\n${"# pad\n".repeat(60)}`);
      const p = scriptedProvider([
        { calls: [{ name: "read_file", args: { path: readAs } }] },
        { calls: [{ name: "edit_file", args: { path: editAs(ws.dir), old_text: "return 0  # OLD_MARK", new_text: "return 5400  # NEW_MARK" } }] },
        { calls: [{ name: "read_file", args: { path: rereadAs } }] },
        { text: "Done." },
      ] as never);
      const e = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", maxSteps: 0 });
      await drain(e.run("fix dur.py", allowAll));
      assert.match(readFileSync(join(ws.dir, "dur.py"), "utf8"), /NEW_MARK/, "the edit did not land");
      const last = p.bodies.at(-1)!;
      assert.doesNotMatch(last, /you have already been shown/, "the re-read after the edit was answered with a pointer");
      assert.match(last, /NEW_MARK/, "the model has no copy of the edited file");
    } finally {
      ws.cleanup();
    }
  }

  it("read dur.py, edit ./dur.py, read dur.py: the re-read returns the new contents", () =>
    editThenReread("dur.py", () => "./dur.py", "dur.py"));
  it("read ./dur.py, edit dur.py, read ./dur.py", () => editThenReread("./dur.py", () => "dur.py", "./dur.py"));
  it("an absolute path inside the workspace is the same file", () =>
    editThenReread("dur.py", (dir) => join(dir, "dur.py"), "dur.py"));
  it("a/../dur.py is the same file", () => editThenReread("dur.py", () => "sub/../dur.py", "dur.py"));

  it("canonPath: one spelling, and a path outside the workspace stays as it is", () => {
    assert.equal(canonPath("./dur.py"), "dur.py");
    assert.equal(canonPath("././a//b/../dur.py"), "a/dur.py");
    assert.equal(canonPath("/ws/src/dur.py", "/ws"), "src/dur.py");
    assert.equal(canonPath("/ws", "/ws"), ".");
    assert.equal(canonPath("/other/dur.py", "/ws"), "/other/dur.py");
    assert.equal(canonPath("/ws2/dur.py", "/ws"), "/ws2/dur.py");
    assert.equal(canonPath("../dur.py"), "../dur.py");
    assert.equal(canonPath(""), "");
  });

  it("canonPath on Windows: backslashes are separators, and ..\\ is outside", () => {
    assert.equal(canonPath("C:\\ws\\src\\dur.py", "C:\\ws", win32), "src/dur.py");
    assert.equal(canonPath("src\\dur.py", "C:\\ws", win32), "src/dur.py");
    assert.equal(canonPath(".\\src\\..\\dur.py", "C:\\ws", win32), "dur.py");
    assert.equal(canonPath("C:\\ws", "C:\\ws", win32), ".");
    assert.equal(canonPath("C:\\ws2\\dur.py", "C:\\ws", win32), "C:/ws2/dur.py");
    assert.equal(canonPath("D:\\ws\\dur.py", "C:\\ws", win32), "D:/ws/dur.py");
    // relative("C:\\ws\\a", "C:\\ws\\b") is "..\\b": outside, so it stays absolute.
    assert.equal(canonPath("C:\\ws\\b\\x.py", "C:\\ws\\a", win32), "C:/ws/b/x.py");
    // On POSIX a backslash is a file-name character, not a separator.
    assert.equal(canonPath("src\\dur.py", "/ws"), "src\\dur.py");
  });

  it("the transcript folds an absolute path inside its workspace: read /ws/dur.py, edit dur.py", () => {
    const t = new Transcript("S", "/ws");
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("read_file", { path: "/ws/dur.py" }, "a")] });
    t.push({ role: "tool", tool_call_id: "a", content: `DUR_OLD\n${"x".repeat(2000)}` });
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("edit_file", { path: "dur.py", old_text: "x", new_text: "y" }, "e")] });
    t.push({ role: "tool", tool_call_id: "e", content: "edited" });
    assert.equal(t.elideSupersededReads().elided, 1);
    assert.ok(!JSON.stringify(t.wire()).includes("DUR_OLD"));
  });

  it("the transcript keys elision the same way: a write to sub/../dur.py elides the read of dur.py", () => {
    const t = new Transcript("S");
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("read_file", { path: "dur.py" }, "a")] });
    t.push({ role: "tool", tool_call_id: "a", content: `DUR_OLD\n${"x".repeat(2000)}` });
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("edit_file", { path: "sub/../dur.py", old_text: "x", new_text: "y" }, "e")] });
    t.push({ role: "tool", tool_call_id: "e", content: "edited" });
    assert.equal(t.elideSupersededReads().elided, 1);
  });
});

/**
 * "You have already been shown … nothing has changed since" was a claim the
 * engine never checked. A bash `sed -i`, a generator or the person's editor
 * changes the file behind the file tools' back, and the re-read was still
 * answered with the pointer. Each entry now carries a fingerprint of the file
 * (size, mtime, and a hash under 1 MB), re-taken before a pointer is sent.
 */
describe("shown map: the pointer is checked against the file", () => {
  async function reread(change: (dir: string) => object, setup?: (dir: string) => void) {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "x.py"), "value = 1  # OLD_MARK\n");
      setup?.(ws.dir);
      const p = scriptedProvider([
        { calls: [{ name: "read_file", args: { path: "x.py" } }] },
        { calls: [change(ws.dir)] },
        { calls: [{ name: "read_file", args: { path: "x.py" } }] },
        { text: "Done." },
      ] as never);
      const e = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", maxSteps: 0 });
      await drain(e.run("look at x.py", allowAll));
      const tools = (JSON.parse(p.bodies.at(-1)!) as { messages: { role: string; content: string }[] }).messages.filter((m) => m.role === "tool");
      return tools.at(-1)!.content;
    } finally {
      ws.cleanup();
    }
  }

  it("bash sed -i changes the file: the re-read returns the new contents", async () => {
    const got = await reread(() => ({ name: "bash", args: { command: "sed -i.bak 's/OLD_MARK/NEW_MARK/' x.py" } }));
    assert.doesNotMatch(got, /already been shown/);
    assert.match(got, /NEW_MARK/);
  });

  it("bash printf > x.py changes the file: the re-read returns the new contents", async () => {
    const got = await reread(() => ({ name: "bash", args: { command: "printf 'value = 2  # NEW_MARK\\n' > x.py" } }));
    assert.doesNotMatch(got, /already been shown/);
    assert.match(got, /NEW_MARK/);
  });

  it("same size, same mtime: the hash catches the change", async () => {
    // Both versions are the same length and stamped with the same whole-second
    // mtime, so size and mtime match exactly and only the content differs.
    const T = 1_700_000_000;
    const got = await reread(
      () => ({
        name: "bash",
        args: {
          command:
            `node -e "const fs=require('fs');fs.writeFileSync('x.py','value = 1  # NEW_MARK\\n');` +
            `fs.utimesSync('x.py',${T},${T})"`,
        },
      }),
      (dir) => utimesSync(join(dir, "x.py"), T, T),
    );
    assert.doesNotMatch(got, /already been shown/);
    assert.match(got, /NEW_MARK/);
  });

  it("an unchanged file still gets the pointer", async () => {
    const got = await reread(() => ({ name: "bash", args: { command: "true" } }));
    assert.match(got, /already been shown/);
  });

  it("a deleted file gives an error, not a pointer", async () => {
    const got = await reread(() => ({ name: "bash", args: { command: "rm x.py" } }));
    assert.doesNotMatch(got, /already been shown/);
    assert.match(got, /no such file|ENOENT|not found/i);
  });
});

describe("shown map: the fingerprint is taken around the read", () => {
  async function twoReads(rig: (e: Engine, dir: string) => void) {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "x.py"), "value = 1  # OLD_MARK\n");
      const p = scriptedProvider([
        { calls: [{ name: "read_file", args: { path: "x.py" } }] },
        // A different call over the same lines: only the coverage pointer
        // ("already been shown") can answer it, not the byte-compared
        // same-call pointer.
        { calls: [{ name: "read_file", args: { path: "x.py", limit: 50 } }] },
        { text: "Done." },
      ] as never);
      const e = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", maxSteps: 0 });
      rig(e, ws.dir);
      const events = await drain(e.run("look at x.py", allowAll));
      const tools = (JSON.parse(p.bodies.at(-1)!) as { messages: { role: string; content: string }[] }).messages.filter((m) => m.role === "tool");
      return { first: tools.at(-2)!.content, second: tools.at(-1)!.content, events: JSON.stringify(events) };
    } finally {
      ws.cleanup();
    }
  }

  it("a write that lands right after the read is not recorded as what was shown", async () => {
    const { first, second } = await twoReads((e, dir) => {
      const inner = e as unknown as { readText(abs: string): Promise<string> };
      const orig = inner.readText.bind(e);
      let once = true;
      inner.readText = async (abs: string) => {
        const text = await orig(abs);
        if (once && abs.endsWith("x.py")) {
          once = false;
          writeFileSync(join(dir, "x.py"), "value = 2  # NEW_MARK\n");
        }
        return text;
      };
    });
    assert.match(first, /OLD_MARK/);
    assert.doesNotMatch(second, /already been shown/, "the pointer claimed nothing had changed");
    assert.match(second, /NEW_MARK/);
  });

  it("control: the same shape, with nothing changing, gets the pointer", async () => {
    const { second } = await twoReads(() => {});
    assert.match(second, /already been shown/);
  });

  it("an unknown (null) fingerprint never matches: no pointer", async () => {
    const { second } = await twoReads((e) => {
      (e as unknown as { fingerprint(abs: string): Promise<string | null> }).fingerprint = async () => null;
    });
    assert.doesNotMatch(second, /already been shown/);
    assert.match(second, /OLD_MARK/);
  });

  it("a worker whose fingerprint call rejects: the read still succeeds, with no pointer", async () => {
    const { first, second } = await twoReads((e) => {
      Object.defineProperty(e, "workerFs", {
        get: () => ({
          read: async (abs: string) => readFileSync(abs, "utf8"),
          fingerprint: async () => {
            throw new Error("helper died");
          },
        }),
      });
    });
    assert.match(first, /OLD_MARK/);
    assert.match(second, /OLD_MARK/);
    assert.doesNotMatch(second, /already been shown|helper died|tool error/);
  });

  it("the worker's fs-helper takes the same fingerprint, and hashes only under the cap", () => {
    const ws = workspace();
    try {
      const small = join(ws.dir, "small.txt");
      const big = join(ws.dir, "big.txt");
      writeFileSync(small, "hello\n");
      writeFileSync(big, Buffer.alloc(FILE_FP_HASH_MAX_BYTES + 1, 97));
      const helper = fileURLToPath(new URL("../src/fs-helper.js", import.meta.url));
      const input = [small, big, join(ws.dir, "missing")]
        .map((f, i) => JSON.stringify({ id: i, op: "fingerprint", args: [f] }))
        .join("\n");
      const r = spawnSync(process.execPath, [helper], { input: input + "\n", encoding: "utf8" });
      const got = new Map(r.stdout.trim().split("\n").map((l) => {
        const m = JSON.parse(l) as { id: number; value: string | null };
        return [m.id, m.value] as const;
      }));
      assert.equal(got.get(0), fileFingerprint(small));
      assert.equal(got.get(0)!.split(":").length, 3, "a small file is hashed");
      assert.equal(got.get(1), fileFingerprint(big));
      assert.equal(got.get(1)!.split(":").length, 2, "a file over the cap is stat-only");
      assert.equal(got.get(2), null);
    } finally {
      ws.cleanup();
    }
  });
});
