/**
 * Numbers a receipt can back.
 *
 * `molt stats` on this project reported 41 receipts on disk over 40 files,
 * a cost per verified change that divided priced dollars by unpriced
 * acceptances, and sixteen "verified changes" of which five were answered
 * questions that changed nothing. Each was reproducible from the index and
 * none was reproducible from the receipts.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
const require_lines = (p: string): string[] => readFileSync(p, "utf8").split("\n").filter(Boolean);
const require_line = (p: string): string => require_lines(p)[0]!;
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { cmdAttempts, cmdAutoShed } from "../src/session-commands.js";
import { criteriaFromArgs, parseArgs } from "../src/cli.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}
const bar = (ok: boolean) => ({ ok, durationMs: 1, results: [] });
const row = (
  receipts: Receipts,
  o: Partial<Parameters<Receipts["write"]>[0]> & { verdict: "accepted" | "refused" | "exhausted" },
) =>
  receipts.write({
    claim: "x",
    result: bar(o.verdict === "accepted"),
    attempt: 1,
    model: "m",
    provider: "p",
    sessionTokens: 100,
    shedBatches: 0,
    ...o,
  });

describe("what counts as a verified change", () => {
  it("does not count an accepted answer to a question", async () => {
    const dir = ws();
    const provider = scriptedProvider([{ text: "The suite is green and the project is healthy." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar("version: 1\nchecks:\n  - name: tests\n    run: \"false\"\n  - name: landed\n    builtin: files-changed\n"),
      receipts: new Receipts(dir),
    });
    const events = await drain(engine.run("does the suite pass?", allowAll, { ask: true }));
    assert.equal((events.at(-1) as { outcome: string }).outcome, "answered", "a question was called verified");
    const s = new Receipts(dir).stats();
    assert.equal(s.accepted, 1);
    assert.equal(s.answered, 1);
    assert.equal(s.verifiedChanges, 0);
    assert.equal(s.tokensPerVerifiedChange, undefined, "tokens per verified change over zero changes");
    const rec = new Receipts(dir).records()[0]!;
    assert.equal(rec.ask, true);
    assert.equal(rec.changed, 0);
  });

  it("still counts an older acceptance that recorded no change count", () => {
    const dir = ws();
    const receipts = new Receipts(dir);
    // Written the old way: no `changed`, no `ask`. Unknown is not zero.
    receipts.write({ claim: "x", result: bar(true), attempt: 1, verdict: "accepted", model: "m", provider: "p", sessionTokens: 700, shedBatches: 0 });
    const idx = join(dir, ".molt", "receipts", "index.jsonl");
    const stripped = JSON.parse(require_line(idx)) as Record<string, unknown>;
    delete stripped.changed;
    writeFileSync(idx, JSON.stringify(stripped) + "\n");
    const s = receipts.stats();
    assert.equal(s.verifiedChanges, 1);
    assert.equal(s.tokensPerVerifiedChange, 700);
  });
});

describe("cost per verified change", () => {
  it("divides priced dollars by priced changes only, and marks an estimate", () => {
    const dir = ws();
    const receipts = new Receipts(dir);
    row(receipts, { verdict: "accepted", session: "priced", sessionTokens: 1000, costUsd: 0.9, changed: [{ path: "a", before: null, after: "x" }] });
    row(receipts, { verdict: "accepted", session: "free", sessionTokens: 1000, changed: [{ path: "b", before: null, after: "x" }] });
    row(receipts, { verdict: "accepted", session: "free2", sessionTokens: 1000, changed: [{ path: "c", before: null, after: "x" }] });
    const s = receipts.stats();
    assert.equal(s.verifiedChanges, 3);
    assert.equal(s.totalUsd, 0.9);
    assert.equal(s.usdPerVerifiedChange, 0.9, "priced dollars were spread over unpriced changes");
    assert.equal(s.costEstimated, false);

    row(receipts, { verdict: "accepted", session: "priced2", sessionTokens: 10, costUsd: 0.1, costEstimated: true, changed: [{ path: "d", before: null, after: "x" }] });
    const t = receipts.stats();
    assert.equal(t.costEstimated, true, "an estimated cost was presented as measured");
    assert.ok(Math.abs((t.usdPerVerifiedChange ?? 0) - 0.5) < 1e-9);
  });
});

describe("one receipt file, one row", () => {
  it("does not count a reissued sequence number's earlier row as a receipt on disk", () => {
    const dir = ws();
    const receipts = new Receipts(dir);
    const first = row(receipts, { verdict: "refused", sessionTokens: 175 });
    unlinkSync(first.path);
    // The old numbering: a deleted receipt's number came back. Force the same
    // filename onto a second row by writing with a fresh Receipts whose index
    // says nothing is used past -1 — simulated by rewriting the index seq.
    const again = row(receipts, { verdict: "refused", sessionTokens: 1082 });
    const idx = join(dir, ".molt", "receipts", "index.jsonl");
    const lines = require_lines(idx);
    const older = JSON.parse(lines[0]!) as Record<string, unknown>;
    older.file = again.path.split("/").pop();
    writeFileSync(idx, [JSON.stringify(older), lines[1]].join("\n") + "\n");

    const s = receipts.stats();
    assert.equal(s.attempts, 2, "the index still records both attempts");
    assert.equal(s.present, 1, "two rows naming one file were counted as two receipts on disk");
    assert.equal(s.refused, 1);
  });
});

describe("criteria from the command line", () => {
  it("parses --criterion and --note into sealed task checks", () => {
    const a = parseArgs(["run", "task", "--criterion", "gate=npm test -- picker", "--criterion", "node check.mjs", "--note", "the picker lists local models"]);
    assert.deepEqual(a.criteria, [
      { name: "gate", run: "npm test -- picker" },
      { name: "criterion-2", run: "node check.mjs" },
    ]);
    assert.deepEqual(a.notes, ["the picker lists local models"]);
    const { taskChecks, taskNotes } = criteriaFromArgs(a);
    assert.equal(taskChecks.length, 2);
    assert.equal(taskChecks[0]!.kind, "command");
    assert.equal(taskChecks[0]!.run, "npm test -- picker");
    assert.deepEqual(taskNotes, ["the picker lists local models"]);
    assert.throws(() => parseArgs(["run", "t", "--criterion", "name="]), /needs name=command/);
  });

  it("reaches the engine and can refuse the claim", async () => {
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "r.txt", content: "real\n" } }] },
      { text: "done" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n"),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });
    const opts = criteriaFromArgs(parseArgs(["run", "t", "--criterion", "must-fail=false"]));
    const events = await drain(engine.run("do it", allowAll, opts));
    const ev = events.find((e) => e.kind === "proof_exhausted") as { result: { results: { name: string; ok: boolean }[] } };
    assert.ok(ev, "a failing criterion did not refuse the claim");
    assert.deepEqual(ev.result.results.map((r) => `${r.name}:${r.ok}`), ["landed:true", "task:must-fail:false"]);
  });
});

describe("attempts and auto-shed, one implementation for both surfaces", () => {
  it("sets and reports them", () => {
    const engine = new Engine({ baseUrl: "http://mock/v1", model: "m", cwd: ws(), bar: null });
    assert.equal(cmdAttempts(engine, "").kind, "info");
    assert.equal(cmdAttempts(engine, "2").text, "2 completion attempt(s) per turn");
    assert.equal(engine.maxProofAttempts, 2);
    assert.equal(cmdAttempts(engine, "0").kind, "error");
    assert.equal(cmdAutoShed(engine, "30000").kind, "info");
    assert.equal(engine.autoShedAtTokens, 30_000);
    assert.equal(cmdAutoShed(engine, "off").text, "auto-shed off");
    assert.equal(engine.autoShedAtTokens, 0);
    assert.equal(cmdAutoShed(engine, "soon").kind, "error");
  });
});


describe("repair backfills what the receipt body already says", () => {
  it("copies the change count in, and stats stop counting an unchanged acceptance", async () => {
    const dir = ws();
    const provider = scriptedProvider([{ text: "All good, nothing to do." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar("version: 1\nchecks:\n  - name: ok\n    run: \"true\"\n"),
      receipts: new Receipts(dir),
    });
    await drain(engine.run("is it fine?", allowAll, { ask: true }));
    const idx = join(dir, ".molt", "receipts", "index.jsonl");
    // As the row looked before `changed` and `ask` were recorded.
    const old = JSON.parse(require_line(idx)) as Record<string, unknown>;
    delete old.changed;
    delete old.ask;
    writeFileSync(idx, JSON.stringify(old) + "\n");
    const receipts = new Receipts(dir);
    assert.equal(receipts.stats().verifiedChanges, 1, "unknown must count until the body is read");
    const report = receipts.repair();
    assert.equal(report.backfilled, 1);
    assert.equal(receipts.records()[0]!.changed, 0);
    const s = receipts.stats();
    assert.equal(s.verifiedChanges, 0);
    assert.equal(s.unchanged, 1);
    assert.equal(receipts.repair().backfilled, 0, "a second pass must find nothing to do");
  });
});

describe("capture, for training the safeguard", () => {
  it("writes one redacted file per attempt with the transcript and the verdict", async () => {
    const dir = ws();
    const cap = join(dir, "captures");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "r.txt", content: "real\n" } }] },
      { text: "done, key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 is set" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      apiKey: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n"),
      receipts: new Receipts(dir),
      captureDir: cap,
    });
    await drain(engine.run("add r.txt", allowAll));
    const files = readdirSync(cap);
    assert.equal(files.length, 1);
    const c = JSON.parse(readFileSync(join(cap, files[0]!), "utf8")) as Record<string, unknown>;
    assert.equal(c.verdict, "accepted");
    assert.equal(c.task, "add r.txt");
    assert.ok(Array.isArray(c.transcript) && (c.transcript as unknown[]).length >= 3, "the wire transcript travels with the verdict");
    assert.deepEqual((c.ledger as { path: string }[]).map((e) => e.path), ["r.txt"]);
    assert.equal((c.result as { ok: boolean }).ok, true);
    assert.doesNotMatch(readFileSync(join(cap, files[0]!), "utf8"), /sk-ant-api03-abcdefghij/, "a capture leaked the key");
    assert.equal(parseArgs(["run", "t", "--capture", "caps"]).capture, resolve("caps"));
  });
});
