/**
 * Asking whether anything executes the code a turn added.
 *
 * The gap the other builtins leave. `files-changed` proves a file moved;
 * `substance` proves the movement was not only comments. Neither can tell
 * whether the new code does anything.
 *
 * The change that motivated this passed six checks — types, tests, both app
 * checks, record-intact and work-landed — and was caught by a person reading
 * the diff:
 *
 *     export const MAX_COMMAND_LENGTH = 16384;           // referenced nowhere
 *     if (path.length > MAX_PATH_LENGTH) return false;   // branch never taken
 *
 * Reading diffs by hand does not scale, and is the job molt exists to replace.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseLcov, coverageFor, unprovenIn, normalise } from "../src/coverage.js";

const LCOV = `TN:
SF:dist/src/files.js
DA:10,5
DA:11,0
DA:12,3
BRDA:12,0,0,4
BRDA:12,0,1,0
BRDA:14,1,0,2
DA:14,2
end_of_record
TN:
SF:dist/src/other.js
DA:1,1
end_of_record
`;

describe("reading lcov", () => {
  it("takes line and branch counts per file", () => {
    const cov = parseLcov(LCOV);
    assert.equal(cov.size, 2);
    const f = cov.get("dist/src/files.js")!;
    assert.equal(f.lines.get(10), 5);
    assert.equal(f.lines.get(11), 0);
    assert.deepEqual(f.branches.get(12), [4, 0]);
  });

  it("treats an unreached branch, written as '-', as zero", () => {
    const cov = parseLcov("SF:a/b.js\nBRDA:3,0,0,-\nend_of_record\n");
    assert.deepEqual(cov.get("a/b.js")!.branches.get(3), [0]);
  });

  it("skips records it does not know rather than throwing", () => {
    // A coverage tool gaining a record type must not break a build.
    const cov = parseLcov("SF:a/b.js\nWHAT:1,2\nDA:1,1\nend_of_record\n");
    assert.equal(cov.get("a/b.js")!.lines.get(1), 1);
  });

  it("survives an empty or malformed report", () => {
    assert.equal(parseLcov("").size, 0);
    assert.equal(parseLcov("DA:1,1\n").size, 0, "records before any SF belong to no file");
  });
});

describe("matching a project path to a coverage path", () => {
  it("matches through a build directory", () => {
    // Coverage is reported against whatever ran — usually compiled output.
    // Requiring equality would make this check impossible on any project with
    // a build step, which is most of them.
    const cov = parseLcov(LCOV);
    assert.ok(coverageFor(cov, "src/files.ts".replace(".ts", ".js")));
    assert.ok(coverageFor(cov, "src/files.js"));
  });

  it("refuses a match on the filename alone", () => {
    // `files.js` in two different directories is a collision, not a match, and
    // reporting one file's coverage for another would be worse than silence.
    const cov = parseLcov("SF:vendor/deep/nested/files.js\nDA:1,1\nend_of_record\n");
    assert.equal(coverageFor(cov, "files.js"), null);
  });

  it("normalises separators and a leading ./", () => {
    assert.equal(normalise(String.raw`./src\a.ts`), "src/a.ts");
  });
});

describe("what counts as unproven", () => {
  it("flags a changed line the tests never executed", () => {
    const cov = parseLcov(LCOV);
    const bad = unprovenIn(cov, "src/files.js", [11]);
    assert.deepEqual(bad?.deadLines, [11]);
  });

  it("flags a line that ran but whose branch never went one way", () => {
    // This is the guard that returns false and is never tripped. Line coverage
    // alone calls it covered — the `if` executed. Only the branch count says
    // the behaviour was never shown.
    const cov = parseLcov(LCOV);
    const bad = unprovenIn(cov, "src/files.js", [12]);
    assert.deepEqual(bad?.deadBranches, [12]);
    assert.deepEqual(bad?.deadLines, []);
  });

  it("accepts a line that ran with every branch taken", () => {
    const cov = parseLcov(LCOV);
    assert.equal(unprovenIn(cov, "src/files.js", [10, 14]), null);
  });

  it("says nothing about a line the tool never instrumented", () => {
    // lcov lists only what the tool considers executable, so a type, an
    // import or a declaration is simply absent. Silence means "not
    // instrumented", not "not run", and failing on it would refuse honest work.
    const cov = parseLcov(LCOV);
    assert.equal(unprovenIn(cov, "src/files.js", [99]), null);
  });

  it("says nothing about a file absent from the report", () => {
    const cov = parseLcov(LCOV);
    assert.equal(unprovenIn(cov, "ui/styles.css", [1, 2, 3]), null);
  });
});
