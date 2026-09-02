/**
 * The integrity ledger exists so the islands of evidence — journal, receipts,
 * exuviae — are bound into one chain whose root can be shipped somewhere molt
 * cannot write. These tests hold it to that:
 *
 *   - the chain links every record and exposes a shippable root;
 *   - an artifact bound then edited is caught by `verify` as drift, even
 *     though the ledger's own chain is still intact;
 *   - a record edited is caught by the chain;
 *   - an engine session actually wires its journal, receipts and sheds into
 *     the ledger, so the binding is real and not a design doc.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Integrity, INTEGRITY_GENESIS, sha256FileSync } from "../src/integrity.js";
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
function writeBar(dir: string, yaml: string): void {
  mkdirSync(join(dir, ".molt"), { recursive: true });
  writeFileSync(join(dir, ".molt", "done.yml"), yaml, "utf8");
}

describe("the integrity chain", () => {
  it("starts at genesis and links every record", () => {
    const dir = ws();
    const i = new Integrity(dir);
    const a = i.append({ kind: "session_start", session: "s1", journalRoot: "aa" })!;
    const b = i.append({ kind: "receipt", session: "s1", receiptFile: "0000.md", receiptSha: "bb", journalRoot: "aa", verdict: "accepted" })!;
    const c = i.append({ kind: "shed", session: "s1", exuvia: "0000-x.md", exuviaSha: "cc", journalRoot: "aa" })!;

    assert.equal(a.prev, INTEGRITY_GENESIS);
    assert.equal(b.prev, a.hash);
    assert.equal(c.prev, b.hash);
    assert.equal(Integrity.exportRoot(dir).root, c.hash);
  });

  it("detects a modified record and names it", () => {
    const dir = ws();
    const i = new Integrity(dir);
    i.append({ kind: "session_start", session: "s1", journalRoot: "aa" });
    i.append({ kind: "receipt", session: "s1", receiptFile: "0000.md", receiptSha: "bb", journalRoot: "aa", verdict: "accepted" });

    const path = join(dir, ".molt", "integrity", "ledger.jsonl");
    const rows = Integrity.read(path);
    (rows[1].data as { receiptFile: string }).receiptFile = "9999.md";
    writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");

    const v = Integrity.verify(dir);
    assert.equal(v.ok, false);
    assert.match(v.reason!, /modified after it was written/);
  });

  it("detects an artifact that drifted after it was sealed", () => {
    const dir = ws();
    mkdirSync(join(dir, ".molt", "receipts"), { recursive: true });
    writeFileSync(join(dir, ".molt", "receipts", "0000-accepted.md"), "# molt receipt\nfine\n", "utf8");
    const i = new Integrity(dir);
    i.append({ kind: "session_start", session: "s1", journalRoot: "aa" });
    i.append({
      kind: "receipt",
      session: "s1",
      receiptFile: "0000-accepted.md",
      receiptSha: "0123456789abcdef",
      journalRoot: "aa",
      verdict: "accepted",
    });

    // Chain still verifies — the record was not edited — but the bound hash no
    // longer matches the file on disk. That is drift, and it must be reported.
    assert.equal(Integrity.verify(dir).ok, false);
  });

  it("reports a missing artifact after binding", () => {
    const dir = ws();
    const i = new Integrity(dir);
    // A real journal root: a bound root that names no journal entry is now
    // drift in its own right, and this test is about the exuvia alone.
    const j = new Journal(dir, "s1");
    j.append("session_start", {});
    i.append({ kind: "session_start", session: "s1", journalRoot: j.chainRoot() });
    i.append({
      kind: "shed",
      session: "s1",
      exuvia: "0000-x.md",
      exuviaSha: "deadbeef",
      journalRoot: j.chainRoot(),
    });

    const v = Integrity.verify(dir);
    assert.equal(v.ok, false);
    assert.equal(v.drift.length, 1);
    assert.equal(v.drift[0].kind, "exuvia");
  });
});

describe("the engine wiring", () => {
  it("binds session start, a shed, and a receipt into one project chain", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const journal = new Journal(dir, "int-1");
    const integrity = new Integrity(dir);
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
      integrity,
    });

    await drain(engine.run("fix it", allowAll));

    const rows = Integrity.read(integrity.path);
    assert.ok(rows.some((r) => r.kind === "session_start"), "binds session start");
    assert.ok(rows.some((r) => r.kind === "receipt"), "binds the receipt");
    // The journal root bound in the receipt record must be a real journal hash,
    // and the whole project chain verifies.
    const rec = rows.find((r) => r.kind === "receipt")!;
    assert.match(String(rec.data.receiptFile), /\.md$/);
    assert.equal(Integrity.verify(dir).ok, true);
    // A receipt bound into the ledger must match the actual file on disk.
    const v = Integrity.verify(dir);
    assert.equal(v.drift.length, 0);
  });

  it("journals bar_stuck when a bar fails identically twice", async () => {
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), 'echo "suite still red"\nexit 1\n', "utf8");
    writeBar(
      dir,
      [
        "version: 1",
        "checks:",
        "  - name: suite",
        "    run: sh ./check.sh",
        "    timeout: 10",
      ].join("\n"),
    );
    const journal = new Journal(dir, "int-2");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }] },
      { text: "Done." },
      { calls: [{ name: "write_file", args: { path: "b.txt", content: "y\n" } }] },
      { text: "Done." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      journal,
      maxProofAttempts: 2,
    });

    await drain(engine.run("fix the suite", allowAll));

    const stuck = Journal.read(journal.path).filter((e) => e.kind === "bar_stuck");
    assert.equal(stuck.length, 1, "an identical second failure must journal bar_stuck");
    assert.match(String(stuck[0].data.failed), /suite/);
  });
});

/**
 * A ledger is only evidence for what it names. These hold it to the reach it
 * actually has — the failure mode being a check that reads nothing, reports
 * "ok", and hands over a root of trust that is a constant.
 */
describe("a chain that binds nothing says so", () => {
  it("never reports an empty ledger as ok with a root of trust", () => {
    const dir = ws();
    // Evidence from before the ledger existed: real receipts, bound by
    // nothing. Every project looked like this the day the ledger shipped.
    mkdirSync(join(dir, ".molt", "receipts"), { recursive: true });
    writeFileSync(join(dir, ".molt", "receipts", "0000-accepted.md"), "old\n", "utf8");

    const v = Integrity.verify(dir);
    assert.equal(v.established, false, "an empty ledger must not read as an established chain");
    assert.equal(v.records, 0);
    assert.deepEqual(v.unbound, [{ kind: "receipt", file: "0000-accepted.md" }]);

    // The genesis constant is the same 64 zeroes in every project, matches
    // whatever the files are changed to, and is indistinguishable from a real
    // root to whoever files it away. It must not be handed out as one.
    const exported = Integrity.exportRoot(dir);
    assert.equal(exported.root, null, "the genesis constant was offered as a root of trust");
    assert.notEqual(exported.root, INTEGRITY_GENESIS);
  });

  it("names the evidence its records do not cover", () => {
    const dir = ws();
    mkdirSync(join(dir, ".molt", "receipts"), { recursive: true });
    mkdirSync(join(dir, ".molt", "exuviae"), { recursive: true });
    writeFileSync(join(dir, ".molt", "receipts", "0000-accepted.md"), "before the ledger\n", "utf8");
    writeFileSync(join(dir, ".molt", "receipts", "0001-accepted.md"), "bound\n", "utf8");
    writeFileSync(join(dir, ".molt", "exuviae", "0000-shed.md"), "before the ledger\n", "utf8");

    const ledger = new Integrity(dir);
    ledger.append({
      kind: "receipt",
      session: "s1",
      receiptFile: "0001-accepted.md",
      receiptSha: sha256FileSync(join(dir, ".molt", "receipts", "0001-accepted.md")),
      journalRoot: INTEGRITY_GENESIS,
      verdict: "accepted",
    });

    const v = Integrity.verify(dir);
    assert.equal(v.established, true);
    assert.equal(v.ok, true, "unbound evidence is not tampering and must not fail the chain");
    assert.deepEqual(v.drift, []);
    // The bound receipt is covered; the two older files are not, and saying
    // so is the difference between reporting reach and implying it.
    assert.deepEqual(v.unbound, [
      { kind: "receipt", file: "0000-accepted.md" },
      { kind: "exuvia", file: "0000-shed.md" },
    ]);
  });
});

/**
 * The claim the whole feature rests on, exercised end to end rather than on
 * hand-built records: bind a receipt a real session wrote, edit it, and the
 * chain must say so. The original wiring passed every test here while binding
 * receipts with an empty hash — verify skipped the empty binding, reported
 * `ok` with no drift, and an edited receipt sailed through.
 */
describe("what the ledger actually proves", () => {
  it("catches a receipt edited after a real session bound it", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const journal = new Journal(dir, "int-edit");
    const integrity = new Integrity(dir);
    journal.append("session_start", { model: "test-model" });

    const provider = scriptedProvider([
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
      integrity,
    });
    await drain(engine.run("fix it", allowAll));

    const rec = Integrity.read(integrity.path).find((r) => r.kind === "receipt")!;
    const name = String(rec.data.receiptFile);
    // Receipts.write returns a full path; the ledger must store the name the
    // receipts index uses, or nothing can find the file again.
    assert.match(name, /^\d{4}-\w+\.md$/, "the ledger bound a path where a name belongs");
    assert.notEqual(String(rec.data.receiptSha), "", "a binding with no hash binds nothing");

    const clean = Integrity.verify(dir);
    assert.equal(clean.ok, true);
    assert.deepEqual(clean.drift, []);
    assert.deepEqual(clean.unbound, [], "a receipt this session wrote is not covered by its own chain");

    // Edit the evidence. Any edit will do — a verdict flipped, a failing
    // check deleted, a cost erased. The chain's job is to notice.
    const file = join(dir, ".molt", "receipts", name);
    writeFileSync(file, `${readFileSync(file, "utf8")}\nAnd nothing was checked.\n`, "utf8");

    const after = Integrity.verify(dir);
    assert.equal(after.ok, false, "an edited receipt verified clean");
    assert.deepEqual(
      after.drift.map((d) => `${d.kind} ${d.file}`),
      [`receipt ${name}`],
    );
  });

  it("catches a journal rewritten and re-chained after the ledger bound its root", async () => {
    // The attack transparency.md names — "anyone with write access can rewrite
    // a whole log and re-chain it" — is the one the cross-link exists to make
    // visible. It did not: a bar verdict flipped and every later hash
    // recomputed left the journal's own chain intact, the ledger's chain
    // intact, and the root of trust unchanged, because nothing ever read the
    // bound journal roots back. Five of six roots bound for one real session
    // named no entry that still existed, under a printed "ok".
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const journal = new Journal(dir, "int-rechain");
    const integrity = new Integrity(dir);
    journal.append("session_start", { model: "test-model" });
    const provider = scriptedProvider([
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
      integrity,
    });
    await drain(engine.run("fix it", allowAll));
    assert.equal(Integrity.verify(dir).ok, true);

    // Rewrite one verdict and re-chain, exactly as the journal's own format does.
    const rows = Journal.read(journal.path);
    const bar = rows.find((r) => r.kind === "bar_run")!;
    (bar.data as Record<string, unknown>).ok = !(bar.data as Record<string, unknown>).ok;
    let prev = "0".repeat(64);
    for (const e of rows) {
      e.prev = prev;
      e.hash = createHash("sha256")
        .update(JSON.stringify({ seq: e.seq, iso: e.iso, kind: e.kind, data: e.data, prev: e.prev }))
        .digest("hex");
      prev = e.hash;
    }
    writeFileSync(journal.path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    assert.equal(Journal.verify(journal.path).ok, true, "the re-chained journal must look intact on its own");

    const v = Integrity.verify(dir);
    assert.equal(v.ok, false, "a re-chained journal verified clean against the ledger that bound it");
    assert.ok(
      v.drift.some((d) => d.kind === "journal" && d.file === "int-rechain.jsonl"),
      `drift must name the journal: ${JSON.stringify(v.drift)}`,
    );
    // And a journal that is simply gone.
    writeFileSync(journal.path, "", "utf8");
    assert.ok(Integrity.verify(dir).drift.some((d) => d.kind === "journal"));
  });

  it("gives every surface one verdict: verifyProject covers the journals verify() does not", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const journal = new Journal(dir, "int-window");
    const integrity = new Integrity(dir);
    journal.append("session_start", { model: "test-model" });
    const provider = scriptedProvider([
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
      integrity,
    });
    await drain(engine.run("fix it", allowAll));
    assert.equal(Integrity.verifyProject(dir).ok, true);

    // Edit an entry the ledger never bound the root of, and do not re-chain:
    // the journal's own chain breaks, the ledger's bindings all still resolve.
    const rows = Journal.read(journal.path);
    (rows[1]!.data as Record<string, unknown>).chars = 999;
    writeFileSync(journal.path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    assert.equal(Journal.verify(journal.path).ok, false);

    const p = Integrity.verifyProject(dir);
    assert.equal(p.ok, false, "the window's verdict must include the session logs");
    assert.equal(p.journals.filter((j) => !j.ok).length, 1);
    assert.equal(p.journals[0]!.file, "int-window.jsonl");
  });

  it("treats a record that names an artifact but carries no hash as drift", () => {
    const dir = ws();
    mkdirSync(join(dir, ".molt", "receipts"), { recursive: true });
    writeFileSync(join(dir, ".molt", "receipts", "0000-accepted.md"), "evidence\n", "utf8");
    const ledger = new Integrity(dir);
    ledger.append({
      kind: "receipt",
      session: "s1",
      receiptFile: "0000-accepted.md",
      receiptSha: "",
      journalRoot: INTEGRITY_GENESIS,
      verdict: "accepted",
    });

    const v = Integrity.verify(dir);
    assert.equal(v.ok, false, "an unhashed binding was counted as a clean one");
    assert.deepEqual(v.drift, [{ kind: "receipt", file: "0000-accepted.md", bound: "(never hashed)" }]);
  });
});
