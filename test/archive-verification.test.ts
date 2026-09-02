/**
 * Is the archive load-bearing, or decoration?
 *
 * The claim molt makes is that verification runs against preserved history.
 * That is only true if deleting the archive changes an outcome. Before this
 * work it did not: pass/fail came entirely from an in-memory ledger that was
 * never shed, and `record-intact` only checked that the archive was
 * self-consistent — which proves the archive is intact, not that any claim
 * is true.
 *
 * These tests hold the claim to its literal meaning.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive, LEDGER_MARKER } from "../src/archive.js";
import { loadBar, mentionedPaths, parseBar, runBar, writeDefaultBar, type BarContext } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import type { LedgerEntry } from "../src/types.js";
import { allowAll, drain, kinds, scriptedProvider, workspace } from "./helpers.js";

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
const FILLER = "z".repeat(1500);

/**
 * A session that writes a file early, then generates enough traffic that the
 * write is shed out of working context.
 */
async function sessionWithShedWrite(dir: string, target = "early.ts") {
  const provider = scriptedProvider([
    { calls: [{ name: "write_file", args: { path: target, content: "export const early = 1;\n" } }] },
    ...Array.from({ length: 8 }, (_, i) => ({
      calls: [{ name: "bash", args: { command: `echo ${i} ${FILLER}` } }],
    })),
    { text: `Done. The change is in ${target}.` },
  ]);
  const engine = new Engine({
    baseUrl: "http://mock/v1",
    model: "m",
    cwd: dir,
    fetchFn: provider.fetchFn,
    bar: loadBar(dir),
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    autoShedAtTokens: 1500,
    maxProofAttempts: 1,
  });
  const events = await drain(engine.run("build it", allowAll));
  return { engine, events };
}

describe("write evidence survives shedding", () => {
  it("moves into the archive and is still provable", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const { engine, events } = await sessionWithShedWrite(dir);

    assert.ok(engine.shedBatches > 0, "the session must actually have shed");
    assert.ok(kinds(events).includes("proof_result"), "and the bar must still pass");

    // The live ledger no longer holds the early write; the archive does.
    const archived = new Archive(dir).ledger();
    assert.ok(
      archived.some((e) => e.path === "early.ts"),
      "the shed write must be recoverable from the archive",
    );
    assert.ok(
      engine.mergedLedger().some((e) => e.path === "early.ts"),
      "and must appear in the merged view checks use",
    );
  });

  it("is embedded in the exuvia itself, not a side file", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    await sessionWithShedWrite(dir);

    const archive = new Archive(dir);
    const bodies = archive.list().map((e) => archive.read(e.index));
    assert.ok(
      bodies.some((b) => b.includes(LEDGER_MARKER) && b.includes("early.ts")),
      "evidence travels inside the exuvia it belongs to",
    );
  });

  it("survives a fresh Engine — evidence crosses sessions", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    await sessionWithShedWrite(dir);

    // A brand new engine, as if molt were restarted tomorrow. Its in-memory
    // ledger is empty; everything it knows comes from disk.
    const fresh = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      archive: new Archive(dir),
    });
    assert.equal(fresh.getLedger().length, 0, "a new session starts with no live ledger");
    assert.ok(
      fresh.mergedLedger().some((e) => e.path === "early.ts"),
      "but yesterday's write is still provable",
    );
  });

  /**
   * The archive directory outlives the session; the ledger a turn is judged
   * against must not.
   *
   * From a real accepted receipt: a turn whose only work was `src/files.ts`
   * had `work-checked` breaking lines in `electron/main.ts` and
   * `ui/index.html` — written days earlier by someone else — and
   * `work-landed` reporting "contents changed since molt wrote it" for four
   * files that session never opened, because a later commit had touched them.
   * The model cleared it the only way available to it: six comment-only word
   * swaps across six untouched files, in one step, to make stale hashes
   * match. The bar accepted the turn.
   */
  it("does not judge a new session against a previous session's writes", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    await sessionWithShedWrite(dir);

    // Tomorrow. Nothing has been written yet in this one.
    const fresh = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      archive: new Archive(dir),
    });

    assert.ok(
      fresh.mergedLedger().some((e) => e.path === "early.ts"),
      "yesterday's work must stay auditable",
    );
    assert.deepEqual(
      fresh.sessionLedger(),
      [],
      "a new session inherited a previous session's writes as if it had made them",
    );
  });

  it("refuses a turn that wrote nothing, however much the project has written", async () => {
    // The consequence that matters. With the project's history in the ledger,
    // files-changed judged a turn that did nothing against files it never
    // opened — passing, failing on a stale hash, or being cleared by an edit
    // made only to clear it. All three are wrong; the honest answer is that
    // this turn wrote nothing.
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    await sessionWithShedWrite(dir);

    const fresh = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      archive: new Archive(dir),
    });
    const result = await runBar(loadBar(dir)!, fresh.barContext());
    assert.equal(result.ok, false, "credited a turn with work a previous session did");
    assert.match(result.results[0]!.output, /No file was modified in this session/);
  });

  it("rebases surviving entries so they do not point at the wrong turn", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "a.ts", content: "a\n" } }] },
      ...Array.from({ length: 6 }, (_, i) => ({ calls: [{ name: "bash", args: { command: `echo ${i} ${FILLER}` } }] })),
      { calls: [{ name: "write_file", args: { path: "b.ts", content: "b\n" } }] },
      { text: "Both written." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      autoShedAtTokens: 1500,
      maxProofAttempts: 1,
    });
    await drain(engine.run("write both", allowAll));

    for (const e of engine.getLedger()) {
      assert.ok(e.callId.length > 0, "every entry names the call that made it");
    }
    const merged = engine.mergedLedger().map((e) => e.path).sort();
    assert.deepEqual(merged, ["a.ts", "b.ts"], "both writes remain provable");
  });

  it("hands evidence over rather than keeping a copy in memory", async () => {
    // If the live ledger kept everything, the archive would be decoration:
    // nothing would depend on it and the claim would be false.
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n");
    const { engine } = await sessionWithShedWrite(dir, "handed-over.ts");

    assert.ok(engine.shedBatches > 0, "the session must have shed");
    assert.ok(
      !engine.getLedger().some((e) => e.path === "handed-over.ts"),
      "the shed write must NOT still be sitting in live memory",
    );
    assert.ok(
      new Archive(dir).ledger().some((e) => e.path === "handed-over.ts"),
      "it must be in the archive instead",
    );
    assert.ok(
      engine.mergedLedger().some((e) => e.path === "handed-over.ts"),
      "and reachable through the merged view checks use",
    );
  });

  it("partitions correctly across repeated sheds", async () => {
    // Committing a shed replaces the dropped prefix with a single digest
    // message, so surviving ledger entries must be rebased. Without that,
    // the second shed partitions on stale ordinals and files end up in the
    // wrong store — provable by accident rather than by design.
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "first.ts", content: "1\n" } }] },
      { text: "one" },
      { calls: [{ name: "write_file", args: { path: "second.ts", content: "2\n" } }] },
      { text: "two" },
      { calls: [{ name: "write_file", args: { path: "third.ts", content: "3\n" } }] },
      { text: "three" },
    ]);
    const archive = new Archive(dir);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      archive,
    });

    // Interleave real turns with explicit sheds so the cuts are deterministic.
    for (const p of ["first", "second", "third"]) {
      await drain(engine.run(`write ${p} ${FILLER}`, allowAll));
      await drain(engine.run(`padding for ${p} ${FILLER}`, allowAll));
      engine.shed();
    }

    const archived = archive.ledger().map((e) => e.path);
    const live = engine.getLedger().map((e) => e.path);
    const merged = engine.mergedLedger().map((e) => e.path).sort();

    assert.deepEqual(merged, ["first.ts", "second.ts", "third.ts"], "nothing lost");
    assert.ok(archived.includes("first.ts"), "the earliest write is archived");
    assert.ok(
      !live.includes("first.ts"),
      "and is not also retained in memory — that would make the archive optional",
    );
    // Every path is in exactly one place, never duplicated across both.
    for (const p of merged) {
      const inArchive = archived.includes(p);
      const inLive = live.includes(p);
      assert.ok(inArchive !== inLive, `${p} must be in exactly one store, not ${inArchive && inLive ? "both" : "neither"}`);
    }
  });

  it("moves an entry that survives one shed and departs on the next", async () => {
    // Evidence is partitioned by the tool call that produced it, not by a
    // message index — indices shift when a shed replaces a dropped prefix
    // with a digest, and a missed rebase silently misfiles evidence. This
    // exercises an entry that stays through one shed and leaves on the next.
    const dir = ws();
    const archive = new Archive(dir);
    // The script replays in order, so the two padding turns come first and
    // the write lands inside the window planShed keeps.
    const provider = scriptedProvider([
      { text: "acknowledged" },
      { text: "acknowledged" },
      { calls: [{ name: "write_file", args: { path: "survivor.ts", content: "s\n" } }] },
      { text: "written" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      archive,
    });

    await drain(engine.run(`padding one ${FILLER}`, allowAll));
    await drain(engine.run(`padding two ${FILLER}`, allowAll));
    await drain(engine.run(`write the survivor ${FILLER}`, allowAll));

    const first = engine.shed();
    assert.ok(first, "first shed should happen");
    assert.ok(
      engine.getLedger().some((e) => e.path === "survivor.ts"),
      "the write survives the first shed and stays in memory",
    );

    // Now push it out of the keep window and shed again.
    await drain(engine.run(`padding three ${FILLER}`, allowAll));
    await drain(engine.run(`padding four ${FILLER}`, allowAll));
    const second = engine.shed();
    assert.ok(second, "second shed should happen");

    assert.ok(
      !engine.getLedger().some((e) => e.path === "survivor.ts"),
      "after the second shed the entry must have departed memory",
    );
    assert.ok(
      archive.ledger().some((e) => e.path === "survivor.ts"),
      "and must be recoverable from the archive",
    );
  });

  it("refuses to shed when there is no archive to hold the evidence", async () => {
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "x.ts", content: "x\n" } }] },
      { text: "ok" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: null,
      // no archive on purpose
    });
    for (let i = 0; i < 6; i++) await drain(engine.run(`turn ${i} ${FILLER}`, allowAll));

    const before = JSON.stringify(engine.getRecord());
    assert.equal(engine.shed(), null, "shedding must not silently destroy evidence");
    assert.equal(JSON.stringify(engine.getRecord()), before, "and must change nothing");
  });
});

describe("deleting the archive changes an outcome", () => {
  it("record-intact fails once shed evidence is gone", async () => {
    const dir = ws();
    writeBar(
      dir,
      "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n  - name: intact\n    builtin: record-intact\n",
    );
    const { engine } = await sessionWithShedWrite(dir);
    assert.ok(engine.shedBatches > 0);

    // With the archive present, both checks pass.
    const before = (await engine.proveNow())!;
    assert.equal(before.ok, true, `expected a clean bar, got: ${JSON.stringify(before.results)}`);

    // Delete the exuviae. Nothing else changes — same files on disk, same
    // session in memory.
    const exuviae = join(dir, ".molt", "exuviae");
    for (const f of readdirSync(exuviae)) {
      if (f.endsWith(".md") && f !== "index.md") rmSync(join(exuviae, f));
    }

    const after = (await engine.proveNow())!;
    assert.equal(after.ok, false, "losing the archive must change the verdict");
    const intact = after.results.find((r) => r.name === "intact")!;
    assert.equal(intact.ok, false);
    assert.match(intact.output, /evidence chain is incomplete|remain recoverable|missing from the archive/);
  });

  it("fails when the batches are all present but the evidence inside is gone", async () => {
    // The sharper case: nothing is missing at the file level, so only a check
    // that actually reads the archive's contents can notice.
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    const { engine } = await sessionWithShedWrite(dir);
    assert.equal((await engine.proveNow())!.ok, true, "clean to begin with");

    const exuviae = join(dir, ".molt", "exuviae");
    let stripped = 0;
    for (const f of readdirSync(exuviae)) {
      if (!f.endsWith(".md") || f === "index.md") continue;
      const p = join(exuviae, f);
      const body = readFileSync(p, "utf8");
      if (!body.includes(LEDGER_MARKER)) continue;
      writeFileSync(p, body.replace(new RegExp("```" + LEDGER_MARKER + "[\\s\\S]*?```"), "```\nremoved\n```"));
      stripped++;
    }
    assert.ok(stripped > 0, "there was evidence to strip");

    const result = (await engine.proveNow())!;
    assert.equal(result.ok, false, "same batch count, missing evidence, still caught");
    assert.match(result.results[0].output, /remain recoverable|evidence chain is incomplete|missing from the archive/);
  });

  it("treats unparseable evidence as absent evidence", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    const { engine } = await sessionWithShedWrite(dir);

    const exuviae = join(dir, ".molt", "exuviae");
    for (const f of readdirSync(exuviae)) {
      if (!f.endsWith(".md") || f === "index.md") continue;
      const p = join(exuviae, f);
      const body = readFileSync(p, "utf8");
      if (!body.includes(LEDGER_MARKER)) continue;
      writeFileSync(
        p,
        body.replace(
          new RegExp("(```" + LEDGER_MARKER + "\\n)[\\s\\S]*?(\\n```)"),
          "$1{ this is not valid json$2",
        ),
      );
    }

    const result = (await engine.proveNow())!;
    assert.equal(result.ok, false, "unparseable evidence is absent evidence");
  });
});

describe("corrupted evidence in a later session", () => {
  it("record-intact fails on an unreadable evidence block, whichever session shed it", async () => {
    // Within the session that shed it, the write count catches a corrupted
    // block (the test above). Tomorrow the count it is compared against is
    // zero, so the same corruption passed — this project's own exuvia 0011
    // could have its 16 write records made unreadable and record-intact went
    // on reporting "archived and readable".
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    await sessionWithShedWrite(dir);

    const exuviae = join(dir, ".molt", "exuviae");
    let corrupted = 0;
    for (const f of readdirSync(exuviae)) {
      if (!f.endsWith(".md") || f === "index.md") continue;
      const p = join(exuviae, f);
      const body = readFileSync(p, "utf8");
      if (!body.includes(LEDGER_MARKER)) continue;
      writeFileSync(
        p,
        body.replace(new RegExp("(```" + LEDGER_MARKER + "\\n)[\\s\\S]*?(\\n```)"), "$1[GARBAGE$2"),
      );
      corrupted += 1;
    }
    assert.ok(corrupted > 0, "the fixture must have shed a write");

    // A fresh process: nothing in memory, no expectation but the disk.
    const fresh = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      archive: new Archive(dir),
    });
    const result = await runBar(loadBar(dir)!, fresh.barContext());
    assert.equal(result.ok, false, "unreadable evidence passed as archived and readable");
    assert.match(result.results[0]!.output, /cannot be read/);
    assert.deepEqual(new Archive(dir).damaged().length, corrupted);
  });
});

describe("claims-grounded", () => {
  function ctx(over: Partial<BarContext> = {}): BarContext {
    return { cwd: ws(), record: [], ledger: [], archivedBatches: 0, ...over };
  }
  const bar = parseBar("version: 1\nchecks:\n  - name: grounded\n    builtin: claims-grounded\n");

  it("fails a claim that names a file which was never created", async () => {
    const r = await runBar(bar, ctx({ claim: "Done — I added the fix in src/auth-refresh.ts." }));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /src\/auth-refresh\.ts/);
    assert.match(r.results[0].output, /do not exist and were never written/);
  });

  it("passes when the named file was written this session", async () => {
    const dir = ws();
    const ledger: LedgerEntry[] = [
      { path: "src/auth.ts", before: null, after: "abc", callId: "c1" },
    ];
    const r = await runBar(bar, ctx({ cwd: dir, claim: "Updated `src/auth.ts` as requested.", ledger }));
    assert.equal(r.ok, true);
  });

  it("passes when the named file merely exists on disk", async () => {
    const dir = ws();
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "guide.md"), "hi\n");
    const r = await runBar(bar, ctx({ cwd: dir, claim: "See docs/guide.md for details." }));
    assert.equal(r.ok, true);
  });

  it("fails a claim that says it CREATED a file the ledger never wrote, even if it exists", async () => {
    // A pre-existing file is not work the turn did. "Created src/auth.ts" over
    // a file that was already there is a separately catchable fabrication: the
    // old check only asked whether the file resolves, and existence on disk
    // satisfied it. A change and a creation are different claims — a creation
    // demands a write, and only the ledger can show one.
    const dir = ws();
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "auth.ts"), "pre-existing\n", "utf8");
    const r = await runBar(bar, ctx({ cwd: dir, claim: "Done — I created `src/auth.ts`." }));
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /created or added/);
    assert.match(r.results[0].output, /write ledger/);
  });

  it("passes a claim that CREATED a file the ledger actually wrote", async () => {
    const dir = ws();
    const ledger: LedgerEntry[] = [
      { path: "src/new.ts", before: null, after: "abc", callId: "c1" },
    ];
    const r = await runBar(bar, ctx({ cwd: dir, claim: "I created `src/new.ts`.", ledger }));
    assert.equal(r.ok, true);
  });

  it("is satisfied by evidence that only the archive holds", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: grounded\n    builtin: claims-grounded\n");
    const { engine, events } = await sessionWithShedWrite(dir, "shed-me.ts");

    // The claim names a file written before the shed, and the file was then
    // removed from disk — so only archived evidence can ground it.
    rmSync(join(dir, "shed-me.ts"));
    assert.ok(engine.shedBatches > 0);
    assert.ok(kinds(events).length > 0);

    const result = (await engine.proveNow("Done. The change is in shed-me.ts."))!;
    const grounded = result.results.find((r) => r.name === "grounded")!;
    assert.equal(grounded.ok, true, "the archive alone grounds the claim");
  });

  it("says nothing to ground rather than passing vacuously", async () => {
    assert.match((await runBar(bar, ctx({ claim: "" }))).results[0].output, /nothing to ground/i);
    assert.match((await runBar(bar, ctx({ claim: "All finished." }))).results[0].output, /no files/i);
  });
});

describe("mentionedPaths", () => {
  it("finds paths in prose and in backticks", () => {
    assert.deepEqual(mentionedPaths("I edited src/a.ts and `test/b.test.ts`.").sort(), [
      "src/a.ts",
      "test/b.test.ts",
    ]);
  });

  it("strips punctuation and a leading ./", () => {
    assert.deepEqual(mentionedPaths("Changed ./lib/x.js, then stopped."), ["lib/x.js"]);
  });

  it("ignores things that are not paths", () => {
    // Over-matching would fail correct work, which is worse than missing a
    // fabricated reference.
    for (const text of [
      "Bumped to version 2.14 today.",
      "See https://example.com/docs.html for more.",
      "The result was 3.5 seconds.",
      "It works. Nothing else to add.",
    ]) {
      assert.deepEqual(mentionedPaths(text), [], `over-matched in: ${text}`);
    }
  });

  it("does not duplicate a path mentioned twice", () => {
    assert.deepEqual(mentionedPaths("src/a.ts and again src/a.ts"), ["src/a.ts"]);
  });
});

describe("the default bar", () => {
  it("ships all three builtins and they all parse", () => {
    const dir = ws();
    mkdirSync(join(dir, ".molt"), { recursive: true });
    writeDefaultBar(dir);
    const bar = loadBar(dir)!;
    const builtins = bar.checks
      .filter((c) => c.kind === "builtin")
      .map((c) => (c.kind === "builtin" ? c.builtin : ""));
    assert.ok(builtins.includes("files-changed"));
    assert.ok(builtins.includes("record-intact"));
    assert.ok(builtins.includes("claims-grounded"));
    assert.ok(existsSync(join(dir, ".molt", "done.yml")));
  });
});

describe("cross-session archive integrity", () => {
  it("catches a deleted exuvia in a later process, using the journal as the expectation", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");

    const journal = new Journal(dir, "cross-1");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "early.ts", content: "e\n" } }] },
      ...Array.from({ length: 8 }, (_, i) => ({ calls: [{ name: "bash", args: { command: `echo ${i} ${FILLER}` } }] })),
      { text: "done" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      journal,
      autoShedAtTokens: 1200,
      maxProofAttempts: 1,
    });
    await drain(engine.run("build it", allowAll));
    assert.ok(engine.shedBatches > 0, "the session must have shed");

    const expected = Journal.expectedArchives(dir);
    assert.ok(expected.length > 0, "the journal recorded the archived batches");

    // A brand new engine — as if molt were restarted. Clean bar first.
    const fresh = () =>
      new Engine({
        baseUrl: "http://mock/v1",
        model: "m",
        cwd: dir,
        bar: loadBar(dir),
        archive: new Archive(dir),
      });
    assert.equal((await fresh().proveNow())!.ok, true, "clean to begin with, in a new process");

    // Delete one exuvia. In-memory expectation is gone with the old process;
    // only the journal remembers.
    const exuviae = join(dir, ".molt", "exuviae");
    const victim = readdirSync(exuviae).find((f) => /^\d{4}-.*\.md$/.test(f))!;
    rmSync(join(exuviae, victim));

    const after = (await fresh().proveNow())!;
    assert.equal(after.ok, false, "a later session must still notice the loss");
    assert.match(after.results[0].output, /missing from the archive/);
    assert.match(after.results[0].output, new RegExp(victim.replace(/\./g, "\\.")));
  });

  it("does not complain when the journal and the archive agree", async () => {
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    const journal = new Journal(dir, "cross-2");
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      archive: new Archive(dir),
      journal,
    });
    assert.equal((await engine.proveNow())!.ok, true, "a project that never shed is intact");
  });
});

describe("integrity when a shed batch held no writes", () => {
  it("still notices the loss — conversation is evidence too", async () => {
    // The write-count expectation cannot see this: there were no writes in
    // the batch. Only the batch count notices that archived conversation
    // has gone missing, and losing it means earlier reasoning can no longer
    // be audited even though no file work was lost.
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    const provider = scriptedProvider([{ text: "thinking out loud" }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      // no journal, so the batch count is the only expectation left
    });
    for (let i = 0; i < 6; i++) await drain(engine.run(`turn ${i} ${FILLER}`, allowAll));
    const shed = engine.shed();
    assert.ok(shed, "expected a shed");
    assert.equal(engine.mergedLedger().length, 0, "and no writes in it");
    assert.equal((await engine.proveNow())!.ok, true, "clean to begin with");

    const exuviae = join(dir, ".molt", "exuviae");
    for (const f of readdirSync(exuviae)) {
      if (/^\d{4}-.*\.md$/.test(f)) rmSync(join(exuviae, f));
    }

    const after = (await engine.proveNow())!;
    assert.equal(after.ok, false, "losing archived conversation must still fail");
    assert.match(after.results[0].output, /evidence chain is incomplete/);
  });
});

describe("integrity without a journal", () => {
  it("still catches a lost exuvia using the session's own count", async () => {
    // Not every deployment configures a journal. The in-session batch count
    // is the fallback expectation, and it has to work on its own.
    const dir = ws();
    writeBar(dir, "version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "early.ts", content: "e\n" } }] },
      ...Array.from({ length: 8 }, (_, i) => ({ calls: [{ name: "bash", args: { command: `echo ${i} ${FILLER}` } }] })),
      { text: "done" },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: loadBar(dir),
      archive: new Archive(dir),
      // no journal on purpose
      autoShedAtTokens: 1200,
      maxProofAttempts: 1,
    });
    await drain(engine.run("build it", allowAll));
    assert.ok(engine.shedBatches > 0);
    assert.equal((await engine.proveNow())!.ok, true, "clean to begin with");
    assert.deepEqual(Journal.expectedArchives(dir), [], "and no journal expectation exists");

    const exuviae = join(dir, ".molt", "exuviae");
    const victim = readdirSync(exuviae).find((f) => /^\d{4}-.*\.md$/.test(f))!;
    rmSync(join(exuviae, victim));

    const after = (await engine.proveNow())!;
    assert.equal(after.ok, false, "the session's own batch count must catch it");
    assert.match(after.results[0].output, /evidence chain is incomplete|remain recoverable/);
  });
});
