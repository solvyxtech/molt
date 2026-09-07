/**
 * Who molt says did a thing, when it does not know.
 *
 * On 2026-09-07 three agents were writing to this checkout at once: a turn
 * running in the window, and two other sessions. The turn was refused four
 * times and exhausted, on twelve unexplained files of which eight belonged to
 * another writer and on assertions it had never touched. Every fact molt
 * printed was true. The subject of every sentence was wrong: "12 file(s)
 * changed on disk **this turn** that no tool call wrote", "**This turn**
 * deleted 3 assertion(s)".
 *
 * The turn spent its final message defending itself with file mtimes and
 * another session's commit hash. It was right to, and it should never have had
 * to — a harness built to refuse unearned claims had made one, about the only
 * party present to blame for it.
 *
 * What the check knows is that the tree differs from its pre-turn snapshot and
 * no ledger entry explains the difference. That is what it says now.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { parseBar, runBar, type BarContext } from "../src/bar.js";
import { snapshotTree } from "../src/files.js";
import type { LedgerEntry } from "../src/types.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

const ACCOUNTED = parseBar(
  "version: 1\nchecks:\n  - name: accounted\n    builtin: tree-accounted\n",
);
const SPEC = parseBar("version: 1\nchecks:\n  - name: spec\n    builtin: spec-intact\n");

function ctxIn(dir: string, over: Partial<BarContext> = {}): BarContext {
  return {
    cwd: dir,
    ledger: [],
    turnLedger: [],
    record: [],
    archivedBatches: 0,
    sessionArchives: [],
    ...over,
  } as unknown as BarContext;
}

describe("a change molt cannot attribute is not pinned on the turn", () => {
  it("separates files this session opened from files it never touched", async () => {
    const dir = ws();
    writeFileSync(join(dir, "mine.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "theirs.ts"), "export const b = 1;\n");
    const before = snapshotTree(dir);
    // Both change outside the tools; only one was ever opened by this session.
    writeFileSync(join(dir, "mine.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "theirs.ts"), "export const b = 2;\n");

    const [r] = (
      await runBar(ACCOUNTED, ctxIn(dir, { treeBefore: before, read: ["mine.ts"] }))
    ).results;
    assert.equal(r?.ok, false, "an unexplained change is still refused, whoever made it");
    const out = r?.output ?? "";

    assert.doesNotMatch(out, /this turn that no tool call wrote/, "the old accusation is gone");
    assert.match(out, /since this turn began/, "what it knows is when, not who");
    assert.match(out, /this session has opened/i);
    assert.match(out, /never read or written/i);
    // Each path under the heading that fits it.
    const opened = out.slice(out.indexOf("has opened"), out.indexOf("never read"));
    assert.match(opened, /mine\.ts/);
    assert.doesNotMatch(opened, /theirs\.ts/);
  });

  /**
   * The part that cost four attempts: a turn told to try harder at something
   * it did not do will try harder, and fail again, until it is exhausted.
   */
  it("tells a turn when working harder cannot clear it", async () => {
    const dir = ws();
    writeFileSync(join(dir, "theirs.ts"), "export const b = 1;\n");
    const before = snapshotTree(dir);
    writeFileSync(join(dir, "theirs.ts"), "export const b = 2;\n");
    const [r] = (await runBar(ACCOUNTED, ctxIn(dir, { treeBefore: before, read: [] }))).results;
    assert.match(r?.output ?? "", /no amount of further work will clear this/i);
    assert.match(r?.output ?? "", /another session, an editor or a watch process/i);
  });

  it("still says the turn did it when a tool call is what wrote it", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const before = snapshotTree(dir);
    writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
    const ledger = [
      { path: "a.ts", before: "x", after: "y", bytes: 1, changedLines: [1] },
    ] as unknown as LedgerEntry[];
    const [r] = (
      await runBar(ACCOUNTED, ctxIn(dir, { treeBefore: before, ledger, turnLedger: ledger }))
    ).results;
    assert.equal(r?.ok, true, "a ledgered write is accounted for");
  });
});

describe("spec-intact says which route the removal took", () => {
  function testFile(dir: string, body: string): void {
    mkdirSync(join(dir, "test"), { recursive: true });
    writeFileSync(join(dir, "test", "a.test.ts"), body);
  }

  it("does not say 'this turn deleted' when no tool call did", async () => {
    const dir = ws();
    testFile(dir, 'import assert from "node:assert";\nassert.equal(1, 1);\nassert.equal(2, 2);\n');
    const before = snapshotTree(dir);
    // Removed on disk, by nothing molt ran.
    testFile(dir, 'import assert from "node:assert";\nassert.equal(1, 1);\n');

    const [r] = (await runBar(SPEC, ctxIn(dir, { treeBefore: before }))).results;
    assert.equal(r?.ok, false, "a lost assertion is still refused");
    const out = r?.output ?? "";
    assert.doesNotMatch(out, /^This turn deleted/m, "molt did not see this turn delete anything");
    assert.match(out, /since this turn began/);
    assert.match(out, /changed on disk, not through a tool/, "the route stays on the line");
    assert.match(out, /working harder cannot clear a change this turn did not make/i);
  });
});
