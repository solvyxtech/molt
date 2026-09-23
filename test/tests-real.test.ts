/**
 * Tests that prove only their own premise.
 *
 * Each case is a test a turn could add that passes on the broken code as well
 * as the fixed one: `mutation` sees the changed line executed, `diff-covered`
 * sees it covered, and neither asks whether anything could have failed. The
 * negatives are the shapes of ordinary tests in this repository and the
 * libraries it depends on, because a check that refuses a normal test refuses
 * correct work.
 */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { snapshotTree } from "../src/files.js";
import {
  closeOf,
  selfProvingTests,
  tautologiesIn,
  testBlocksIn,
  testsRealFor,
} from "../src/tests-real.js";
import { workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

const kinds = (path: string, before: string | null, after: string, sources: string[] = []) =>
  selfProvingTests(path, before, after, sources).map((f) => f.kind);

const T = "test/parse.test.ts";

describe("tautologies", () => {
  it("finds a value compared with itself, in every assertion dialect", () => {
    const src = [
      'it("a", () => { assert.equal(parse("1"), parse("1")); });',
      'it("b", () => { assert.deepStrictEqual( f(x) ,f(x) ); });',
      'it("c", () => { expect(total(items)).toBe(total(items)); });',
      'it("d", () => { expect(v).toEqual(v); });',
      'it("e", (t) => { t.is(g(), g()); });',
    ].join("\n");
    assert.deepEqual(
      tautologiesIn(src).map((t) => t.line),
      [1, 2, 3, 4, 5],
    );
  });

  it("leaves real comparisons alone", () => {
    const src = [
      'assert.equal(parse("1"), 1);',
      "assert.notEqual(id(), id());", // uniqueness: legitimately the same expression twice
      "assert.deepEqual(a, b);",
      "expect(x).not.toBe(x);",
      'assert.equal(f("(", ")"), f("(", "]"));',
      "assert.equal(f(1), f(2));",
    ].join("\n");
    assert.deepEqual(tautologiesIn(src), []);
  });

  it("judges only tautologies this turn added", () => {
    const old = 'it("old", () => { assert.equal(f(1), f(1)); });\n';
    assert.deepEqual(kinds(T, old, old), [], "an existing one is not this turn's");
    assert.deepEqual(
      kinds(T, old, old + 'it("new", () => { assert.equal(g(1), g(1)); });\n'),
      ["tautology"],
    );
    // The same tautology twice, where there was one before, is one new one.
    assert.deepEqual(kinds(T, old, old + old.replace('"old"', '"again"')), ["tautology"]);
  });
});

describe("assertion-free tests", () => {
  it("finds a new test that only executes the code", () => {
    const src = 'it("handles the empty case", () => {\n  parse("");\n});\n';
    const found = selfProvingTests(T, null, src, []);
    assert.deepEqual(found.map((f) => [f.kind, f.what, f.line]), [
      ["assertion-free", "handles the empty case", 1],
    ]);
  });

  it("counts a helper in the same file that asserts, even through a typed parameter", () => {
    // The shape of test/tui.test.ts's `until`: the first brace after the name
    // is a parameter's type, not the body.
    const src = [
      "async function until(t: { stdout: { lastFrame: string } }, want: RegExp): Promise<void> {",
      "  if (want.test(t.stdout.lastFrame)) return;",
      "  assert.fail(`never saw ${want}`);",
      "}",
      "const settle = async (t: { x: number }) => { await until(t as never, /ok/); };",
      'it("renders", async () => { const t = await mount(); await settle(t); });',
    ].join("\n");
    assert.deepEqual(kinds(T, null, src), []);
  });

  it("counts helpers named for asserting, throws, and every common runner's assertions", () => {
    const src = [
      'it("a", () => { assertParses("x"); });',
      'it("b", () => { util.assertEqual<A, Record<string, B>>(true); });',
      'it("c", () => { if (!ok()) throw new Error("no"); });',
      'test("d", (t) => { t.strictEqual(f(), 1); });',
      'test("e", async () => { await expect(p).rejects.toThrow(); });',
      'it("f", () => { value.should.equal(1); });',
    ].join("\n");
    assert.deepEqual(kinds(T, null, src), []);
  });

  it("does not judge what is not a test yet, or a test that already existed", () => {
    const src = [
      'it.todo("later");',
      'it.skip("not now", () => { run(); });',
      'xit("off", () => { run(); });',
      'it("pending");',
      'it("opted out", { skip: true }, () => { run(); });',
    ].join("\n");
    assert.deepEqual(kinds(T, null, src), []);
    const old = 'it("smoke", () => { boot(); });\n';
    assert.deepEqual(kinds(T, old, old), []);
  });

  it("reads through strings, comments and regex literals holding brackets", () => {
    const src = [
      'it("a", () => {',
      '  const s = "(" + `${f("}")}` + \'{\'; // ) }',
      "  /* ( */ const r = /\\(|\\}/;",
      "  run(s, r);",
      "});",
      'it("b", () => { assert.match(x, /\\)/); });',
    ].join("\n");
    const blocks = testBlocksIn(src);
    assert.deepEqual(
      blocks.map((b) => b.name),
      ["a", "b"],
    );
    assert.deepEqual(kinds(T, null, src), ["assertion-free"], "only `a` asserts nothing");
    assert.equal(closeOf("f(/)/)", 1), 6);
  });
});

describe("a new test file that never touches the change", () => {
  const body = 'import assert from "node:assert";\nit("x", () => { assert.equal(1 + 1, 2); });\n';

  it("is found when it imports none of the changed sources", () => {
    assert.deepEqual(
      kinds("test/parse.test.ts", null, `import { other } from "../src/other.js";\n${body}`, ["src/parse.ts"]),
      ["unlinked-file"],
    );
  });

  it("is linked by any relative spelling of the import", () => {
    for (const spec of ["../src/parse.js", "../src/parse", "../src/parse.ts", "../src/parse/index.js"]) {
      const src = `import { parse } from "${spec}";\n${body}`;
      const sources = spec.includes("index") ? ["src/parse/index.ts"] : ["src/parse.ts"];
      assert.deepEqual(kinds("test/parse.test.ts", null, src, sources), [], spec);
    }
  });

  it("is linked when it runs the changed code by path, as a CLI test does", () => {
    const src = `const r = spawnSync("node", ["dist/cli.js", "--help"]);\n${body}`;
    assert.deepEqual(kinds("test/cli-help.test.ts", null, src, ["src/cli.tsx"]), []);
  });

  it("has nothing to link to when the turn changed no code, or the file already existed", () => {
    assert.deepEqual(kinds("test/a.test.ts", null, body, ["README.md", "docs/x.md"]), []);
    assert.deepEqual(kinds("test/a.test.ts", body, body + "\n", ["src/parse.ts"]), []);
  });
});

describe("tests-real, as the bar runs it", () => {
  function project() {
    const w = workspace();
    cleanups.push(w.cleanup);
    mkdirSync(join(w.dir, "src"));
    mkdirSync(join(w.dir, "test"));
    writeFileSync(join(w.dir, "src/parse.ts"), "export const parse = (s: string) => Number(s);\n");
    writeFileSync(
      join(w.dir, "test/parse.test.ts"),
      'import { parse } from "../src/parse.js";\nit("parses", () => { assert.equal(parse("1"), 1); });\n',
    );
    return w.dir;
  }

  it("refuses a turn whose added test compares the function with itself", () => {
    const dir = project();
    const treeBefore = snapshotTree(dir);
    writeFileSync(join(dir, "src/parse.ts"), "export const parse = (s: string) => Number(s.trim());\n");
    writeFileSync(
      join(dir, "test/parse.test.ts"),
      readFileSync(join(dir, "test/parse.test.ts"), "utf8") +
        'it("trims", () => { assert.equal(parse(" 1 "), parse(" 1 ")); });\n',
    );
    const r = testsRealFor({
      cwd: dir,
      ledger: [{ path: "src/parse.ts" }, { path: "test/parse.test.ts" }],
      treeBefore,
    });
    assert.equal(r.ok, false);
    assert.match(r.output, /test\/parse\.test\.ts:3/);
    assert.match(r.output, /compares a value with itself/);
  });

  it("passes a turn whose added test asserts a written-out value", () => {
    const dir = project();
    const treeBefore = snapshotTree(dir);
    writeFileSync(
      join(dir, "test/parse.test.ts"),
      readFileSync(join(dir, "test/parse.test.ts"), "utf8") +
        'it("trims", () => { assert.equal(parse(" 1 "), 1); });\n',
    );
    const r = testsRealFor({ cwd: dir, ledger: [{ path: "test/parse.test.ts" }], treeBefore });
    assert.equal(r.ok, true);
    assert.notEqual(r.established, false);
  });

  it("establishes nothing when no test was written, and says so", () => {
    const dir = project();
    const r = testsRealFor({ cwd: dir, ledger: [{ path: "src/parse.ts" }], treeBefore: snapshotTree(dir) });
    assert.equal(r.ok, true);
    assert.equal(r.established, false);
  });

  it("does not pass a file it could not see before as examined", () => {
    const dir = project();
    const truncated = { ...snapshotTree(dir), truncated: true };
    const r = testsRealFor({ cwd: dir, ledger: [{ path: "test/parse.test.ts" }], treeBefore: truncated });
    assert.equal(r.ok, true);
    assert.equal(r.established, false);
    assert.match(r.output, /not examined: test\/parse\.test\.ts/);
  });

  it("reads the turn's writes, not the session's", () => {
    const dir = project();
    const treeBefore = snapshotTree(dir);
    const r = testsRealFor({
      cwd: dir,
      ledger: [{ path: "test/parse.test.ts" }],
      turnLedger: [],
      treeBefore,
    });
    assert.equal(r.established, false, "an earlier turn's test file is not this turn's");
  });
});

describe("on this repository's own suite", () => {
  it("finds nothing to refuse in 1,200-odd real tests but the one tautology it has", () => {
    // Every test here judged as if a turn had just added it. The single hit
    // is real: commands.test.ts's "is stable between keystrokes" compares
    // `names(q)` with `names(q)`, which a deterministic function passes
    // whatever it returns.
    const found: string[] = [];
    let judged = 0;
    for (const f of readdirSync("test")) {
      if (!f.endsWith(".ts")) continue;
      const text = readFileSync(join("test", f), "utf8");
      judged += testBlocksIn(text).filter((b) => b.judged).length;
      for (const x of selfProvingTests(`test/${f}`, null, text, [])) found.push(`${x.kind} ${f}:${x.line}`);
    }
    assert.ok(judged > 1000, `only ${judged} tests were read — the parser is missing them`);
    assert.deepEqual(
      found.filter((x) => !x.startsWith("tautology commands.test.ts")),
      [],
    );
  });
});
