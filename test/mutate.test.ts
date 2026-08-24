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
import { runCheck, type BarContext } from "../src/bar.js";
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
