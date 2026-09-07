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
import { Engine } from "../src/engine.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, scriptedProvider, workspace } from "./helpers.js";

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

/**
 * The bar moving, and whether molt knows who moved it.
 *
 * Three wordings in one day, which is itself the lesson. It began as an
 * accusation — "the definition of done cannot be edited by the work being
 * judged against it" — aimed on 2026-09-07 at a turn that had never touched
 * the file while a person armed a check in another window. It was then
 * softened to hedge in every case, which threw away something molt has: a
 * tool call that writes `.molt/done.yml` leaves a ledger entry naming it.
 *
 * Blaming everywhere and hedging everywhere are the same mistake. The check
 * refuses either way — a bar that moved mid-session cannot judge the claim, by
 * anyone's hand — and only the sentence changes.
 */
describe("bar-unmodified says only what the ledger supports", () => {
  const BAR = "version: 1\nchecks:\n  - name: suite\n    run: exit 0\n";

  async function tamperOutput(edit: "tool" | "outside"): Promise<string> {
    const dir = ws();
    mkdirSync(join(dir, ".molt"), { recursive: true });
    writeFileSync(join(dir, ".molt", "done.yml"), BAR);
    const provider = scriptedProvider([
      edit === "tool"
        ? {
            calls: [
              {
                name: "write_file",
                args: { path: ".molt/done.yml", content: BAR + "  - name: extra\n    run: exit 0\n" },
              },
            ],
          }
        : { calls: [{ name: "write_file", args: { path: "real.txt", content: "work\n" } }] },
      { text: "Done." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "m",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar(BAR),
      autonomy: "high",
      maxProofAttempts: 1,
    });
    const events: EngineEvent[] = [];
    for await (const ev of engine.run("go", allowAll)) {
      events.push(ev);
      // The other writer: after the turn's first write, change the bar by a
      // route no tool call of this turn took.
      if (edit === "outside" && ev.kind === "tool") {
        writeFileSync(join(dir, ".molt", "done.yml"), BAR + "  - name: theirs\n    run: exit 0\n");
      }
    }
    const end = events.find(
      (e) => e.kind === "proof_refused" || e.kind === "proof_exhausted",
    ) as { result: { results: { name: string; output: string }[] } } | undefined;
    assert.ok(end, "the moved bar should have refused the claim");
    const tamper = end.result.results.find((r) => r.name === "bar-unmodified");
    assert.ok(tamper, "bar-unmodified should be present");
    return tamper.output;
  }

  it("names the turn when a tool call of this turn wrote the bar", async () => {
    const out = await tamperOutput("tool");
    assert.match(out, /This turn wrote \.molt\/done\.yml/);
    assert.match(out, /always passes/, "and why that is refused");
    assert.doesNotMatch(out, /molt cannot tell/, "there is nothing here to be uncertain about");
  });

  it("does not name the turn when no tool call of this turn wrote it", async () => {
    const out = await tamperOutput("outside");
    assert.match(out, /no tool call in this turn wrote it/);
    assert.match(out, /Retrying will not clear this/);
    assert.doesNotMatch(
      out,
      /This turn wrote/,
      "molt did not see this turn write the bar, so it must not say it did",
    );
  });
});
