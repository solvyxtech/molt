/**
 * Executable objections (`--review-executable`, MAAT_REVIEW_EXECUTABLE=1):
 * an independent reviewer's objection counts only when the command it came
 * with ran on the work and demonstrated the failure.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { stateDir } from "../src/statedir.js";
import {
  REVIEW_SYSTEM,
  REVIEW_SYSTEM_EXECUTABLE,
  judgeObjectionRun,
  reviewClaim,
  type ExecutableReview,
  type ObjectionRun,
} from "../src/review.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const TASK = "Write out.txt containing exactly 365 lines. Do not create any other file.";
const objection = (command?: string, shows?: string) =>
  JSON.stringify({ violations: [{ quote: "exactly 365 lines", evidence: "the receipt shows 366", ...(command !== undefined ? { command } : {}), ...(shows !== undefined ? { shows } : {}) }] });
const clean = JSON.stringify({ violations: [] });

function replying(texts: string[], systems?: string[]): typeof fetch {
  let i = 0;
  return (async (_u: string, init?: RequestInit) => {
    try {
      const body = JSON.parse(String(init?.body ?? "{}")) as { messages?: { role: string; content: string }[] };
      const sys = body.messages?.find((m) => m.role === "system")?.content;
      if (systems && sys !== undefined) systems.push(sys);
    } catch {
      // not JSON: nothing to record
    }
    const content = texts[Math.min(i++, texts.length - 1)]!;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
}

/** A runner that answers from a table and records what it was asked to run. */
function runner(table: Record<string, ObjectionRun>): ExecutableReview & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    run: async (command) => {
      ran.push(command);
      return table[command] ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}

const ask = (texts: string[], systems?: string[]) => ({ baseUrl: "http://p.test/v1", model: "m", fetchFn: replying(texts, systems) });

describe("executable objections: reviewClaim", () => {
  it("an unsubstantiated objection does not veto: no command, a passing command, a command that cannot run", async () => {
    const exec = runner({
      'test "$(wc -l < out.txt)" -eq 365': { code: 0, stdout: "", stderr: "" },
      "cat nope.txt": { code: 1, stdout: "", stderr: "cat: nope.txt: No such file or directory" },
    });
    const r = await reviewClaim({
      task: TASK,
      receipt: "r",
      ask: ask([objection(), objection('test "$(wc -l < out.txt)" -eq 365'), objection("cat nope.txt")]),
      executable: exec,
    });
    assert.ok(r);
    assert.deepEqual([r.confirmed, r.votes, r.violations], [true, "0/3", []], "three prose objections, none demonstrated");
    assert.deepEqual(r.objections!.map((o) => o.result), ["no-command", "passed", "did-not-run"]);
    assert.deepEqual(r.objections!.map((o) => o.vote), [1, 2, 3]);
    assert.equal(r.objections![1]!.command, 'test "$(wc -l < out.txt)" -eq 365');
    assert.equal(r.objections![1]!.exit, 0);
  });

  it("a substantiated objection vetoes: its command fails on the work", async () => {
    const cmd = 'test "$(wc -l < out.txt)" -eq 365';
    const exec = runner({ [cmd]: { code: 1, stdout: "", stderr: "" } });
    const r = await reviewClaim({ task: TASK, receipt: "r", ask: ask([objection(cmd), objection(cmd), clean]), executable: exec });
    assert.ok(r);
    assert.deepEqual([r.confirmed, r.votes], [false, "2/3"]);
    assert.equal(r.violations[0]!.quote, "exactly 365 lines");
    assert.match(r.violations[0]!.evidence, /shown by `test .*`: exited 1/);
    assert.deepEqual(exec.ran, [cmd], "the same command runs once, however many reviewers raise it");
  });

  it("a command that prints the offending value it named demonstrates it; one that does not, does not", async () => {
    const exec = runner({ "awk 'NR==366' out.txt": { code: 0, stdout: "extra line\n", stderr: "" } });
    const shown = await reviewClaim({ task: TASK, receipt: "r", votes: 1, ask: ask([objection("awk 'NR==366' out.txt", "extra line")]), executable: exec });
    assert.deepEqual([shown!.confirmed, shown!.votes], [false, "1/1"]);
    const wrong = await reviewClaim({ task: TASK, receipt: "r", votes: 1, ask: ask([objection("awk 'NR==366' out.txt", "something else")]), executable: exec });
    assert.deepEqual([wrong!.confirmed, wrong!.votes, wrong!.objections![0]!.result], [true, "0/1", "passed"]);
    // A substring of a line is not the line: "40" is not "    40 /".
    assert.equal(judgeObjectionRun({ code: 0, stdout: "    40 /\n", stderr: "" }, "40").result, "passed");
  });

  it("a mutating objection command is rejected by lint L15 and never run", async () => {
    const exec = runner({});
    const muts = ["rm out.txt", "sed -i 's/x/y/' out.txt", "echo 1 > out.txt", "git checkout -- out.txt"];
    const r = await reviewClaim({ task: TASK, receipt: "r", votes: muts.length, ask: ask(muts.map((m) => objection(m))), executable: exec });
    assert.ok(r);
    assert.deepEqual([r.confirmed, r.votes], [true, "0/4"]);
    assert.deepEqual(r.objections!.map((o) => o.result), ["lint", "lint", "lint", "lint"]);
    assert.match(r.objections![0]!.why!, /^L15-mutates/);
    assert.deepEqual(exec.ran, [], "nothing that would change the work is run");
  });

  it("a timed-out or killed command demonstrates nothing", () => {
    assert.equal(judgeObjectionRun({ code: 1, stdout: "", stderr: "", timedOut: true }, undefined).result, "did-not-run");
    assert.equal(judgeObjectionRun({ code: null, stdout: "", stderr: "" }, undefined).result, "did-not-run");
    assert.equal(judgeObjectionRun({ code: 127, stdout: "", stderr: "x: command not found" }, undefined).result, "did-not-run");
    assert.equal(judgeObjectionRun({ code: 1, stdout: "", stderr: "" }, undefined).result, "demonstrated");
  });

  it("over the command budget, the rest are notes", async () => {
    const exec = { ...runner({ "false": { code: 1, stdout: "", stderr: "" }, "! true": { code: 1, stdout: "", stderr: "" } }), maxCommands: 1 };
    const r = await reviewClaim({ task: TASK, receipt: "r", votes: 2, ask: ask([objection("false"), objection("! true")]), executable: exec });
    assert.deepEqual(r!.objections!.map((o) => o.result), ["demonstrated", "not-run"]);
    assert.equal(r!.votes, "1/2");
  });

  it("with the option off nothing changes: same prompt, prose objections still count, no objections field", async () => {
    const systems: string[] = [];
    const r = await reviewClaim({ task: TASK, receipt: "r", ask: ask([objection("true"), objection("true"), clean], systems) });
    assert.deepEqual(r, { confirmed: false, votes: "2/3", violations: [{ quote: "exactly 365 lines", evidence: "the receipt shows 366" }] });
    assert.ok(!("objections" in r!));
    assert.ok(systems.length === 3 && systems.every((s) => s === REVIEW_SYSTEM), "the off prompt is the one it always was");
    assert.notEqual(REVIEW_SYSTEM_EXECUTABLE, REVIEW_SYSTEM);
    assert.match(REVIEW_SYSTEM_EXECUTABLE, /"command"/);
  });
});

describe("executable objections in a turn", () => {
  const check = { name: "made", kind: "command" as const, run: "test -f out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task"] };
  const engineFor = (dir: string, turns: ScriptedTurn[], reviewExecutable?: boolean) => {
    const provider = scriptedProvider(turns);
    const engine = new Engine({
      baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null,
      receipts: new Receipts(dir), stream: false, autonomy: "high", review: { votes: 3 },
      ...(reviewExecutable ? { reviewExecutable: true } : {}),
    });
    return { engine, provider };
  };
  const indexRows = (dir: string) =>
    readFileSync(`${stateDir(dir, "receipts")}/index.jsonl`, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);

  it("false objections whose commands pass on the work leave the claim verified, recorded as notes", async () => {
    const ws = workspace();
    try {
      // The work is one line; the reviewers' own command checks for one line and passes.
      const v = objection('test "$(wc -l < out.txt)" -eq 1');
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: v }, { text: v }, { text: v },
      ], true);
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "verified");
      assert.deepEqual([end.review?.confirmed, end.review?.votes], [true, "0/3"]);
      assert.deepEqual(end.review?.objections?.map((o) => [o.result, o.exit]), [["passed", 0], ["passed", 0], ["passed", 0]]);
      assert.equal(provider.calls, 5, "no nudge: two work steps, three reviews");
      const notes = events.filter((e) => e.kind === "info" && e.text.startsWith("unsubstantiated objection"));
      assert.equal(notes.length, 3);
      const row = indexRows(ws.dir).at(-1)!;
      assert.equal((row.objections as { command: string }[])[0]!.command, 'test "$(wc -l < out.txt)" -eq 1', "the receipt row carries each objection and its command");
    } finally {
      ws.cleanup();
    }
  });

  it("a demonstrated objection is put to the model, runs on a copy, and leaves the work untouched", async () => {
    const ws = workspace();
    try {
      const v = objection('test "$(wc -l < out.txt)" -eq 365');
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: v }, { text: v }, { text: v },
        { text: "Done." },
        { text: v }, { text: v }, { text: v },
      ], true);
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-checks"]);
      assert.deepEqual([end.review?.confirmed, end.review?.votes], [false, "3/3"]);
      assert.ok(provider.bodies[5]!.includes("independent reviewers who read only the task and your receipt found"));
      assert.ok(provider.bodies[5]!.includes("shown by"), "the nudge names the command that demonstrated it");
      assert.equal(readFileSync(`${ws.dir}/out.txt`, "utf8"), "x\n");
    } finally {
      ws.cleanup();
    }
  });

  it("with the option off a turn is unchanged: prose objections veto and nothing is run or recorded", async () => {
    const ws = workspace();
    try {
      const v = objection("false");
      const { engine } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: v }, { text: v }, { text: v },
        { text: "Done." },
        { text: v }, { text: v }, { text: v },
      ]);
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.deepEqual([end.review?.confirmed, end.review?.votes], [false, "3/3"]);
      assert.ok(end.review && !("objections" in end.review));
      assert.ok(!events.some((e) => e.kind === "info" && e.text.startsWith("unsubstantiated")));
      assert.ok(indexRows(ws.dir).every((r) => !("objections" in r)));
    } finally {
      ws.cleanup();
    }
  });

  it("hidden check commands are masked in the objections put to the worker", async () => {
    const ws = workspace();
    try {
      const hidden = { ...check, name: "count", run: "test -f out.txt && grep -q x out.txt", hidden: true };
      // The reviewer read the full receipt and quotes the hidden command in its own.
      const v = objection("test -f out.txt && grep -q x out.txt && false");
      const { engine, provider } = engineFor(ws.dir, [
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "x\n" } }] },
        { text: "Wrote out.txt." },
        { text: v }, { text: v }, { text: v },
        { text: "Done." },
        { text: v }, { text: v }, { text: v },
      ], true);
      await drain(engine.run(TASK, allowAll, { taskChecks: [hidden] }));
      assert.ok(provider.bodies[5]!.includes("shown by"));
      assert.ok(!provider.bodies[5]!.includes(hidden.run), "the nudge does not quote the hidden command");
    } finally {
      ws.cleanup();
    }
  });
});
