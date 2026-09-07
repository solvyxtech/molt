/**
 * Three ways a check can pass without having checked anything.
 *
 * All three were found by reading molt's own record rather than its source, on
 * 2026-09-07:
 *
 *  1. `work-checked` (mutation) went green on receipt 0052 saying "nothing was
 *     mutated, so nothing is claimed" — while `work-proven` (diff-covered), one
 *     row above it on the same receipt, fails when its input is missing. Two
 *     checks, the same principle, opposite answers.
 *  2. `record-intact` had refused nothing in 34 recorded bar runs. It is well
 *     tested and does fail on real corruption, but a receipt could not
 *     distinguish "audited twelve batches" from "there was no archive", because
 *     both printed as `pass`.
 *  3. Nothing in the bar was about the built artifact at all: a turn fixed
 *     `src/`, went green on ten checks, and the person who opened the app got a
 *     build from forty minutes earlier.
 *
 * The rule these settle on: a check that examined nothing never presents as one
 * that cleared the work. Where there was work in scope and it was not examined,
 * that is a refusal; where there was genuinely nothing in scope, it passes and
 * says so.
 */
import assert from "node:assert/strict";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { BUILTINS, mutationVerdict, parseBar, runBar, type BarContext } from "../src/bar.js";
import type { LedgerEntry } from "../src/types.js";
import { CLAUDE_CODE_URL } from "../src/claude-code.js";
import { endpointProblem } from "../src/providers.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** A ledger entry for a file this turn wrote. */
function wrote(path: string, lines = [1]): LedgerEntry {
  return {
    path,
    before: null,
    after: "a".repeat(8),
    bytes: 10,
    changedLines: lines,
  } as unknown as LedgerEntry;
}

function ctxIn(dir: string, ledger: LedgerEntry[]): BarContext {
  return {
    cwd: dir,
    ledger,
    turnLedger: ledger,
    record: [],
    archivedBatches: 0,
    sessionArchives: [],
  } as unknown as BarContext;
}

describe("the mutation check answers its input the way diff-covered does", () => {
  it("refuses when there were lines to mutate and none was mutated", () => {
    const r = mutationVerdict({ killed: [], survived: [], planned: 3, total: 12, sample: 3 });
    assert.equal(r.ok, false, "12 changed lines and nothing mutated is not a pass");
    assert.match(r.output, /none was mutated/);
    // The refusal has to name the way out, or it is a wall rather than a gate.
    assert.match(r.output, /empty: allow/);
  });

  it("refuses even when nothing could be planned, if there was work in scope", () => {
    const r = mutationVerdict({ killed: [], survived: [], planned: 0, total: 7, sample: 3 });
    assert.equal(r.ok, false);
    assert.match(r.output, /no mutation could be planned/);
  });

  /**
   * The one genuinely empty scope. A docs-only turn has no operator to flip
   * and refusing it would be its own lie — but it must not read as proof the
   * tests would catch a break either.
   */
  it("passes with nothing established when no line was ever mutable", () => {
    const r = mutationVerdict({ killed: [], survived: [], planned: 0, total: 0, sample: 3 });
    assert.equal(r.ok, true);
    assert.equal(r.established, false, "an empty scope establishes nothing");
    assert.match(r.output, /nothing is claimed/);
  });

  it("honours empty: allow, and still claims nothing", () => {
    const r = mutationVerdict({
      killed: [],
      survived: [],
      planned: 2,
      total: 9,
      sample: 3,
      allowEmpty: true,
    });
    assert.equal(r.ok, true);
    assert.equal(r.established, false);
  });

  it("still passes normally when mutations were killed", () => {
    const r = mutationVerdict({ killed: ["a", "b"], survived: [], planned: 2, total: 2, sample: 3 });
    assert.equal(r.ok, true);
    assert.notEqual(r.established, false, "this one did establish something");
  });

  it("still refuses a survivor", () => {
    const r = mutationVerdict({ killed: [], survived: ["x:1"], planned: 1, total: 1, sample: 3 });
    assert.equal(r.ok, false);
  });
});

/**
 * Caught by running the whole bar, not by the unit tests above.
 *
 * `mutationVerdict` is only reached once a mutation plan exists. Receipt 0052
 * never got that far — `mutationCheck` returns early when no changed line
 * carries an operator, and that early return was still printing a bare green
 * `pass`. Fixing the verdict function alone left the exact receipt that
 * started this untouched, which is why this suite runs the check itself.
 */
describe("the mutation check's early exits claim nothing either", () => {
  const BAR = parseBar(
    "version: 1\nchecks:\n  - name: mutated\n    builtin: mutation\n    run: 'true'\n",
  );

  it("establishes nothing when no changed line has an operator to flip", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), 'export const greeting = "hello";\n');
    const ctx = ctxIn(dir, [wrote("a.ts", [1])]);
    const [r] = (await runBar(BAR, ctx)).results;
    assert.equal(r?.ok, true, "a turn with nothing mutable is not a failing turn");
    assert.equal(r?.established, false, "…and receipt 0052 must not read as proof again");
    assert.match(r?.output ?? "", /no line with an operator to flip/);
  });

  it("establishes nothing when there were no changed lines at all", async () => {
    const dir = ws();
    const ctx = ctxIn(dir, []);
    const [r] = (await runBar(BAR, ctx)).results;
    assert.equal(r?.ok, true);
    assert.equal(r?.established, false);
  });
});

describe("record-intact says which kind of pass it is", () => {
  it("establishes nothing when there is no archive to audit", async () => {
    const dir = ws();
    const bar = parseBar("version: 1\nchecks:\n  - name: intact\n    builtin: record-intact\n");
    const [r] = (await runBar(bar, ctxIn(dir, []))).results;
    assert.equal(r?.ok, true, "a project that has never shed is not failing");
    assert.equal(r?.established, false, "…but nothing was audited, and the receipt must say so");
  });
});

describe("build-current: what you ship, against what you changed", () => {
  const BAR = (outputs: string, from = "") =>
    parseBar(
      `version: 1\nchecks:\n  - name: shipped\n    builtin: build-current\n` +
        `    outputs: ${outputs}\n` +
        (from ? `    from: ${from}\n` : ""),
    );

  function build(dir: string, source: string, out: string, outAgeSec: number): void {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "out"), { recursive: true });
    writeFileSync(join(dir, source), "export const x = 1;\n");
    writeFileSync(join(dir, out), "bundled\n");
    const now = Date.now() / 1000;
    utimesSync(join(dir, source), now, now);
    utimesSync(join(dir, out), now - outAgeSec, now - outAgeSec);
  }

  /** The exact shape of the 2026-09-07 miss: source fixed, artifact stale. */
  it("refuses when the built output is older than this turn's source", async () => {
    const dir = ws();
    build(dir, "src/a.ts", "out/main.cjs", 2400);
    const ctx = ctxIn(dir, [wrote("src/a.ts")]);
    const [r] = (await runBar(BAR("out/main.cjs"), ctx)).results;
    assert.equal(r?.ok, false);
    assert.match(r?.output ?? "", /older than this turn's work/);
    assert.match(r?.output ?? "", /out\/main\.cjs/);
    assert.match(r?.output ?? "", /40 min/, "say how far behind, not just that it is");
  });

  it("passes once the output is newer, and says what it compared", async () => {
    const dir = ws();
    build(dir, "src/a.ts", "out/main.cjs", -60);
    const ctx = ctxIn(dir, [wrote("src/a.ts")]);
    const [r] = (await runBar(BAR("out/main.cjs"), ctx)).results;
    assert.equal(r?.ok, true, r?.output);
    assert.match(r?.output ?? "", /newer than/);
    assert.notEqual(r?.established, false);
  });

  it("refuses an output that was never built at all", async () => {
    const dir = ws();
    build(dir, "src/a.ts", "out/main.cjs", 10);
    const ctx = ctxIn(dir, [wrote("src/a.ts")]);
    const [r] = (await runBar(BAR("out/missing.cjs"), ctx)).results;
    assert.equal(r?.ok, false);
    assert.match(r?.output ?? "", /do not exist/);
  });

  /**
   * A turn that edits only documentation must not be told to rebuild. `from`
   * is what keeps this check from becoming noise everyone learns to ignore.
   */
  it("establishes nothing when the turn changed nothing that feeds the build", async () => {
    const dir = ws();
    build(dir, "src/a.ts", "out/main.cjs", 2400);
    writeFileSync(join(dir, "README.md"), "# docs\n");
    const ctx = ctxIn(dir, [wrote("README.md")]);
    const [r] = (await runBar(BAR("out/main.cjs", "src"), ctx)).results;
    assert.equal(r?.ok, true, "a docs turn is not a stale build");
    assert.equal(r?.established, false);
  });

  it("does not ask the build to be newer than itself", async () => {
    const dir = ws();
    build(dir, "src/a.ts", "out/main.cjs", 2400);
    // The turn "wrote" the output too — a build step often does. That must not
    // make the output stale relative to itself.
    const ctx = ctxIn(dir, [wrote("out/main.cjs")]);
    const [r] = (await runBar(BAR("out/main.cjs"), ctx)).results;
    assert.equal(r?.ok, true);
    assert.equal(r?.established, false);
  });

  it("is refused at parse time when it is not told what ships", () => {
    assert.throws(
      () => parseBar("version: 1\nchecks:\n  - name: shipped\n    builtin: build-current\n"),
      /needs `outputs`/,
    );
  });

  it("refuses `outputs` on a check that is not build-current", () => {
    assert.throws(
      () =>
        parseBar(
          "version: 1\nchecks:\n  - name: x\n    builtin: files-changed\n    outputs: out/a\n",
        ),
      /only applies to the build-current builtin/,
    );
  });

  it("is a builtin the bar will name", () => {
    assert.ok(BUILTINS.includes("build-current"));
  });
});

/**
 * An endpoint that is not an address is not a network outage.
 *
 * Reported live: `molt run --url claude-code` typed at a build without the
 * shorthand became `claude-code/chat/completions`, which `fetch` rejects as an
 * invalid URL. molt retried it four times over seven and a half seconds and
 * reported "network: TypeError". Nothing was down, and the second attempt was
 * never going to differ from the first.
 */
describe("an endpoint molt cannot use is refused, not retried", () => {
  it("names what is wrong with a string that is not a URL", () => {
    const why = endpointProblem("claude-code");
    assert.ok(why, "a bare word is not an endpoint");
    assert.match(why, /not an endpoint/);
    // The message has to carry the two spellings that do work, or it is a
    // refusal with nowhere to go.
    assert.match(why, /https:\/\//);
    assert.match(why, /claude-code/);
  });

  it("refuses a scheme molt does not speak", () => {
    const why = endpointProblem("ftp://example.com/v1");
    assert.ok(why);
    assert.match(why, /ftp/);
  });

  it("says so when no endpoint is set at all", () => {
    assert.match(endpointProblem("") ?? "", /no endpoint is set/);
  });

  it("accepts the shapes that actually work", () => {
    assert.equal(endpointProblem("https://api.openai.com/v1"), null);
    assert.equal(endpointProblem("http://localhost:11434/v1"), null);
    assert.equal(endpointProblem(CLAUDE_CODE_URL), null);
  });
});
