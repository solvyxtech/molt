/**
 * A timed turn tells the model the time, and never starts a command that
 * would outlive the deadline.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

function engineFor(dir: string, turns: Parameters<typeof scriptedProvider>[0], deadlineMs?: number) {
  const provider = scriptedProvider(turns);
  const engine = new Engine({
    baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null,
    stream: false, autonomy: "high", ...(deadlineMs ? { turnDeadlineMs: deadlineMs } : {}),
  });
  return { engine, provider };
}

describe("pace", () => {
  it("each step's result ends with the clock in a timed turn, and not in an untimed one", async () => {
    const ws = workspace();
    try {
      const turns = [{ calls: [{ name: "bash", args: { command: "echo hi" } }] }, { text: "done" }];
      const timed = engineFor(ws.dir, turns, 60 * 60_000);
      await drain(timed.engine.run("say hi", allowAll));
      assert.match(timed.provider.bodies[1]!, /\[molt: 0m of 60m used\]/);
      assert.doesNotMatch(timed.provider.bodies[1]!, /quarter of the time/);
      const free = engineFor(ws.dir, turns);
      await drain(free.engine.run("say hi", allowAll));
      assert.doesNotMatch(free.provider.bodies[1]!, /\[molt: .* used\]/);
    } finally {
      ws.cleanup();
    }
  });

  it("warns once less than a quarter of the time is left", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(ws.dir, [{ calls: [{ name: "bash", args: { command: "sleep 0.9" } }] }, { text: "done" }], 1_100);
      await drain(engine.run("wait", allowAll));
      assert.match(provider.bodies[1]!, /Less than a quarter of the time is left\. Put the deliverable in its final place/);
    } finally {
      ws.cleanup();
    }
  });

  it("caps a command's timeout at the time left", async () => {
    const ws = workspace();
    try {
      const { engine, provider } = engineFor(
        ws.dir,
        [{ calls: [{ name: "bash", args: { command: "sleep 30", timeout_s: 600 } }] }, { text: "done" }],
        15_500,
      );
      const t0 = Date.now();
      await drain(engine.run("wait", allowAll));
      assert.ok(Date.now() - t0 < 12_000, "killed near the deadline, not at 600 s");
      assert.match(provider.bodies[1] ?? "", /timeout after 5/);
    } finally {
      ws.cleanup();
    }
  });
});
