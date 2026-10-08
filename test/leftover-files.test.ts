/**
 * Files the work left beside the deliverable that the task never names
 * (leftovers.ts unnamedNewFiles), put to the model once before judging.
 * Local redact-secrets: right work, failed for the redact.py left behind
 * against "create no other files".
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { unnamedNewFiles } from "../src/leftovers.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const listing = (files: string[]) => ({ files: new Set(files), dirs: new Set<string>() });

describe("unnamedNewFiles", () => {
  it("names new files the task does not mention, by path, name or folder", () => {
    const task = "Write report.txt and put the sorted files under sorted/. Create no other files.";
    const before = listing(["data.csv"]);
    const after = listing(["data.csv", "report.txt", "sorted/a/b.txt", "helper.py", "tmp/copy.csv"]);
    assert.deepEqual(unnamedNewFiles(before, after, task), ["helper.py", "tmp/copy.csv"]);
  });
});

describe("before a headless claim is judged", () => {
  it("asks once about files the task does not name, and the model's cleanup is what gets judged", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "in.txt"), "x\n");
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "helper.py", content: "print(1)\n" } }, { name: "write_file", args: { path: "out.txt", content: "y\n" } }] },
        { text: "Done: out.txt written." },
        { calls: [{ name: "bash", args: { command: "rm helper.py" } }] },
        { text: "Removed my helper; out.txt is the deliverable." },
      ]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", unattended: true });
      const events = await drain(engine.run("Write out.txt from in.txt. Create no other files.", allowAll));
      assert.ok(events.some((e) => e.kind === "info" && /files the task does not name — helper\.py/.test(e.text)));
      assert.equal(existsSync(join(ws.dir, "helper.py")), false);
      const asked = events.filter((e) => e.kind === "info" && /files the task does not name/.test(e.text));
      assert.equal(asked.length, 1, "asked once, not every claim");
    } finally {
      ws.cleanup();
    }
  });

  it("is not asked in an attended session", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([{ calls: [{ name: "write_file", args: { path: "helper.py", content: "1" } }] }, { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run("Write out.txt.", allowAll));
      assert.ok(!events.some((e) => e.kind === "info" && /files the task does not name/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });
});
