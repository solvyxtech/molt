/**
 * An unattended worker is kept on its task.
 *
 * 2026-10-07, the ml4b bench lanes: a worker spent its whole time budget,
 * 90-125 tool calls a task, reading the other tasks' logs in the shared bench
 * folder and Maat's own `.maat/` records instead of working. While a job with
 * hidden checks runs, the file tools refuse paths outside the project and
 * under `.maat/`; bash is not blocked but is journalled when it reaches
 * there; and a run of tool calls that changes no file is nudged once, then
 * stopped and judged on disk ("ended: no progress").
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { bashReach, noProgressCallsFromEnv, outsideTask, taskPathsIn } from "../src/scope.js";
import type { Check, EngineEvent } from "../src/types.js";
import { allowAll, drain, scriptedProvider, type ScriptedTurn } from "./helpers.js";

const greet = (hidden = true): Check => ({
  name: "greeting", kind: "command", run: "grep -qx hello out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden,
  author: { kind: "judge", model: "judge-j" },
});

/** A bench-like layout: this task's folder beside another task's folder and log. */
function bench() {
  const root = mkdtempSync(join(tmpdir(), "maat-probe-"));
  const dir = join(root, "this-task");
  const other = join(root, "other-task");
  mkdirSync(dir);
  mkdirSync(other);
  writeFileSync(join(dir, "in.txt"), "hello\n");
  writeFileSync(join(other, "answer.txt"), "the other task's answer\n");
  writeFileSync(join(root, "other-task.log"), '{"kind":"job_end","claim":"verified"}\n');
  mkdirSync(join(dir, ".maat", "receipts"), { recursive: true });
  writeFileSync(join(dir, ".maat", "receipts", "0000-refused.md"), "# a receipt\n");
  mkdirSync(join(dir, ".maat", "out"), { recursive: true });
  writeFileSync(join(dir, ".maat", "out", "call_9.txt"), "spilled output\n");
  return { root, dir, other, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function engineIn(dir: string, turns: ScriptedTurn[], extra: Partial<ConstructorParameters<typeof Engine>[0]> = {}) {
  const provider = scriptedProvider(turns);
  const journal = new Journal(dir);
  const engine = new Engine({
    baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null, stream: false,
    autonomy: "high", unattended: true, sandbox: true, journal, receipts: new Receipts(dir), noProgressCalls: 0, ...extra,
  });
  return { engine, provider, journal };
}

/** What each tool call returned, in order, from the tool events. */
const toolResults = (events: EngineEvent[]) =>
  events.filter((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool").map((e) => ({ name: e.name, detail: e.detail, preview: String(e.preview ?? "") }));

const end = (events: EngineEvent[]) => {
  const e = events.find((x) => x.kind === "job_end");
  assert.ok(e && e.kind === "job_end");
  return e;
};

const call = (name: string, args: Record<string, unknown>) => ({ name, args });

describe("file tools refuse paths outside the task (unattended, hidden checks)", () => {
  it("refuses another task's folder and log, the bench root, and .maat/; reads the project, Maat's spilled output and paths the task names", async () => {
    const b = bench();
    try {
      const named = join(b.root, "shared-config.toml");
      writeFileSync(named, "port = 1\n");
      const task = `Write out.txt with the greeting from in.txt. The port is set in ${named}.`;
      const { engine, journal } = engineIn(b.dir, [
        { calls: [
          call("list_dir", { path: ".." }),
          call("read_file", { path: "../other-task/answer.txt" }),
          call("read_file", { path: join(b.root, "other-task.log") }),
          call("grep", { pattern: "verified", path: b.root }),
          call("read_file", { path: ".maat/receipts/0000-refused.md" }),
          call("list_dir", { path: ".maat" }),
          call("grep", { pattern: "greeting", path: ".maat/receipts" }),
          call("inspect", { path: "../other-task/answer.txt" }),
        ] },
        { calls: [
          call("read_file", { path: "in.txt" }),
          call("read_file", { path: ".maat/out/call_9.txt" }),
          call("read_file", { path: named }),
          call("list_dir", { path: "." }),
        ] },
        { calls: [call("write_file", { path: "out.txt", content: "hello\n" })] },
        { text: "Done." },
      ]);
      const events = await drain(engine.run(task, allowAll, { taskChecks: [greet()] }));
      const results = toolResults(events);
      const first = results.slice(0, 8);
      for (const r of first) assert.match(r.preview, /^refused: .* (is outside this task|is Maat's own record of this job)/, `${r.name} ${r.detail}: ${r.preview}`);
      assert.ok(!first.some((r) => r.preview.includes("the other task's answer") || r.preview.includes("a receipt")), "nothing outside the task was shown");
      assert.match(first[0]!.preview, /outside this task/);
      assert.match(first[4]!.preview, /Maat's own record of this job \(\.maat\/\)/);
      const [own, spilled, namedRead] = results.slice(8, 11);
      assert.match(own!.preview, /hello/);
      assert.match(spilled!.preview, /spilled output/, "the output Maat points the model at stays readable");
      assert.match(namedRead!.preview, /port = 1/, "a path the task names is part of the task");
      assert.equal(end(events).outcome, "verified");

      const notes = Journal.read(journal.path).filter((r) => r.kind === "outside_task");
      assert.equal(notes.length, 8, "every refusal is journalled");
      assert.ok(notes.every((n) => n.data.refused === true));
      assert.deepEqual(notes.map((n) => n.data.reach), ["outside", "outside", "outside", "outside", "state", "state", "state", "outside"]);
      assert.deepEqual(notes.map((n) => n.data.tool), ["list_dir", "read_file", "read_file", "grep", "read_file", "list_dir", "grep", "inspect"]);
    } finally {
      b.cleanup();
    }
  });

  it("bash is not blocked, but a command naming .maat/ or a path outside the project is journalled", async () => {
    const b = bench();
    try {
      const { engine, journal } = engineIn(b.dir, [
        { calls: [call("bash", { command: "cat ../other-task/answer.txt > seen.txt; ls .maat/receipts >> seen.txt" })] },
        { calls: [call("bash", { command: "python3 -c 'print(1)' > /dev/null && cp in.txt out.txt" })] },
        { text: "Done." },
      ]);
      const events = await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet()] }));
      assert.match(readFileSync(join(b.dir, "seen.txt"), "utf8"), /the other task's answer[\s\S]*0000-refused\.md/, "bash ran");
      assert.equal(end(events).outcome, "verified");
      const notes = Journal.read(journal.path).filter((r) => r.kind === "outside_task");
      assert.equal(notes.length, 1, "the plain command is not noted");
      assert.equal(notes[0]!.data.tool, "bash");
      assert.equal(notes[0]!.data.refused, false);
      assert.equal(notes[0]!.data.stateDir, true);
      assert.deepEqual(notes[0]!.data.outside, ["../other-task/answer.txt"]);
      assert.match(String(notes[0]!.data.command), /cat \.\.\/other-task/);
    } finally {
      b.cleanup();
    }
  });

  it("only while a job with hidden checks runs unattended: a person, or visible checks, read where they like", async () => {
    for (const [extra, hidden] of [[{ unattended: false }, true], [{}, false]] as const) {
      const b = bench();
      try {
        const { engine, journal } = engineIn(b.dir, [
          { calls: [call("read_file", { path: ".maat/receipts/0000-refused.md" }), call("read_file", { path: "../other-task/answer.txt" })] },
          { calls: [call("write_file", { path: "out.txt", content: "hello\n" })] },
          { text: "Done." },
        ], extra);
        const events = await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet(hidden)] }));
        const [receipt, answer] = toolResults(events);
        assert.match(receipt!.preview, /a receipt/);
        assert.match(answer!.preview, /the other task's answer/);
        assert.equal(Journal.read(journal.path).filter((r) => r.kind === "outside_task").length, 0);
      } finally {
        b.cleanup();
      }
    }
  });
});

describe("scope helpers", () => {
  it("outsideTask, bashReach and taskPathsIn", () => {
    const b = bench();
    try {
      assert.equal(outsideTask(b.dir, "in.txt", { tool: "read_file" }), null);
      assert.equal(outsideTask(b.dir, ".", { tool: "list_dir" }), null);
      assert.equal(outsideTask(b.dir, "../other-task", { tool: "list_dir" })?.kind, "outside");
      assert.equal(outsideTask(b.dir, ".maat", { tool: "list_dir" })?.kind, "state");
      assert.equal(outsideTask(b.dir, ".maat/out/call_9.txt", { tool: "read_file" }), null);
      assert.equal(outsideTask(b.dir, ".maat/out", { tool: "list_dir" })?.kind, "state", "the spill folder is not listable");
      assert.equal(outsideTask(b.dir, ".maat/log/x.jsonl", { tool: "read_file" })?.kind, "state");
      assert.equal(outsideTask(b.dir, "/etc/app/config.toml", { tool: "read_file", taskPaths: taskPathsIn("edit /etc/app/config.toml") }), null);
      assert.equal(outsideTask(b.dir, "/etc/app/other.toml", { tool: "read_file", taskPaths: taskPathsIn("edit /etc/app/config.toml") })?.kind, "outside", "not its neighbours");
      assert.equal(outsideTask(b.dir, "/etc/app/conf.d/x.conf", { tool: "read_file", taskPaths: taskPathsIn("put it in /etc/app/conf.d.") }), null, "under a named folder");
      assert.equal(outsideTask(b.dir, "/etc/passwd", { tool: "read_file", taskPaths: taskPathsIn("edit /etc/app/config.toml") })?.kind, "outside");
      assert.deepEqual(bashReach(b.dir, "grep -r x /usr/local/lib/node_modules/@solvyx/molt/dist | head"), { stateDir: false, outside: ["/usr/local/lib/node_modules/@solvyx/molt/dist"] });
      assert.deepEqual(bashReach(b.dir, "/usr/bin/env python3 run.py 2>/dev/null; cat ./x | sed 's/a/b/'"), { stateDir: false, outside: [] });
      assert.deepEqual(bashReach(b.dir, "find /work -name '*.log'; cd .. && ls"), { stateDir: false, outside: ["/work", ".."] });
      assert.equal(bashReach(b.dir, "cat .maat/log/abc.jsonl").stateDir, true);
      assert.equal(bashReach(b.dir, "cat src/maat.ts").stateDir, false);
      assert.equal(noProgressCallsFromEnv({}), 30);
      assert.equal(noProgressCallsFromEnv({ MAAT_NO_PROGRESS_CALLS: "12" }), 12);
      assert.equal(noProgressCallsFromEnv({ MAAT_NO_PROGRESS_CALLS: "0" }), 0);
      assert.equal(noProgressCallsFromEnv({ MAAT_NO_PROGRESS_CALLS: "lots" }), 30);
    } finally {
      b.cleanup();
    }
  });
});

describe("no-progress guard (unattended)", () => {
  const reads = (n: number) => Array.from({ length: n }, (_, i) => call("read_file", { path: "in.txt", offset: i % 2 }));

  it("nudges once after N calls that change nothing, then ends the turn after N more and judges the work on disk", async () => {
    const b = bench();
    try {
      // Two calls a step, forever (the last scripted turn repeats).
      const { engine, provider, journal } = engineIn(b.dir, [{ calls: reads(2) }], { noProgressCalls: 4 });
      const events = await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet()] }));
      const nudges = provider.requests().map((r) => JSON.stringify(r)).map((s) => s.includes("changed no file in the project"));
      // Calls 1-4 (steps 1-2) earn the nudge, sent with request 3; calls 5-8 (steps 3-4) end the turn.
      assert.deepEqual(nudges, [false, false, true, true], "the nudge goes out once, after the 4th call, and nothing is asked after the 8th");
      assert.equal(provider.calls, 4);
      const e = end(events);
      assert.equal(e.endedBy, "no-progress");
      assert.notEqual(e.outcome, "verified");
      assert.ok(events.some((x) => x.kind === "proof_start"), "the sealed checks ran on the tree as it stood");
      assert.ok(events.some((x) => x.kind === "info" && /no progress: 8 tool calls in a row changed no file/.test(x.text)));
      const dir = join(b.dir, ".maat", "receipts");
      const receipt = readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "0000-refused.md").map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      assert.match(receipt, /ended: no progress/);
      const rows = Journal.read(journal.path).filter((r) => r.kind === "no_progress");
      assert.deepEqual(rows.map((r) => [r.data.action, r.data.calls]), [["nudged", 4], ["stopped", 8]]);
    } finally {
      b.cleanup();
    }
  });

  it("a stop on passing work is recorded, but the outcome is unverified: the model never said done", async () => {
    const b = bench();
    try {
      writeFileSync(join(b.dir, "out.txt"), "hello\n");
      const { engine } = engineIn(b.dir, [{ calls: reads(1) }], { noProgressCalls: 2 });
      const e = end(await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet()] })));
      assert.equal(e.endedBy, "no-progress");
      assert.equal(e.outcome, "unverified");
      assert.equal(e.passedAtEnd, true);
    } finally {
      b.cleanup();
    }
  });

  it("a change after the nudge resets the count, and the turn finishes normally", async () => {
    const b = bench();
    try {
      const { engine, provider } = engineIn(b.dir, [
        { calls: reads(3) },
        { calls: reads(2) },
        { calls: [call("write_file", { path: "out.txt", content: "hello\n" })] },
        { calls: reads(3) },
        { text: "Done." },
      ], { noProgressCalls: 3 });
      const events = await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet()] }));
      const e = end(events);
      assert.equal(e.endedBy, undefined);
      assert.equal(e.outcome, "verified");
      const nudged = provider.requests().filter((r) => JSON.stringify(r).includes("changed no file in the project")).length;
      assert.ok(nudged >= 1, "nudged before the write");
      assert.equal(events.filter((x) => x.kind === "info" && /told the model to finish or stop/.test(x.text)).length, 2, "and once more after the reset");
    } finally {
      b.cleanup();
    }
  });

  it("is off when somebody is watching, and when set to 0", async () => {
    for (const extra of [{ unattended: false, noProgressCalls: 2 }, { noProgressCalls: 0 }]) {
      const b = bench();
      try {
        const { engine } = engineIn(b.dir, [...Array.from({ length: 6 }, () => ({ calls: reads(1) })), { calls: [call("write_file", { path: "out.txt", content: "hello\n" })] }, { text: "Done." }], extra);
        const events = await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet()] }));
        assert.equal(end(events).outcome, "verified");
        assert.ok(!events.some((x) => x.kind === "info" && /no progress/.test(x.text)));
      } finally {
        b.cleanup();
      }
    }
  });

  it("MAAT_NO_PROGRESS_CALLS sets N when the config does not", async () => {
    const b = bench();
    const was = process.env.MAAT_NO_PROGRESS_CALLS;
    process.env.MAAT_NO_PROGRESS_CALLS = "1";
    try {
      const { engine } = engineIn(b.dir, [{ calls: reads(1) }], { noProgressCalls: undefined });
      const e = end(await drain(engine.run("Write out.txt with the greeting from in.txt.", allowAll, { taskChecks: [greet()] })));
      assert.equal(e.endedBy, "no-progress");
    } finally {
      if (was === undefined) delete process.env.MAAT_NO_PROGRESS_CALLS;
      else process.env.MAAT_NO_PROGRESS_CALLS = was;
      b.cleanup();
    }
  });
});
