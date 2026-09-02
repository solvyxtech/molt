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
import { assertionsIn, isTestPath, removedAssertions } from "../src/files.js";
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
