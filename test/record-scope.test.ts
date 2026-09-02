/**
 * What a turn is judged on, and what ends one.
 *
 * Four gaps found auditing the live record on 2026-09-02, each reproduced
 * against the built engine before it was fixed:
 *
 *   - a turn that wrote nothing was accepted on the previous turn's write;
 *   - a receipt's "What the model ran" listed every earlier turn's calls;
 *   - ctrl+C during a bar check produced a refused receipt, a billed request,
 *     an exhausted receipt, and a killed check cached as a failure;
 *   - the project's own `tests` check did not watch the directories the suite
 *     compiles and asserts on, so a change there reused a stale pass.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar, parseBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

const LANDED = parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");

function receiptsIn(dir: string): string[] {
  const d = join(dir, ".molt", "receipts");
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith(".md")).sort() : [];
}

describe("a completion claim is judged on the turn that made it", () => {
  it("refuses a second turn that wrote nothing, however much the first one wrote", async () => {
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "src/a.js", content: "export const a = 1;\n" } }] },
      { text: "Turn 1: added src/a.js." },
      { text: "Turn 2: I refactored the auth module and everything passes." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: LANDED,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });
    const first = await drain(engine.run("add a file", allowAll));
    assert.equal((first.at(-1) as { outcome: string }).outcome, "verified");

    const second = await drain(engine.run("refactor the auth module", allowAll));
    const end = second.at(-1) as { kind: string; outcome: string };
    assert.notEqual(end.outcome, "verified", "a turn that wrote nothing was verified on the last turn's write");
    const bar = second.find((e) => e.kind === "proof_exhausted" || e.kind === "proof_refused") as
      | { result: { results: { output: string }[] } }
      | undefined;
    assert.ok(bar, "the claim must have been judged");
    assert.match(bar.result.results[0]!.output, /No file was modified in this turn/);
    assert.match(bar.result.results[0]!.output, /src\/a\.js/, "the refusal names what the session did write");
    assert.deepEqual(
      receiptsIn(dir).map((f) => f.replace(/^\d{4}-/, "")),
      ["accepted.md", "exhausted.md"],
    );
  });

  it("still judges the whole session's writes, not only this turn's, once this turn wrote", async () => {
    // Turn scope is a floor, not a replacement: a write shed or made three
    // turns ago is still this session's work and still has to be on disk.
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "first.txt", content: "one\n" } }] },
      { text: "done" },
      { calls: [{ name: "write_file", args: { path: "second.txt", content: "two\n" } }] },
      { text: "done again" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: LANDED,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });
    await drain(engine.run("one", allowAll));
    writeFileSync(join(dir, "first.txt"), "tampered\n", "utf8");
    const second = await drain(engine.run("two", allowAll));
    const bar = second.find((e) => e.kind === "proof_exhausted") as { result: { results: { output: string }[] } };
    assert.match(bar.result.results[0]!.output, /first\.txt: contents changed since molt wrote it/);
  });

  it("lists on a receipt only what this turn ran", async () => {
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "a\n" } }] },
      { text: "done" },
      { calls: [{ name: "write_file", args: { path: "b.txt", content: "b\n" } }] },
      { text: "done again" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: LANDED,
      archive: new Archive(dir),
      receipts: new Receipts(dir),
    });
    await drain(engine.run("one", allowAll));
    await drain(engine.run("two", allowAll));
    const [, second] = receiptsIn(dir);
    const body = readFileSync(join(dir, ".molt", "receipts", second!), "utf8");
    const ran = body.match(/## What the model ran\n\n([\s\S]*?)\n\n/)?.[1] ?? "";
    assert.match(ran, /write_file b\.txt/);
    assert.doesNotMatch(ran, /write_file a\.txt/, "receipt two lists turn one's call");
  });
});

describe("every shed is journalled", () => {
  it("records a shed made by hand, not only one the engine decided on", () => {
    // `/shed` on both surfaces called engine.shed(), and only the two auto-shed
    // call sites wrote the journal entry. record-intact reads the journal back
    // tomorrow as its expectation of what the archive holds; a batch shed by
    // hand was in the archive and not in the expectation. Exuvia 0000 of this
    // project is one the log cannot explain.
    const dir = ws();
    const journal = new Journal(dir, "shed-by-hand");
    const engine = new Engine({ baseUrl: "http://mock/v1", model: "m", cwd: dir, bar: null, archive: new Archive(dir), journal });
    // Enough conversation to have something to shed.
    const t = (engine as unknown as { transcript: { push(m: unknown): void } }).transcript;
    for (let i = 0; i < 4; i++) {
      t.push({ role: "user", content: `ask ${i} ${"x".repeat(400)}` });
      t.push({ role: "assistant", content: `answer ${i} ${"y".repeat(400)}` });
    }
    const shed = engine.shed();
    assert.ok(shed, "the fixture must have shed something");
    const entries = Journal.read(journal.path).filter((e) => e.kind === "shed");
    assert.equal(entries.length, 1, "a shed made by hand left no journal entry");
    assert.equal(entries[0]!.data.archive, shed!.path);
    assert.deepEqual(Journal.expectedArchives(dir), [shed!.path]);
  });
});

describe("a cancelled bar is not a failed one", () => {
  it("ends the turn as cancelled, writes no receipt, and caches nothing", async () => {
    const dir = ws();
    mkdirSync(join(dir, "src"));
    const bar = parseBar(
      "version: 1\nchecks:\n  - name: slow-suite\n    run: sleep 5\n    watch: [\"src/**\"]\n  - name: quick\n    run: \"true\"\n",
    );
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "src/a.js", content: "x\n" } }] },
      { text: "done" },
      { text: "done again" },
    ]);
    const journal = new Journal(dir, "cancel-bar");
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar,
      receipts: new Receipts(dir),
      journal,
      maxProofAttempts: 4,
    });
    const t0 = Date.now();
    const seen: string[] = [];
    for await (const ev of engine.run("do it", allowAll)) {
      seen.push(ev.kind);
      if (ev.kind === "proof_start") setTimeout(() => engine.cancel(), 200);
    }
    const took = Date.now() - t0;
    assert.ok(took < 4000, `the cancelled bar took ${took}ms — the check was not killed`);
    assert.ok(seen.includes("cancelled"), `no cancelled event in ${seen.join(" ")}`);
    assert.ok(!seen.includes("proof_refused"), "a cancelled bar was reported as a refusal");
    assert.ok(!seen.includes("receipt"), "a cancelled bar wrote a receipt");
    assert.equal(provider.calls, 2, "a request was billed after the person cancelled");
    assert.deepEqual(receiptsIn(dir), []);
    const journalled = Journal.read(journal.path).map((e) => e.kind);
    assert.ok(journalled.includes("cancelled"), `journal: ${journalled.join(" ")}`);
    assert.ok(!journalled.includes("receipt"));

    // Nothing it watches has moved, and it must still run again: the killed
    // result must not have been remembered as a failure.
    const again = await engine.proveNow();
    const slow = again!.results.find((r) => r.name === "slow-suite")!;
    assert.notEqual(slow.cached, true, "a killed check was reused as a cached failure");
  });

  it("marks a bar result cancelled so no surface prints it as not met", async () => {
    const dir = ws();
    const bar = parseBar("version: 1\nchecks:\n  - name: slow\n    run: sleep 5\n");
    const engine = new Engine({ baseUrl: "http://mock/v1", model: "m", cwd: dir, bar });
    const p = engine.proveNow();
    setTimeout(() => engine.cancel(), 150);
    const r = (await p)!;
    assert.equal(r.cancelled, true);
    assert.equal(r.ok, false);
  });
});

describe("the project's own bar watches what its suite reads", () => {
  it("tests watch covers every directory tsconfig.test.json compiles", () => {
    // A behaviour change in electron/criteria.ts that broke desktop-shell.test.ts
    // reused a stale pass, because the tests check watched src/** and test/**
    // only. The bar agreed the work was fine because it had not looked at it —
    // the exact sentence done.yml uses about the earlier `types` hole.
    const bar = loadBar(process.cwd())!;
    const tests = bar.checks.find((c) => c.name === "tests");
    assert.ok(tests && tests.kind === "command" && tests.watch, "the tests check must declare a watch");
    const tsconfig = JSON.parse(readFileSync("tsconfig.test.json", "utf8")) as { include: string[] };
    const dirs = new Set(tsconfig.include.map((g) => g.split("/")[0]!));
    for (const d of dirs) {
      assert.ok(
        tests.watch!.some((w) => w === d || w.startsWith(`${d}/`)),
        `tests watch does not cover ${d}/, which tsconfig.test.json compiles into the suite`,
      );
    }
    assert.ok(tests.watch!.includes("test-run.mjs"), "the runner itself decides what the suite measures");
  });
});
