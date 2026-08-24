/**
 * The journal exists so that what molt says it did can be checked against a
 * record it cannot silently edit. These tests hold it to that: every claim
 * in `molt log` is recomputed from entries, and any alteration or deletion
 * has to be detectable and located.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { GENESIS, Journal, type JournalEntry } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { allowAll, denyAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}
function writeBar(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".molt"), { recursive: true });
  writeFileSync(join(dir, ".molt", "done.yml"), yaml, "utf8");
}
function rewrite(file: string, rows: JournalEntry[]): void {
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("the chain", () => {
  it("starts at genesis and links every entry", () => {
    const j = new Journal(ws(), "chain-1");
    const a = j.append("session_start", { model: "m" })!;
    const b = j.append("user_message", { chars: 3 })!;
    const c = j.append("session_end", { reason: "done" })!;

    assert.equal(a.prev, GENESIS);
    assert.equal(b.prev, a.hash);
    assert.equal(c.prev, b.hash);
    assert.deepEqual(Journal.verify(j.path), { ok: true, entries: 3 });
  });

  it("verifies an empty and a missing log without complaining", () => {
    assert.deepEqual(Journal.verify(join(ws(), "nope.jsonl")), { ok: true, entries: 0 });
  });

  it("detects a modified entry and names it", () => {
    const j = new Journal(ws(), "chain-2");
    j.append("bar_run", { ok: false, failed: "tests" });
    j.append("session_end", { reason: "bar not met" });

    const rows = Journal.read(j.path);
    (rows[0].data as Record<string, unknown>).ok = true; // the lie a liar would tell
    rewrite(j.path, rows);

    const r = Journal.verify(j.path);
    assert.equal(r.ok, false);
    assert.equal(r.brokenAt, 0);
    assert.match(r.reason!, /modified after it was written/);
  });

  it("detects a deleted entry", () => {
    const j = new Journal(ws(), "chain-3");
    j.append("permission", { name: "bash", allowed: true });
    j.append("tool_call", { name: "bash" });
    j.append("session_end", { reason: "done" });

    const rows = Journal.read(j.path).filter((r) => r.kind !== "permission");
    rewrite(j.path, rows);

    const r = Journal.verify(j.path);
    assert.equal(r.ok, false);
    assert.match(r.reason!, /altered or removed/);
  });

  it("detects an inserted entry", () => {
    const j = new Journal(ws(), "chain-4");
    j.append("session_start", {});
    j.append("session_end", { reason: "done" });

    const rows = Journal.read(j.path);
    rows.splice(1, 0, { ...rows[1], seq: 1, kind: "bar_run", data: { ok: true } });
    rewrite(j.path, rows);

    assert.equal(Journal.verify(j.path).ok, false);
  });

  it("survives a truncated final line rather than failing the whole log", () => {
    const j = new Journal(ws(), "chain-5");
    j.append("session_start", {});
    j.append("user_message", { chars: 1 });
    const raw = readFileSync(j.path, "utf8");
    writeFileSync(j.path, raw + '{"seq":2,"iso":"broke', "utf8");
    assert.equal(Journal.verify(j.path).ok, true, "a half-written line is skipped, not fatal");
  });
});

describe("what the log records", () => {
  it("captures the whole shape of a session, refusal included", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const journal = new Journal(dir, "sess-1");
    journal.append("session_start", { model: "test-model", bar: "1 check(s)" });

    const provider = scriptedProvider([
      { text: "Done." },
      { calls: [{ name: "write_file", args: { path: "r.txt", content: "real\n" } }] },
      { text: "Now done." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      journal,
    });

    await drain(engine.run("fix it", allowAll));

    const kinds = Journal.read(journal.path).map((e) => e.kind);
    for (const required of [
      "user_message",
      "request",
      "response",
      "bar_run",
      "receipt",
      "tool_call",
      "tool_result",
      "permission",
      "session_end",
    ]) {
      assert.ok(kinds.includes(required as never), `log is missing ${required}`);
    }

    // Both bar runs are recorded — the refusal is not quietly dropped.
    const bars = Journal.read(journal.path).filter((e) => e.kind === "bar_run");
    assert.equal(bars.length, 2);
    assert.equal(bars[0].data.ok, false);
    assert.equal(bars[1].data.ok, true);
    assert.equal(Journal.verify(journal.path).ok, true);
  });

  it("records a denied permission as denied", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const journal = new Journal(dir, "sess-2");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "x.txt", content: "y\n" } }] },
      { text: "Wrote it." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      receipts: new Receipts(dir),
      journal,
      maxProofAttempts: 1,
    });
    await drain(engine.run("write it", denyAll));

    const perm = Journal.read(journal.path).find((e) => e.kind === "permission");
    assert.ok(perm, "a gated tool call must be logged");
    assert.equal(perm.data.allowed, false);
  });

  it("marks estimated token counts as estimates", async () => {
    const dir = ws();
    const journal = new Journal(dir, "sess-3");
    // scriptedProvider reports usage, so `estimated` must be false.
    const provider = scriptedProvider([{ text: "hi" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      journal,
    });
    await drain(engine.run("hello", allowAll));

    const req = Journal.read(journal.path).find((e) => e.kind === "request")!;
    const res = Journal.read(journal.path).find((e) => e.kind === "response")!;
    assert.equal(req.data.estimated, true, "request size is always an estimate");
    assert.equal(res.data.estimated, false, "provider-reported usage is not an estimate");
  });

  it("logs a cancellation and the rollback that followed it", async () => {
    const dir = ws();
    const journal = new Journal(dir, "sess-4");
    const engine = new Engine({
      baseUrl: "http://127.0.0.1:1/v1",
      model: "m",
      cwd: dir,
      bar: null,
      journal,
      fetchFn: (async () => {
        await new Promise((r) => setTimeout(r, 60));
        throw Object.assign(new Error("aborted"), { name: "AbortError" });
      }) as unknown as typeof fetch,
    });

    const before = JSON.stringify(engine.getRecord());
    setTimeout(() => engine.cancel(), 10);
    await drain(engine.run("something long", allowAll));

    assert.equal(
      JSON.stringify(engine.getRecord()),
      before,
      "cancelled means the session is literally unchanged, not nearly unchanged",
    );
    const c = Journal.read(journal.path).find((e) => e.kind === "cancelled");
    assert.ok(c && c.data.rolledBack === true);
  });

  it("never writes message content into the log, only its size and digest", async () => {
    const dir = ws();
    const journal = new Journal(dir, "sess-5");
    // Assembled rather than written out, so this file holds no literal that a
    // secret scanner has to make a judgement about.
    const secret = `SECRET-API-KEY-${"sk-"}abcdef1234567890-DO-NOT-LOG`;
    const provider = scriptedProvider([{ text: "ok" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      journal,
    });
    await drain(engine.run(`here is a very long request ${"x".repeat(400)} ${secret}`, allowAll));

    const raw = readFileSync(journal.path, "utf8");
    assert.ok(!raw.includes(secret), "the log must not become a place secrets accumulate");
    const um = Journal.read(journal.path).find((e) => e.kind === "user_message")!;
    assert.ok(typeof um.data.sha256 === "string", "but it is still attributable by digest");
    assert.ok((um.data.preview as string).length <= 120);
  });
});

describe("summarize", () => {
  it("derives every line from entries rather than narrating", () => {
    const j = new Journal(ws(), "sum-1");
    j.append("session_start", { sessionId: "abc", provider: "ollama", model: "q", bar: "2 check(s)" });
    j.append("bar_run", { ok: false, passed: 1, total: 2, failed: "tests", ms: 940 });
    const lines = Journal.summarize(Journal.read(j.path));
    assert.match(lines[0], /ollama\/q/);
    assert.match(lines[1], /bar FAIL 1\/2/);
    assert.match(lines[1], /failed: tests/);
    assert.match(lines[1], /940ms/);
  });
});
