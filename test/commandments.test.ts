/**
 * The commandments: what every run is told, and what is checked rather than
 * asked.
 *
 * Each rule here was bought with a run that went wrong. The point of the file
 * is that none of them is a preference — every one names the failure that
 * produced it, so a later reader can decide whether the failure still exists
 * rather than whether the rule sounds wise.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addedSkips, assertionsIn, isTestPath, removedAssertions, skipsIn, snapshotTree, specWeakened } from "../src/files.js";
import { parseBar, runBar, BUILTINS } from "../src/bar.js";
import { SYSTEM_PROMPT } from "../src/engine.js";
import type { BarContext } from "../src/bar.js";

describe("what counts as a specification", () => {
  it("knows a test file from a source file", () => {
    assert.equal(isTestPath("test/bar.test.ts"), true);
    assert.equal(isTestPath("src/foo.spec.tsx"), true);
    assert.equal(isTestPath("tests/e2e/run.js"), true);
    assert.equal(isTestPath("src/engine.ts"), false);
    assert.equal(isTestPath("src/latest.ts"), false, "'latest' is not 'test/'");
  });

  it("reads assertions and ignores everything around them", () => {
    const text = [
      'it("does the thing", () => {',
      "  // a comment mentioning assert",
      "  const x = compute();",
      "  assert.equal(x, 3);",
      "  expect(x).toBe(3);",
      "});",
    ].join("\n");
    assert.deepEqual(assertionsIn(text), ["assert.equal(x, 3);", "expect(x).toBe(3);"]);
  });

  it("knows each runner's own test-file names, not only test/ folders and *.test.js", () => {
    for (const p of ["test_count.py", "pkg/count_test.py", "conftest.py", "net/dial_test.go", "spec/models/user_spec.rb", "src/__tests__/a.js", "src/FooTest.java"]) {
      assert.equal(isTestPath(p), true, p);
    }
    for (const p of ["count.py", "contest.py", "testing.py", "src/attest.go", "latest_tests_report.md"]) assert.equal(isTestPath(p), false, p);
  });

  it("reads xUnit-style assertion methods as assertions", () => {
    const text = ["        self.assertEqual(out, '3')", "    assertEquals(4, f(2));", "    assert_eq!(x, 2);", "        self.helper(out)"].join("\n");
    assert.deepEqual(assertionsIn(text), ["self.assertEqual(out, '3')", "assertEquals(4, f(2));", "assert_eq!(x, 2);"]);
  });

  it("is not fooled by reindentation", () => {
    assert.deepEqual(removedAssertions("  assert.ok(a);", "        assert.ok(a);"), []);
  });
});

describe("rewriting the specification to agree with the code", () => {
  it("catches the exact inversion a model performed", () => {
    // Observed, not imagined: asked to prove a defect with a failing test, a
    // model opened the test that pinned the existing behaviour and flipped it.
    const before = "    assert.equal(r.ok, true);";
    const after = "    assert.equal(r.ok, false);";
    assert.deepEqual(removedAssertions(before, after), ["assert.equal(r.ok, true);"]);
  });

  it("allows adding assertions freely", () => {
    const before = "assert.ok(a);";
    const after = "assert.ok(a);\nassert.ok(b);\nassert.ok(c);";
    assert.deepEqual(removedAssertions(before, after), []);
  });

  it("does not call moving an assertion a removal", () => {
    const before = "describe('a', () => {\n  assert.ok(x);\n});";
    const after = "describe('b', () => {\n  assert.ok(x);\n});";
    assert.deepEqual(removedAssertions(before, after), []);
  });
});

describe("turning a test off is weakening it", () => {
  it("rewriting an assertion into a tautology removes the one that was there", () => {
    assert.deepEqual(specWeakened("        self.assertEqual(out, '3')", "        self.assertEqual('3', '3')"), ["self.assertEqual(out, '3')"]);
  });

  it("finds the skips each runner knows", () => {
    const lines = [
      "@unittest.skip('flaky')",
      "@pytest.mark.xfail(reason='x')",
      "    pytest.skip('later')",
      "        self.skipTest('no')",
      "it.skip('does a thing', () => {",
      "test.only('just me', () => {",
      "xit('off', () => {",
      "it('opts', { skip: true }, () => {",
      "\tt.Skip(\"slow\")",
      "#[ignore]",
      "@Disabled",
    ];
    assert.equal(skipsIn(lines.join("\n")).length, lines.length);
    assert.deepEqual(skipsIn("# @unittest.skip in a comment\nskip_count = 3\nit('runs', { skip: false }, () => {})\n// it.skip('x')"), []);
  });

  it("an added skip is a weakening; one that was already there, or moved, is not", () => {
    const before = "class T:\n    def test_a(self):\n        self.assertEqual(f(), 3)\n";
    const after = "class T:\n    @unittest.skip('flaky')\n    def test_a(self):\n        self.assertEqual(f(), 3)\n";
    assert.deepEqual(specWeakened(before, after), ["@unittest.skip('flaky')  (turns a test off)"]);
    assert.deepEqual(specWeakened(after, after), []);
    assert.deepEqual(addedSkips(["it.skip('a')"], ["it.skip('a')", "it.skip('a')"]), ["it.skip('a')"], "counted, not deduplicated");
  });

  it("a conditional skip on a test the turn added is free; on an existing test, or unconditional on a renamed one, it is not", () => {
    // A new file: adding tests, skipped where they cannot run, takes nothing away.
    assert.deepEqual(specWeakened("", "@pytest.mark.skipif(sys.platform == 'win32', reason='posix')\ndef test_new():\n    assert f() == 3\n"), []);
    assert.deepEqual(specWeakened("", "it('posix', { skip: process.platform === 'win32' }, () => {\n  assert.equal(f(), 3);\n});\n"), []);
    // A new test in an existing file.
    const js = "it('old', () => {\n  assert.equal(f(), 3);\n});\n";
    assert.deepEqual(specWeakened(js, js + "it('posix', { skip: !hasPython && 'needs python3' }, () => {\n  assert.equal(g(), 4);\n});\n"), []);
    const py = "def test_old():\n    assert f() == 3\n";
    assert.deepEqual(specWeakened(py, py + "@pytest.mark.skipif(sys.platform == 'win32', reason='posix')\ndef test_new():\n    assert g() == 4\n"), []);
    // The same skip on the existing test still counts.
    assert.equal(specWeakened(js, "it('old', { skip: !hasPython }, () => {\n  assert.equal(f(), 3);\n});\n").length, 1);
    // An unconditional skip on a renamed test is the old test turned off.
    assert.equal(specWeakened(py, "@unittest.skip('flaky')\ndef test_old_renamed():\n    assert f() == 3\n").length, 1);
  });
});

describe("spec-intact", () => {
  const bar = parseBar("version: 1\nchecks:\n  - name: spec\n    builtin: spec-intact\n");
  const ctx = (over: Partial<BarContext> = {}): BarContext =>
    ({ cwd: "/tmp", record: [], ledger: [], archivedBatches: 0, ...over }) as BarContext;

  it("is a builtin the bar will accept", () => {
    assert.ok(BUILTINS.includes("spec-intact"));
  });

  it("passes a turn that added tests", async () => {
    const r = await runBar(
      bar,
      ctx({ ledger: [{ path: "test/a.test.ts", before: "x", after: "y", callId: "c1" }] }),
    );
    assert.equal(r.ok, true);
    assert.match(r.results[0].output, /no assertion removed/);
  });

  it("fails a turn that deleted one, and names it", async () => {
    const r = await runBar(
      bar,
      ctx({
        ledger: [
          {
            path: "test/mutate.test.ts",
            before: "x",
            after: "y",
            callId: "c1",
            specRemoved: ["assert.equal(r.ok, true);"],
          },
        ],
      }),
    );
    assert.equal(r.ok, false);
    assert.match(r.results[0].output, /assert\.equal\(r\.ok, true\);/);
    assert.match(r.results[0].output, /decision for a person/);
  });

  it("can be allowed on purpose, and says that it was", async () => {
    const allowed = parseBar(
      "version: 1\nchecks:\n  - name: spec\n    builtin: spec-intact\n    removals: allow\n",
    );
    const r = await runBar(
      allowed,
      ctx({
        ledger: [
          { path: "test/old.test.ts", before: "x", after: "y", callId: "c1", specRemoved: ["assert.ok(gone);"] },
        ],
      }),
    );
    assert.equal(r.ok, true);
    assert.match(r.results[0].output, /allowed by/);
  });

  it("refuses `removals` on a check it does not apply to", () => {
    assert.throws(
      () => parseBar("version: 1\nchecks:\n  - name: x\n    builtin: files-changed\n    removals: allow\n"),
      /only applies to the spec-intact builtin/,
    );
  });
});

describe("the rules every run is told", () => {
  it("carries the two that no check can enforce before the fact", () => {
    // Bought by the qwen3-coder-30b runs (added a test beside the one that
    // contradicted it, four runs running) and by the Mercury bug hunt
    // (inverted an assertion rather than writing a new test).
    assert.match(SYSTEM_PROMPT, /tests that pinned the old behaviour/);
    assert.match(SYSTEM_PROMPT, /not an obstacle to be removed/);
    assert.match(SYSTEM_PROMPT, /decision for a person/);
  });
});

describe("spec-intact on disk", () => {
  const bar = parseBar("version: 1\nchecks:\n  - name: spec\n    builtin: spec-intact\n");

  it("refuses a skip added outside the tools", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spec-skip-"));
    try {
      writeFileSync(join(dir, "test_count.py"), "import unittest\n\nclass T(unittest.TestCase):\n    def test_a(self):\n        self.assertEqual(1, 1)\n");
      const treeBefore = snapshotTree(dir);
      writeFileSync(join(dir, "test_count.py"), "import unittest\n\nclass T(unittest.TestCase):\n    @unittest.skip('flaky')\n    def test_a(self):\n        self.assertEqual(1, 1)\n");
      const r = await runBar(bar, { cwd: dir, record: [], ledger: [], archivedBatches: 0, treeBefore } as unknown as BarContext);
      assert.equal(r.ok, false);
      assert.match(r.results[0]!.output, /test_count\.py: @unittest\.skip\('flaky'\) {2}\(turns a test off\)/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
