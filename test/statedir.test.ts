/**
 * Maat Agent's folder is .maat/; projects that already have .molt/ keep it.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { barPath, loadBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { inStateDir, stateDir, stateDirName } from "../src/statedir.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const turn = () => [{ calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] }, { text: "Done." }];
const bar = "version: 1\nchecks:\n  - name: made\n    run: test -f a.txt\n";

describe("the project folder", () => {
  it("a new project gets .maat/", async () => {
    const ws = workspace();
    try {
      assert.equal(stateDirName(ws.dir), ".maat");
      const provider = scriptedProvider(turn());
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, receipts: new Receipts(ws.dir), stream: false, autonomy: "high" });
      await drain(engine.run("make a", allowAll, { taskChecks: [{ name: "made", kind: "command", run: "test -f a.txt", timeoutMs: 5_000, expectExit: 0, tags: [] }] }));
      assert.ok(readdirSync(join(ws.dir, ".maat", "receipts")).length > 0);
      assert.ok(!existsSync(join(ws.dir, ".molt")));
    } finally {
      ws.cleanup();
    }
  });

  it("an existing .molt/ project keeps working where it is: its bar, its receipts", async () => {
    const ws = workspace();
    try {
      mkdirSync(join(ws.dir, ".molt", "receipts"), { recursive: true });
      writeFileSync(join(ws.dir, ".molt", "done.yml"), bar);
      assert.equal(stateDirName(ws.dir), ".molt");
      assert.equal(barPath(ws.dir), join(ws.dir, ".molt", "done.yml"));
      const provider = scriptedProvider(turn());
      // As the CLI and the window do: the bar is read from the project.
      const loaded = loadBar(ws.dir);
      assert.ok(loaded && loaded.checks.length === 1, "the old bar is read");
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: loaded, receipts: new Receipts(ws.dir), stream: false, autonomy: "high" });
      const ev = await drain(engine.run("make a", allowAll));
      const end = ev.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified", "its bar was found and judged the claim");
      assert.ok(readdirSync(join(ws.dir, ".molt", "receipts")).length > 0, "receipts land beside the old ones");
      assert.ok(!existsSync(join(ws.dir, ".maat")), "no second folder is started");
    } finally {
      ws.cleanup();
    }
  });

  it("a person's .molt/done.yml is never ignored because a .maat/ folder appeared", () => {
    const ws = workspace();
    try {
      mkdirSync(join(ws.dir, ".molt"), { recursive: true });
      writeFileSync(join(ws.dir, ".molt", "done.yml"), bar);
      mkdirSync(join(ws.dir, ".maat", "log"), { recursive: true });
      assert.equal(stateDir(ws.dir), join(ws.dir, ".maat"));
      assert.equal(barPath(ws.dir), join(ws.dir, ".molt", "done.yml"));
      writeFileSync(join(ws.dir, ".maat", "done.yml"), bar);
      assert.equal(barPath(ws.dir), join(ws.dir, ".maat", "done.yml"), "the new one wins once it exists");
    } finally {
      ws.cleanup();
    }
  });

  it("knows both names as its own", () => {
    for (const p of [".maat", ".maat/log/x.jsonl", ".molt/receipts/0001.md", "./.molt"]) assert.ok(inStateDir(p), p);
    for (const p of ["src/.maatrc", "maat/x", ".moltx/y"]) assert.ok(!inStateDir(p), p);
  });
});
