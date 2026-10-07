/**
 * Tool arguments held against the tool's schema before the call runs
 * (src/toolargs.ts). A call that drifts from its schema is answered with
 * exactly what is wrong and runs nothing; only the unambiguous is mended.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { argumentProblems } from "../src/toolargs.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const write = { properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] };
const read = { properties: { path: { type: "string" }, offset: { type: "number" }, limit: { type: "number" } }, required: ["path"] };
const plan = { properties: { steps: { type: "array", items: { type: "string" } }, current: { type: "number" } }, required: ["steps"] };

describe("argumentProblems", () => {
  it("names a missing required field, and the near-miss the model sent instead", () => {
    assert.deepEqual(argumentProblems(write, { file_path: "a.txt", content: "x" }), ["`path` is required (you sent `file_path`; the field is `path`)"]);
    assert.deepEqual(argumentProblems(write, { path: "a.txt" }), ["`content` is required"]);
  });

  it("refuses a wrong type and says what arrived", () => {
    assert.deepEqual(argumentProblems(write, { path: "a.txt", content: { text: "x" } }), ["`content` must be a string, not an object"]);
    assert.deepEqual(argumentProblems(plan, { steps: [1, 2] }), ["`steps` must be an array of strings, not an array"]);
  });

  it("mends only the unambiguous, in place", () => {
    const a: Record<string, unknown> = { path: "a.txt", offset: "10", limit: 5 };
    assert.deepEqual(argumentProblems(read, a), []);
    assert.equal(a.offset, 10);
    const p: Record<string, unknown> = { steps: "just one" };
    assert.deepEqual(argumentProblems(plan, p), []);
    assert.deepEqual(p.steps, ["just one"]);
    assert.deepEqual(argumentProblems(read, { path: "a.txt", offset: "ten" }), ['`offset` must be a number, not the string "ten"']);
  });

  it("allows an empty string where a string is wanted, and extra fields it does not know", () => {
    assert.deepEqual(argumentProblems(write, { path: "empty.txt", content: "", mode: "w" }), []);
  });
});

describe("a call that does not fit its schema, in a turn", () => {
  it("runs nothing, tells the model what is wrong, and the corrected call runs", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { file_path: "a.txt", content: "A\n" } }] },
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "A\n" } }] },
        { text: "a.txt is written." },
      ]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      await drain(engine.run("write a.txt", allowAll));
      const second = provider.requests()[1] as { messages: { role: string; content: string }[] };
      const said = second.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
      assert.match(said, /do not fit its schema, so nothing ran: `path` is required \(you sent `file_path`; the field is `path`\)/);
      assert.equal(existsSync(join(ws.dir, "undefined")), false, "nothing was written under a guessed name");
      assert.equal(readFileSync(join(ws.dir, "a.txt"), "utf8"), "A\n");
    } finally {
      ws.cleanup();
    }
  });
});
