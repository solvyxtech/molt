/**
 * Checks drafted while the model reads: sealed before the first change.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { changesSomething, criteriaWaitMs, Engine } from "../src/engine.js";
import type { Check, EngineEvent } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const check: Check = { name: "made", kind: "command", run: "grep -qx y out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true, author: { kind: "judge", model: "judge-j" } };
const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));
const sealedAt = (ev: EngineEvent[]) => ev.findIndex((e) => e.kind === "info" && /sealed for this turn/.test(e.text));
const toolAt = (ev: EngineEvent[], name: string) => ev.findIndex((e) => e.kind === "tool" && e.name === name);

describe("criteria drafted while the model reads", () => {
  it("reads go ahead; the first write waits for the seal", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "in.txt"), "x\n");
      const provider = scriptedProvider([
        { calls: [{ name: "read_file", args: { path: "in.txt" } }] },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "y" } }, { name: "read_file", args: { path: "in.txt" } }] },
        { text: "Done." },
      ]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const ev = await drain(engine.run("make out.txt from in.txt", allowAll, { pendingCriteria: later({ taskChecks: [check], taskNotes: [] }, 150) }));
      assert.ok(toolAt(ev, "read_file") < sealedAt(ev), "the read did not wait");
      assert.ok(sealedAt(ev) < toolAt(ev, "write_file"), "the seal came before the first change");
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified" && end.selfChecked === true);
      assert.ok(provider.bodies.some((b) => b.includes("Acceptance criteria for this task")), "the model is told what was sealed");
      // Every request is a well-formed conversation: an assistant message
      // with tool calls is followed directly by one result per call.
      for (const raw of provider.bodies) {
        const msgs = (JSON.parse(raw) as { messages: { role: string; tool_calls?: { id: string }[]; tool_call_id?: string }[] }).messages;
        msgs.forEach((m, i) => {
          for (const [k, c] of (m.tool_calls ?? []).entries()) {
            assert.equal(msgs[i + 1 + k]?.role, "tool", `message ${i} called a tool and message ${i + 1 + k} is not its result`);
            assert.equal(msgs[i + 1 + k]?.tool_call_id, c.id);
          }
        });
      }
    } finally {
      ws.cleanup();
    }
  });

  it("a claim with no change still waits for the checks, and is judged by them", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([{ text: "Nothing to do." }, { text: "Still nothing." }, { text: "No." }, { text: "No." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const ev = await drain(engine.run("make out.txt", allowAll, { pendingCriteria: later({ taskChecks: [check], taskNotes: [] }, 100) }));
      assert.ok(sealedAt(ev) >= 0);
      assert.ok(ev.some((e) => e.kind === "proof_start"), "the drafted check ran against the claim");
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome !== "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("a draft that fails leaves the turn unverified, never verified by nothing", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([{ calls: [{ name: "write_file", args: { path: "out.txt", content: "y" } }] }, { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const ev = await drain(engine.run("make out.txt", allowAll, { pendingCriteria: Promise.reject(new Error("draft failed")) }));
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "unverified");
    } finally {
      ws.cleanup();
    }
  });

  // Terminal-Bench query-optimize: 262 s of a 705 s budget waiting for a draft.
  it("under a time budget, seals what was reviewed so far instead of waiting out the draft", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([{ calls: [{ name: "write_file", args: { path: "out.txt", content: "y" } }] }, { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      engine.setTurnDeadline(600_000);
      const started = Date.now();
      const ev = await drain(
        engine.run("make out.txt", allowAll, {
          pendingCriteria: later({ taskChecks: [], taskNotes: [] }, 30_000),
          criteriaSoFar: async () => ({ taskChecks: [check], taskNotes: [] }),
          criteriaWaitMs: 200,
        }),
      );
      assert.ok(Date.now() - started < 10_000, "waited out the whole draft");
      assert.ok(ev.some((e) => e.kind === "info" && /sealing the 1 reviewed so far/.test(e.text)));
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified", "the check reviewed so far judged the claim");
    } finally {
      ws.cleanup();
    }
  });

  it("bounds the wait at a tenth of the budget, 45 s to 2 min, and not at all without one", () => {
    assert.equal(criteriaWaitMs(0), undefined);
    assert.equal(criteriaWaitMs(705_000), 70_500);
    assert.equal(criteriaWaitMs(100_000), 45_000);
    assert.equal(criteriaWaitMs(3_000_000), 120_000);
  });

  it("knows which calls change something", () => {
    assert.equal(changesSomething("read_file", "{}"), false);
    assert.equal(changesSomething("inspect", "{}"), false);
    assert.equal(changesSomething("bash", JSON.stringify({ command: "ls -la && cat a.txt" })), false);
    assert.equal(changesSomething("bash", JSON.stringify({ commands: ["ls", "head -3 x"] })), false);
    assert.equal(changesSomething("bash", JSON.stringify({ command: "python3 fix.py" })), true);
    assert.equal(changesSomething("bash", JSON.stringify({ command: "ls", background: true })), true);
    assert.equal(changesSomething("write_file", "{}"), true);
    assert.equal(changesSomething("bash", "not json"), true);
  });
});

describe("the inspect tool, in a turn", () => {
  it("is read-only at any autonomy, and shows what text hides", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "people.csv"), "id,email\r\n1, ALICE@Example.com \r\n2,bob@example.com\r\n3\r\n");
      const provider = scriptedProvider([{ calls: [{ name: "inspect", args: { path: "people.csv" } }] }, { text: "ok" }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "low" });
      await drain(engine.run("? look at people.csv", allowAll, { ask: true }));
      const body = provider.bodies[1]!;
      assert.match(body, /CRLF line endings/);
      assert.match(body, /ROWS WITH A DIFFERENT FIELD COUNT/);
      assert.match(body, /mixed case: 1 of 2 contain capitals/);
      assert.match(body, /surrounding whitespace/);
      assert.match(body, /00000000  69 64 2c 65 6d 61 69 6c/);
      assert.match(provider.bodies[0]!, /\[molt\] The input files this task names, as bytes/, "named inputs are profiled up front");
    } finally {
      ws.cleanup();
    }
  });
});
