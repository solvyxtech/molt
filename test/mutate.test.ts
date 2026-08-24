/**
 * Breaking a line on purpose, to find out whether anything would notice.
 *
 * The rung above coverage. `diff-covered` proves a line runs; it cannot prove
 * anything checks what the line does, and a test that executes code while
 * asserting nothing satisfies it completely.
 *
 * The failure mode these guard against is specific and has happened twice by
 * hand in this project: a mutation is written, silently fails to apply, the
 * suite runs green, and the green is read as "the fix is tested" when it means
 * "nothing was broken". A mutator that can return an unchanged line is a
 * mutator that manufactures false confidence.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck, mutationVerdict, type BarContext } from "../src/bar.js";
import type { Check, CheckResult } from "../src/types.js";
import { mutateLine, planMutations, applyMutation } from "../src/mutate.js";

describe("mutating one line", () => {
  it("flips a comparison", () => {
    const m = mutateLine("  if (path.length > MAX_PATH_LENGTH) return false;");
    assert.ok(m);
    assert.match(m.after, />=/);
    assert.notEqual(m.after, "  if (path.length > MAX_PATH_LENGTH) return false;");
  });

  it("flips equality, boolean operators and literals", () => {
    assert.match(mutateLine("if (a === b) x();")!.after, /!==/);
    assert.match(mutateLine("if (a && b) x();")!.after, /\|\|/);
    assert.match(mutateLine("const ok = true;")!.after, /false/);
  });

  it("never returns the line unchanged", () => {
    // The whole point. A "mutation" identical to the original produces a green
    // run that means nothing, which is exactly how this discipline has been
    // fooled before.
    const samples = [
      "if (a >= b) c();",
      "return x !== y;",
      "const f = false;",
      "while (i < n && ok) i++;",
    ];
    for (const line of samples) {
      const m = mutateLine(line);
      assert.ok(m, `no mutation for: ${line}`);
      assert.notEqual(m.after, line, `mutation was a no-op for: ${line}`);
    }
  });

  it("declines lines with nothing to flip, rather than inventing one", () => {
    // Null is a normal outcome. Reporting these as unmutated is honest;
    // pretending to have tested them is not.
    assert.equal(mutateLine("const name = compute();"), null);
    assert.equal(mutateLine(""), null);
    assert.equal(mutateLine("  // a comment"), null);
    assert.equal(mutateLine('import { x } from "./y.js";'), null);
  });

  it("does not mistake arrows or shifts for comparisons", () => {
    // `=>` and `->` contain `>`; flipping one produces code that does not
    // compile, and a check that fails to build reports every line as unproven.
    const arrow = mutateLine("const f = (a) => a;");
    if (arrow) assert.ok(!arrow.after.includes("=>="), `broke an arrow: ${arrow.after}`);
    const shift = mutateLine("const n = a >= b;");
    assert.ok(shift, "a real comparison must still mutate");
  });
});

describe("planning which lines to break", () => {
  const file = (path: string, lines: string[]) => ({
    path,
    text: lines.join("\n"),
    changedLines: lines.map((_, i) => i + 1),
  });

  it("spreads across files rather than spending the budget on one", () => {
    // A sample concentrated in one file says nothing about the rest.
    const plan = planMutations(
      [
        file("a.ts", ["if (x > 1) a();", "if (y > 2) b();", "if (z > 3) c();"]),
        file("b.ts", ["if (p === q) d();", "if (r === s) e();"]),
      ],
      4,
    ) as (ReturnType<typeof planMutations>[number] & { path: string })[];
    assert.equal(plan.length, 4);
    const paths = new Set(plan.map((m) => m.path));
    assert.equal(paths.size, 2, "both files must be represented");
  });

  it("stops at the sample size", () => {
    const plan = planMutations([file("a.ts", ["if (x > 1) a();", "if (y > 2) b();"])], 1);
    assert.equal(plan.length, 1);
  });

  it("returns nothing when no line can be broken", () => {
    const plan = planMutations([file("a.ts", ["const a = compute();", "// note"])], 4);
    assert.deepEqual(plan, []);
  });
});

describe("applying and reverting", () => {
  it("refuses to apply when the line has moved", () => {
    // A stale plan must not rewrite whatever now happens to be on that line.
    const text = "one\nif (a > b) c();\nthree";
    const m = { line: 2, before: "if (a > b) c();", after: "if (a >= b) c();", operator: "> to >=" };
    assert.equal(applyMutation(text, m), "one\nif (a >= b) c();\nthree");
    assert.equal(applyMutation("one\nSOMETHING ELSE\nthree", m), null);
  });

  it("changes exactly one line and leaves the rest byte-identical", () => {
    const text = "a\nif (x > 1) go();\nb\nc";
    const m = { line: 2, before: "if (x > 1) go();", after: "if (x >= 1) go();", operator: "x" };
    const out = applyMutation(text, m)!;
    const before = text.split("\n");
    const after = out.split("\n");
    assert.equal(after.length, before.length);
    for (let i = 0; i < before.length; i++) {
      if (i === 1) assert.notEqual(after[i], before[i]);
      else assert.equal(after[i], before[i], `line ${i + 1} must not move`);
    }
  });
});

/**
 * The check as a whole, against a real command and a real file.
 *
 * The first property below was missing until a hand-run probe found it, and
 * the fix arrived without a test — which is the failure this project keeps
 * having. Written down now so it cannot come back quietly.
 */
describe("the mutation check", () => {
  // Plain scripts rather than `node --test`. Running one test runner inside
  // another sets NODE_TEST_CONTEXT, which changes how the inner one reports
  // and exits — an artifact of this harness that made a correct check look
  // broken for twenty minutes. Nothing about the check requires it.
  const WEAK = [
    'import { over } from "../code.js";',
    "over(2, 1);", // executes the line, checks nothing — coverage would call this fine
    "",
  ].join("\n");

  const STRONG = [
    'import assert from "node:assert";',
    'import { over } from "../code.js";',
    "assert.equal(over(2, 1), 1);",
    "assert.equal(over(1, 1), 0);", // the boundary the mutation moves
    "",
  ].join("\n");

  function project(testBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mutchk-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(dir, "code.js"),
      "export function over(a, b) {\n  if (a > b) return 1;\n  return 0;\n}\n",
    );
    mkdirSync(join(dir, "t"), { recursive: true });
    writeFileSync(join(dir, "t", "check.js"), testBody);
    return dir;
  }

  const check = (run: string) => ({
    name: "m",
    kind: "builtin" as const,
    builtin: "mutation" as const,
    tags: [] as string[],
    run,
    sample: 1,
    timeoutMs: 30_000,
  });

  const ctx = (dir: string): BarContext => ({
    cwd: dir,
    record: [],
    archivedBatches: 0,
    ledger: [{ path: "code.js", before: "x", after: "y", callId: "c1", changedLines: [2] }],
  });

  it("refuses to run when the suite is already failing", async () => {
    // The flaw this exists for. A red baseline makes every mutation look
    // killed — the command failed, after all — and the check reports "N
    // mutations broke a test, as they should" having tested nothing. That is
    // the exact shape of false confidence molt exists to refuse, and it
    // survived a hand-written probe before being caught.
    const dir = project(WEAK);
    try {
      const r = await runCheck(check("exit 1"), ctx(dir));
      assert.equal(r.ok, false);
      assert.match(r.output, /fails on the unmutated code/);
      assert.match(r.output, /proves nothing/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("catches a test that executes the line without checking it", async () => {
    const dir = project(WEAK);
    try {
      const r = await runCheck(check("node t/check.js"), ctx(dir));
      assert.equal(r.ok, false, "a surviving mutation must fail the check");
      assert.match(r.output, /nothing failed/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("passes a test that pins the behaviour", async () => {
    const dir = project(STRONG);
    try {
      const r = await runCheck(check("node t/check.js"), ctx(dir));
      assert.equal(r.ok, true, r.output);
      assert.match(r.output, /broke a test, as they should/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves the file byte-identical whatever happens", async () => {
    // A verification tool that alters your source has done something worse
    // than miss a bug. Checked for a normal run and for a command that does
    // not exist at all.
    for (const cmd of ["node t/check.js", "definitely-not-a-command-xyz"]) {
      const dir = project(WEAK);
      const file = join(dir, "code.js");
      const before = readFileSync(file, "utf8");
      try {
        await runCheck(check(cmd), ctx(dir));
        assert.equal(readFileSync(file, "utf8"), before, `not restored after: ${cmd}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

/**
 * The verdict, apart from the running.
 *
 * These four outcomes are the whole contract of the check, and three of them
 * were only ever exercised incidentally by the end-to-end tests above. The
 * "none applied" case could not be exercised at all: it guards an invariant
 * `mutationCheck` currently upholds, which is precisely the shape of line the
 * mutation check refuses to let anyone else ship — reached by no test and
 * defended only by an argument.
 */
describe("the mutation verdict", () => {
  const base = { killed: [], survived: [], planned: 0, total: 0, sample: 4 };

  it("claims nothing when nothing was applied", () => {
    // The dangerous fall-through. Without this the same counts render as
    // "0 mutation(s) broke a test, as they should" — a pass asserting the
    // suite killed everything, after breaking the code exactly zero times.
    const r = mutationVerdict({ ...base, planned: 3, total: 3 });
    assert.equal(r.ok, true);
    assert.match(r.output, /3 mutation\(s\) planned, none applied/);
    assert.match(r.output, /nothing is claimed/);
    assert.doesNotMatch(r.output, /as they should/);
  });

  it("passes when every applied mutation was killed", () => {
    const r = mutationVerdict({ ...base, killed: ["a.ts:1 (> to >=)"], planned: 1, total: 1 });
    assert.equal(r.ok, true);
    assert.match(r.output, /1 mutation\(s\) broke a test, as they should/);
  });

  it("fails when a mutation survived, and names it", () => {
    const r = mutationVerdict({
      ...base,
      killed: ["a.ts:1 (> to >=)"],
      survived: ["b.ts:7 (&& to ||) — if (a && b) return 1;"],
      planned: 2,
      total: 2,
    });
    assert.equal(r.ok, false);
    assert.match(r.output, /1 of 2 mutation\(s\) changed the code and nothing failed/);
    assert.match(r.output, /b\.ts:7/);
  });

  it("says how much it did not look at, and stays quiet when it looked at all of it", () => {
    // A bound nobody is told about reads as completeness. The pass case is
    // the one that matters: "2 broke a test" on a 9-line diff means something
    // very different from the same sentence on a 2-line diff.
    const bounded = mutationVerdict({
      ...base,
      killed: ["a.ts:1 (> to >=)", "a.ts:2 (< to <=)"],
      planned: 2,
      total: 9,
      sample: 2,
    });
    assert.equal(bounded.ok, true);
    assert.match(bounded.output, /7 changed line\(s\) not mutated \(sample is 2/);

    const complete = mutationVerdict({ ...base, killed: ["a.ts:1 (> to >=)"], planned: 1, total: 1 });
    assert.doesNotMatch(complete.output, /not mutated/);
  });
});

/**
 * Paying once for the baseline instead of twice.
 *
 * The mutation check must know the command passes on unmutated code before a
 * red run means anything. On this project that command is the suite — the most
 * expensive thing molt runs — and the `tests` check ran it moments earlier
 * against the same untouched tree. Reusing that answer saves a full suite run
 * on every bar attempt; reusing the *wrong* answer would silently remove the
 * one guard that makes every other result in this check meaningful. So what
 * counts as reusable is tested here in more detail than the saving is.
 */
describe("the mutation baseline", () => {
  // Each invocation leaves a mark, so the tests below count runs rather than
  // trusting a report about them.
  const COUNTED = "echo . >> runs.log && node t/check.js";

  function project(testBody: string): string {
    const dir = mkdtempSync(join(tmpdir(), "mutbase-"));
    writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(
      join(dir, "code.js"),
      "export function over(a, b) {\n  if (a > b) return 1;\n  return 0;\n}\n",
    );
    mkdirSync(join(dir, "t"), { recursive: true });
    writeFileSync(join(dir, "t", "check.js"), testBody);
    return dir;
  }

  const STRONG = [
    'import assert from "node:assert";',
    'import { over } from "../code.js";',
    "assert.equal(over(2, 1), 1);",
    "assert.equal(over(1, 1), 0);",
    "",
  ].join("\n");

  const check = (run: string) => ({
    name: "m",
    kind: "builtin" as const,
    builtin: "mutation" as const,
    tags: [] as string[],
    run,
    sample: 1,
    timeoutMs: 30_000,
  });

  /** A plain check that already ran `run` in this bar attempt. */
  function ran(run: string, ok: boolean, over: Partial<Check & CheckResult> = {}) {
    return {
      check: {
        name: "tests",
        kind: "command" as const,
        run,
        timeoutMs: 30_000,
        expectExit: 0,
        tags: [],
        ...over,
      } as Check,
      result: {
        name: "tests",
        kind: "command" as const,
        detail: run,
        ok,
        output: "",
        durationMs: 1,
        ...over,
      } as CheckResult,
    };
  }

  const ctx = (dir: string, over: Partial<BarContext> = {}): BarContext => ({
    cwd: dir,
    record: [],
    archivedBatches: 0,
    ledger: [{ path: "code.js", before: "x", after: "y", callId: "c1", changedLines: [2] }],
    ...over,
  });

  const runs = (dir: string): number => {
    try {
      return readFileSync(join(dir, "runs.log"), "utf8").trim().split("\n").filter(Boolean).length;
    } catch {
      return 0;
    }
  };

  it("runs the command itself when nothing ran it first", async () => {
    const dir = project(STRONG);
    try {
      const r = await runCheck(check(COUNTED), ctx(dir));
      assert.equal(r.ok, true, r.output);
      // One baseline, one mutation.
      assert.equal(runs(dir), 2, "expected a baseline run and one mutated run");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips the baseline when an earlier check just ran the same command", async () => {
    const dir = project(STRONG);
    try {
      const r = await runCheck(
        check(COUNTED),
        ctx(dir, { earlier: [ran(COUNTED, true)] }),
      );
      assert.equal(r.ok, true, r.output);
      assert.equal(runs(dir), 1, "ran the baseline again despite an earlier identical run");
      // The saving must not cost the finding: the mutation still happened.
      assert.match(r.output, /broke a test, as they should/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not run at all when that earlier check failed", async () => {
    const dir = project(STRONG);
    try {
      const r = await runCheck(
        check(COUNTED),
        ctx(dir, { earlier: [ran(COUNTED, false)] }),
      );
      assert.equal(r.ok, false);
      assert.match(r.output, /already failed this bar run as check "tests"/);
      assert.match(r.output, /did not run/);
      assert.equal(runs(dir), 0, "spent a suite run to rediscover a known failure");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  for (const [why, earlier] of [
    ["a different command", () => ran("node t/other.js", true)],
    ["a check that passes by failing", () => ran(COUNTED, true, { expectExit: 1 })],
    ["a result that was reused rather than run", () => ran(COUNTED, true, { cached: true })],
  ] as const) {
    it(`still runs its own baseline after ${why}`, async () => {
      // Each of these is a "pass" that does not mean what the baseline needs
      // it to mean. Accepting one would drop the guard without saying so.
      const dir = project(STRONG);
      try {
        const r = await runCheck(check(COUNTED), ctx(dir, { earlier: [earlier()] }));
        assert.equal(r.ok, true, r.output);
        assert.equal(runs(dir), 2, "reused a result that was not a green run of this command");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("puts back a report another check reads", async () => {
    // The failure this closes: the command writes coverage/lcov.info, this
    // check reruns it from broken source, and `diff-covered` — never cached —
    // judges the turn on coverage produced by code that was deliberately
    // wrong. A mutated run whose suite fails writes a materially shorter
    // report, so a good turn fails a check for a reason not on disk any more.
    const dir = project(STRONG);
    try {
      mkdirSync(join(dir, "coverage"), { recursive: true });
      const lcov = join(dir, "coverage", "lcov.info");
      writeFileSync(lcov, "REAL COVERAGE FROM THE REAL CODE\n");
      const clobber = "echo CLOBBERED > coverage/lcov.info && node t/check.js";
      const r = await runCheck(
        check(clobber),
        ctx(dir, { protect: ["coverage/lcov.info"] }),
      );
      assert.equal(r.ok, true, r.output);
      assert.equal(
        readFileSync(lcov, "utf8"),
        "REAL COVERAGE FROM THE REAL CODE\n",
        "left a later check reading coverage generated from mutated source",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
