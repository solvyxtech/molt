/**
 * The graded gate: a hidden drafted check failing the same way twice no longer
 * ends the turn. Across Terminal-Bench the work was right 34 times and wrong 33
 * at that stop, so it decided the verdict on a coin flip. The check's command
 * is shown once, the turn goes on up to the attempt limit, and a pass that
 * follows is labelled; work bent to the shown check is refused.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { MAX_PROOF_ATTEMPTS } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const TASK = "Write out.txt containing a greeting. Valid for 365 days.";
const TASK_WITH_INPUT = "Read data.csv and write out.txt containing a greeting. Valid for 365 days.";

const hiddenChecks: Check[] = [
  { name: "made", kind: "command", run: "test -f out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden: true, author: { kind: "judge", model: "judge-j" } },
  { name: "too-strict", kind: "command", run: "grep -q 366 out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", "exact"], hidden: true, author: { kind: "judge", model: "judge-j" } },
];
const personChecks: Check[] = hiddenChecks.map((c) => ({ ...c, hidden: false }));

// Reveal is opt-in (--reveal-stuck) since v11: these tests are about the
// mechanism, so they turn it on; the default stop is pinned at the end.
function engineIn(dir: string, fetchFn: typeof fetch, extra: Record<string, unknown> = {}): Engine {
  return new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn, bar: null, stream: false, autonomy: "high", revealOnStuck: true, ...extra });
}

const write = (path: string, content: string) => ({ name: "write_file", args: { path, content } });

describe("graded gate: reveal by default", () => {
  it("a hidden check failing twice is shown once, the turn goes on, and the pass is labelled", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello again\n")] },
        { text: "Done again." },
        { calls: [write("out.txt", "hello 366\n")] },
        { text: "Fixed." },
      ]);
      const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK, allowAll, { taskChecks: hiddenChecks }));
      assert.equal(events.filter((e) => e.kind === "info" && /showing the model its command once/.test(e.text)).length, 1);
      assert.ok(!events.some((e) => e.kind === "proof_exhausted"), "no stop on the hidden check");
      const attempts = events.filter((e) => e.kind === "proof_start").length;
      assert.ok(attempts >= 3 && attempts <= MAX_PROOF_ATTEMPTS, `attempts ${attempts}`);
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "verified");
      assert.deepEqual(end.revealed, ["too-strict"]);
    } finally {
      ws.cleanup();
    }
  });

  it("the receipt of the verified claim names what was revealed", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello again\n")] },
        { text: "Done again." },
        { calls: [write("out.txt", "hello 366\n")] },
        { text: "Fixed." },
      ]);
      const receipts = new Receipts(ws.dir);
      await drain(engineIn(ws.dir, provider.fetchFn, { receipts }).run(TASK, allowAll, { taskChecks: hiddenChecks }));
      const dir = join(ws.dir, ".maat", "receipts");
      const accepted = readdirSync(dir).find((f) => f.endsWith("-accepted.md"));
      assert.ok(accepted, "an accepted receipt was written");
      assert.match(readFileSync(join(dir, accepted!), "utf8"), /was shown to the model after it failed the same way twice/);
    } finally {
      ws.cleanup();
    }
  });

  // Not refused: in an in-place task the named file is the deliverable.
  it("work that edits a task-named input after the reveal ends unverified, not verified and not refused", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "data.csv"), "a,b\n1,2\n");
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello again\n")] },
        { text: "Done again." },
        { calls: [write("data.csv", "a,b\n366,366\n"), write("out.txt", "hello 366\n")] },
        { text: "Fixed." },
      ]);
      const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK_WITH_INPUT, allowAll, { taskChecks: hiddenChecks }));
      assert.ok(events.some((e) => e.kind === "info" && /showing the model its command once/.test(e.text)));
      assert.ok(
        events.some((e) => e.kind === "info" && /changed data\.csv, an input the task names — this claim is unverified/.test(e.text)),
        "the reason is given",
      );
      assert.ok(!events.some((e) => e.kind === "proof_exhausted"), "not refused");
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "unverified");
      assert.equal(end.revealed, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it("a write to the environment after the reveal is refused too", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello again\n")] },
        { text: "Done again." },
        { calls: [write(".maat/notes.txt", "x"), write("out.txt", "hello 366\n")] },
        { text: "Fixed." },
      ]);
      const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK, allowAll, { taskChecks: hiddenChecks }));
      assert.ok(events.some((e) => e.kind === "error" && /claim refused: .*\.maat\/notes\.txt, part of the environment/.test(e.text)));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.notEqual(end.outcome, "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("a check a person wrote, stuck twice, still ends the turn", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello again\n")] },
        { text: "Done again." },
        { text: "unreached" },
      ]);
      const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK, allowAll, { taskChecks: personChecks }));
      assert.ok(events.some((e) => e.kind === "info" && /failed in exactly the same way twice/.test(e.text)));
      assert.ok(!events.some((e) => e.kind === "info" && /showing the model/.test(e.text)), "nothing revealed");
      assert.ok(events.some((e) => e.kind === "proof_exhausted"));
    } finally {
      ws.cleanup();
    }
  });

  // The ledger saw no write here: the change was made durable through bash.
  describe("a git commit after the reveal", () => {
    const git = (dir: string, ...a: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: dir, stdio: "ignore" });
    const turn = (finalCalls: { name: string; args: Record<string, unknown> }[]) => [
      { calls: [write("out.txt", "hello\n")] },
      { text: "Done." },
      { calls: [write("out.txt", "hello again\n")] },
      { text: "Done again." },
      { calls: [write("out.txt", "hello 366\n"), ...finalCalls] },
      { text: "Fixed." },
    ];
    const commit = (path: string) => ({ name: "bash", args: { command: `git add -f ${path} && git -c user.email=t@t -c user.name=t commit -qm fix` } });

    it("of a named input ends the claim unverified, like an edit to it", async () => {
      const ws = workspace();
      try {
        writeFileSync(join(ws.dir, "data.csv"), "a,b\n1,2\n");
        git(ws.dir, "init", "-q");
        git(ws.dir, "add", "data.csv");
        git(ws.dir, "commit", "-qm", "init");
        const provider = scriptedProvider(turn([commit("data.csv")]));
        const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK_WITH_INPUT, allowAll, { taskChecks: hiddenChecks }));
        assert.ok(events.some((e) => e.kind === "info" && /committed data\.csv with git, a file the check reads or the task names as an input — this claim is unverified/.test(e.text)));
        const end = events.find((e) => e.kind === "job_end");
        assert.ok(end && end.kind === "job_end");
        assert.equal(end.outcome, "unverified");
        assert.equal(end.revealed, undefined);
      } finally {
        ws.cleanup();
      }
    });

    it("of a tracked file the revealed check reads, though the task does not name it, ends unverified", async () => {
      const ws = workspace();
      try {
        writeFileSync(join(ws.dir, "fixture.txt"), "x\n");
        git(ws.dir, "init", "-q");
        git(ws.dir, "add", "fixture.txt");
        git(ws.dir, "commit", "-qm", "init");
        const reads: Check[] = [hiddenChecks[0]!, { ...hiddenChecks[1]!, run: "grep -q 366 out.txt && test -f fixture.txt" }];
        const provider = scriptedProvider(turn([commit("fixture.txt")]));
        const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK, allowAll, { taskChecks: reads }));
        assert.ok(events.some((e) => e.kind === "info" && /committed fixture\.txt with git/.test(e.text)));
        const end = events.find((e) => e.kind === "job_end");
        assert.ok(end && end.kind === "job_end" && end.outcome === "unverified");
      } finally {
        ws.cleanup();
      }
    });

    it("of a test file the task does not ask for is refused, like a write to one", async () => {
      const ws = workspace();
      try {
        git(ws.dir, "init", "-q");
        mkdirSync(join(ws.dir, "tests"));
        writeFileSync(join(ws.dir, "tests", "test_out.py"), "assert True\n");
        const provider = scriptedProvider(turn([commit("tests/test_out.py")]));
        const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK, allowAll, { taskChecks: hiddenChecks }));
        assert.ok(events.some((e) => e.kind === "error" && /claim refused: .*committed tests\/test_out\.py with git, a test or check file/.test(e.text)));
        const end = events.find((e) => e.kind === "job_end");
        assert.ok(end && end.kind === "job_end");
        assert.notEqual(end.outcome, "verified");
      } finally {
        ws.cleanup();
      }
    });

    it("of the model's own output is fine", async () => {
      const ws = workspace();
      try {
        git(ws.dir, "init", "-q");
        const provider = scriptedProvider(turn([commit("out.txt")]));
        const events = await drain(engineIn(ws.dir, provider.fetchFn).run(TASK, allowAll, { taskChecks: hiddenChecks }));
        const end = events.find((e) => e.kind === "job_end");
        assert.ok(end && end.kind === "job_end" && end.outcome === "verified");
      } finally {
        ws.cleanup();
      }
    });
  });

  it("by default (no revealOnStuck) a repeat failure of hidden checks stops the turn, work left as it is", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done again." },
        { text: "Done a third time." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: hiddenChecks }));
      assert.ok(!events.some((e) => e.kind === "info" && /showing the model its command once/.test(e.text)), "no reveal by default");
      const e = events.find((x) => x.kind === "job_end");
      assert.ok(e && e.kind === "job_end" && e.outcome !== "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("revealOnStuck: false (--no-reveal) restores the stop on a hidden check", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [write("out.txt", "hello\n")] },
        { text: "Done." },
        { calls: [write("out.txt", "hello again\n")] },
        { text: "Done again." },
        { text: "unreached" },
      ]);
      const events = await drain(engineIn(ws.dir, provider.fetchFn, { revealOnStuck: false }).run(TASK, allowAll, { taskChecks: hiddenChecks }));
      assert.ok(events.some((e) => e.kind === "info" && /failed in exactly the same way twice/.test(e.text)));
      assert.ok(events.some((e) => e.kind === "proof_exhausted"));
      assert.ok(!provider.bodies.some((b) => b.includes("grep -q 366")), "a hidden command leaked");
    } finally {
      ws.cleanup();
    }
  });
});
