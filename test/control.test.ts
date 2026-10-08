/**
 * What of a passing check the worker controlled (src/control.ts), and what
 * the tier rule does with it (src/tiers.ts `discounted`).
 */
import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { discountedChecks, pathWords, plantedBins, suppliesOwnInput, visibleInputs } from "../src/control.js";
import { snapshotTree } from "../src/files.js";
import { tierOf } from "../src/tiers.js";
import type { CheckAuthor, CheckResult } from "../src/types.js";
import { workspace } from "./helpers.js";

const pass = (name: string, detail: string, extra: Partial<CheckResult> = {}): CheckResult =>
  ({ name, kind: "command", detail, ok: true, output: "", durationMs: 1, ...extra }) as CheckResult;
const judge: CheckAuthor = { kind: "judge", model: "judge-j" };

/** A project with data.txt and count.py, its tree snapshotted, then `work` applied. */
function turn(work: (dir: string) => void, setup: (dir: string) => void = () => {}) {
  const w = workspace();
  writeFileSync(join(w.dir, "data.txt"), "ERROR a\nok\n");
  writeFileSync(join(w.dir, "count.py"), "print(0)\n");
  setup(w.dir);
  const before = snapshotTree(w.dir);
  work(w.dir);
  return { dir: w.dir, before, cleanup: w.cleanup };
}

describe("reading a command", () => {
  it("finds the paths it names, inside quoted programs too", () => {
    assert.deepEqual(pathWords(`test "$(python3 count.py data.txt)" = "3"`).sort(), ["count.py", "data.txt"]);
    assert.ok(pathWords(`python3 -c "print(open('in/x.csv').read())"`).includes("in/x.csv"));
    assert.ok(pathWords(`diff "$d/out" ./expected.txt`).includes("expected.txt"));
  });

  it("knows a command that makes its own input from one that only reads files", () => {
    assert.equal(suppliesOwnInput(`d=$(mktemp -d) && printf 'ERROR a\\n' > "$d/x" && python3 count.py "$d/x"`), true);
    assert.equal(suppliesOwnInput(`python3 count.py <<'EOF'\nERROR\nEOF`), true);
    assert.equal(suppliesOwnInput(`test "$(python3 count.py data.txt)" = "3"`), false);
  });
});

describe("inputs in plain view", () => {
  it("is a data file that predates the turn and was not changed, never the code it runs", () => {
    const t = turn((d) => writeFileSync(join(d, "count.py"), "print(1)\n"));
    try {
      const touched = new Set(["count.py"]);
      assert.deepEqual(visibleInputs(`test "$(python3 count.py data.txt)" = "3"`, t.dir, touched, t.before), ["data.txt"]);
      assert.deepEqual(visibleInputs(`printf 'x\\n' | python3 count.py data.txt`, t.dir, touched, t.before), [], "it brings an input of its own");
      assert.deepEqual(visibleInputs(`[ "$(python3 count.py made.txt)" = "1" ]`, t.dir, touched, t.before), [], "made.txt did not exist at the start");
    } finally {
      t.cleanup();
    }
  });

  it("discounts a judge's check whose only input the worker could read, never a person's or the worker's own", () => {
    const t = turn((d) => writeFileSync(join(d, "count.py"), "print(1)\n"));
    try {
      const run = `test "$(python3 count.py data.txt)" = "1"`;
      const results = [pass("task:j", run, { hidden: true }), pass("task:w", run, { hidden: true }), pass("tests", run)];
      const authors = new Map<string, CheckAuthor>([["task:j", judge], ["task:w", { kind: "worker", model: "m" }], ["tests", { kind: "person" }]]);
      const d = discountedChecks(results, { cwd: t.dir, before: t.before, written: ["count.py"], authors });
      assert.deepEqual([...d.keys()], ["task:j"]);
      assert.match(d.get("task:j")!, /its only input was data\.txt/);
    } finally {
      t.cleanup();
    }
  });
});

describe("a shadowed runner", () => {
  it("a conftest.py the worker created discounts the pytest check, not an unrelated one", () => {
    const t = turn((d) => writeFileSync(join(d, "conftest.py"), "x = 1\n"));
    try {
      const d = discountedChecks([pass("tests", "python3 -m pytest -q"), pass("lint", "python3 -m pyflakes count.py")], {
        cwd: t.dir,
        before: t.before,
        written: [],
      });
      assert.deepEqual([...d.keys()], ["tests"]);
      assert.match(d.get("tests")!, /conftest\.py is a pytest plugin.*created it this turn/);
    } finally {
      t.cleanup();
    }
  });

  it("a conftest.py that was already there and left alone is the project's, not the worker's", () => {
    const t = turn(() => {}, (d) => writeFileSync(join(d, "conftest.py"), "x = 1\n"));
    try {
      assert.equal(discountedChecks([pass("tests", "python3 -m pytest -q")], { cwd: t.dir, before: t.before, written: [] }).size, 0);
    } finally {
      t.cleanup();
    }
  });

  it("a module named after the one run with -m shadows it", () => {
    const t = turn((d) => writeFileSync(join(d, "unittest.py"), "raise SystemExit(0)\n"));
    try {
      const d = discountedChecks([pass("tests", "python3 -m unittest -q test_count")], { cwd: t.dir, before: t.before, written: ["unittest.py"] });
      assert.match(d.get("tests")!, /shadows the `unittest` module/);
    } finally {
      t.cleanup();
    }
  });

  it("a node_modules/.bin entry planted this turn shadows npm's scripts; a package's own link does not", () => {
    const t = turn(() => {});
    try {
      const bin = join(t.dir, "node_modules", ".bin");
      mkdirSync(join(t.dir, "node_modules", "pkg"), { recursive: true });
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(t.dir, "node_modules", "pkg", "cli.js"), "");
      symlinkSync("../pkg/cli.js", join(bin, "pkg-cli-for-tests"));
      assert.deepEqual(plantedBins(t.dir, t.before.takenAt), [], "an install's link into node_modules");
      writeFileSync(join(bin, "node"), "#!/bin/sh\nexit 0\n");
      assert.deepEqual(plantedBins(t.dir, t.before.takenAt), ["node_modules/.bin/node"]);
      const d = discountedChecks([pass("tests", "npm test --silent"), pass("py", "python3 count.py")], { cwd: t.dir, before: t.before, written: [] });
      assert.deepEqual([...d.keys()], ["tests"]);
    } finally {
      t.cleanup();
    }
  });
});

describe("an expected value the worker wrote", () => {
  it("discounts a diff against an expected file the worker created, whoever wrote the check", () => {
    const t = turn((d) => writeFileSync(join(d, "expected.txt"), "1\n"));
    try {
      const run = `d=$(mktemp -d) && python3 count.py data.txt > "$d/out" && diff "$d/out" expected.txt`;
      const d = discountedChecks([pass("tests", run)], { cwd: t.dir, before: t.before, written: ["expected.txt"] });
      assert.match(d.get("tests")!, /compares against expected\.txt, which the worker created this turn/);
    } finally {
      t.cleanup();
    }
  });

  it("leaves a diff against an expected file the worker did not touch", () => {
    const t = turn(() => {}, (d) => writeFileSync(join(d, "expected.txt"), "1\n"));
    try {
      const run = `python3 count.py data.txt | diff - expected.txt`;
      assert.equal(discountedChecks([pass("tests", run)], { cwd: t.dir, before: t.before, written: [] }).size, 0);
    } finally {
      t.cleanup();
    }
  });
});

describe("the tier rule with discounted checks", () => {
  const value = { hidden: true, tags: ["task", "value"] };

  it("a discounted check is no evidence, and the reason names it", () => {
    const results = [pass("task:j", "x", value)];
    const authors = new Map<string, CheckAuthor>([["task:j", judge]]);
    assert.equal(tierOf({ results, worker: "m", authors }).tier, "verified");
    const t = tierOf({ results, worker: "m", authors, discounted: new Map([["task:j", "its only input was data.txt"]]) });
    assert.equal(t.tier, "passed-checks");
    assert.match(t.reason!, /`task:j` does not count: its only input was data\.txt/);
  });

  it("a subverted person's check voids the rest of the person's bar, but not an independent check", () => {
    const bar = [pass("tests", "python3 -m pytest"), { ...pass("work-landed", "files-changed"), kind: "builtin" as const }];
    const discounted = new Map([["tests", "it passed through conftest.py"]]);
    assert.equal(tierOf({ results: bar, worker: "m" }).tier, "verified");
    assert.equal(tierOf({ results: bar, worker: "m", discounted }).tier, "passed-checks");
    const withJudge = [...bar, pass("task:j", "y", value)];
    const t = tierOf({ results: withJudge, worker: "m", authors: new Map([["task:j", judge]]), discounted });
    assert.deepEqual([t.tier, t.basis], ["verified", "independent"]);
  });
});
