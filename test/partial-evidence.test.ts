/**
 * An exit code is the command's account of itself, and a bar that was only
 * partly asked is not a bar.
 *
 * Three failures from the field, each of which a green exit code hid:
 *
 *  - A reviewer was told "accept as-is" after five of nineteen concerns had
 *    been checked. `molt run --skip slow` did the same thing in miniature:
 *    the deselected checks vanished from the result, "7 of 7 checks passed"
 *    was printed for a bar of twelve, and the receipt said accepted.
 *  - `node --test` over a glob that matched nothing exits 0. So does
 *    `vitest --passWithNoTests`, and `go test` in a package with no tests.
 *    A suite that executed nothing was recorded as a green suite.
 *  - `npm test | tee log` exits with tee's status, and `npm test || true`
 *    cannot fail at all. The runner printed "3 failed" and the check passed.
 *
 * And a receipt that could not say which tree it judged: a summary written
 * hours later ("still active", "done") had nothing to be checked against.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { parseBar, runBar, selectChecks } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { judgePass, pipesWithoutPipefail, readSummary, runnerPipedAway, swallowsExit } from "../src/evidence.js";
import { Receipts } from "../src/receipts.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

const ctx = (cwd: string) => ({ cwd, record: [], read: [], ledger: [], archivedBatches: 0 });

describe("reading the runner's own summary", () => {
  it("reads node:test's spec and TAP totals, taking the LAST summary (a nested run prints its own)", () => {
    const nested = "ℹ tests 0\nℹ fail 0\n" + "✔ outer test\n" + "ℹ tests 12\nℹ pass 12\nℹ fail 0\n";
    assert.deepEqual(readSummary(nested), { runner: "node:test", total: 12, failed: 0 });
    assert.deepEqual(readSummary("1..0\n# tests 0\n# pass 0\n# fail 0\n"), {
      runner: "node:test",
      total: 0,
      failed: 0,
    });
  });

  it("strips colour before reading, or `tests` and its number are split", () => {
    assert.equal(readSummary("\x1b[34mℹ tests 3\x1b[39m\n\x1b[34mℹ fail 1\x1b[39m\n")?.failed, 1);
  });

  it("reads jest, vitest, pytest, cargo, mocha and go", () => {
    assert.deepEqual(readSummary("Tests:       1 failed, 11 passed, 12 total\n"), {
      runner: "jest",
      total: 12,
      failed: 1,
    });
    assert.equal(readSummary("No tests found, exiting with code 0\n")?.total, 0);
    assert.deepEqual(readSummary("      Tests  2 failed | 9 passed (11)\n"), {
      runner: "vitest",
      total: 11,
      failed: 2,
    });
    assert.equal(readSummary("No test files found, exiting with code 0\n")?.total, 0);
    assert.equal(readSummary("collected 0 items\n\n=== no tests ran in 0.01s ===\n")?.total, 0);
    assert.deepEqual(readSummary("===== 2 failed, 10 passed in 0.31s =====\n"), {
      runner: "pytest",
      total: 12,
      failed: 2,
    });
    assert.deepEqual(
      readSummary("running 0 tests\ntest result: ok. 0 passed; 0 failed; 0 ignored\n"),
      { runner: "cargo", total: 0, failed: 0 },
    );
    assert.deepEqual(readSummary("  12 passing (40ms)\n  1 failing\n"), {
      runner: "mocha",
      total: 13,
      failed: 1,
    });
    assert.equal(readSummary("?   \texample.com/x\t[no test files]\n")?.total, 0);
    assert.equal(readSummary("ok  \texample.com/x\t0.012s\n")?.total, undefined, "ran, count unknown");
  });

  it("concludes nothing from output it does not recognise", () => {
    assert.equal(readSummary("Found 0 errors. Watching for file changes.\n"), null);
    assert.equal(readSummary(""), null);
    assert.deepEqual(judgePass("tsc --noEmit", ""), { ok: true, summary: null });
  });
});

describe("the command's own words", () => {
  it("finds an exit status thrown away at the END of a command only", () => {
    assert.equal(swallowsExit("npm test || true"), "|| true");
    assert.equal(swallowsExit("npm test ; exit 0"), "; exit 0");
    assert.equal(swallowsExit("pytest || :"), "|| :");
    assert.equal(swallowsExit("rm -f out.log || true; npm test"), null, "cleanup first is fine");
  });

  it("tells a pipe from an `||`, and respects pipefail and quoting", () => {
    assert.equal(pipesWithoutPipefail("npm test | tee out.log"), true);
    assert.equal(pipesWithoutPipefail("set -o pipefail; npm test | tee out.log"), false);
    assert.equal(pipesWithoutPipefail("npm test || npm run test:retry"), false);
    assert.equal(pipesWithoutPipefail(`grep -E "a|b" src/x.ts`), false);
  });
});

describe("a runner whose verdict a pipe threw away", () => {
  it("names a known runner that is not the last stage of an unguarded pipe", () => {
    assert.equal(runnerPipedAway("node --test --test-reporter=tap x.test.mjs | tail -3"),
      "node --test --test-reporter=tap x.test.mjs");
    assert.equal(runnerPipedAway("npm test 2>&1 | tee out.log"), "npm test 2>&1");
    assert.equal(runnerPipedAway("cd pkg && CI=1 npx vitest run | cat"), "CI=1 npx vitest run");
    assert.equal(runnerPipedAway("set -o pipefail; npm test | tee log"), null, "pipefail keeps it");
    assert.equal(runnerPipedAway("grep -c TODO src/*.ts | wc -l"), null, "not a runner");
    assert.equal(runnerPipedAway("echo x | npm test"), null, "the runner is the last stage");
    assert.equal(runnerPipedAway(`grep -E "npm test|jest" ci.yml`), null, "a pipe inside quotes");
  });

  it("refuses the measured case: a failing node suite piped through tail passed", async () => {
    // The exact shape found by trying it: `| tail -3` keeps TAP's last three
    // lines, which do not include `# fail 1`, and exits 0.
    const dir = ws();
    writeFileSync(
      join(dir, "bad.test.mjs"),
      'import t from "node:test"; import a from "node:assert"; t("x", () => a.equal(1, 2));\n',
    );
    const bar = parseBar(`
version: 1
checks:
  - name: piped
    run: node --test --test-reporter=tap bad.test.mjs | tail -3
`)!;
    const r = (await runBar(bar, ctx(dir))).results[0]!;
    assert.equal(r.exitCode, 0, "the shell really did say 0");
    assert.equal(r.ok, false);
    assert.equal(r.didNotRun, true);
    assert.match(r.output, /pipefail/);
  });
});

describe("an exit 0 that established nothing is not a pass", () => {
  it("refuses a suite that ran zero tests", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: tests
    run: "printf 'ℹ tests 0\\nℹ pass 0\\nℹ fail 0\\n'"
`)!;
    const result = await runBar(bar, ctx(dir));
    const r = result.results[0]!;
    assert.equal(r.ok, false, "zero tests is not a green suite");
    assert.equal(result.ok, false);
    assert.match(r.output, /ran zero tests/);
    assert.equal(r.didNotRun, undefined, "the model can act on this one — the tests may be its doing");
  });

  it("lets a project say a suite may be empty, and only that", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: tests
    run: "printf 'ℹ tests 0\\nℹ fail 0\\n'"
    empty: allow
  - name: red
    run: "printf 'ℹ tests 4\\nℹ fail 1\\n'"
    empty: allow
`)!;
    const result = await runBar(bar, ctx(dir));
    assert.equal(result.results[0]!.ok, true, "empty: allow excuses an empty suite");
    assert.equal(result.results[1]!.ok, false, "and never a reported failure");
  });

  it("refuses a pass whose runner reported failures, and names the pipe", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: tests
    run: "printf 'ℹ tests 5\\nℹ fail 3\\n' | cat"
`)!;
    const r = (await runBar(bar, ctx(dir))).results[0]!;
    assert.equal(r.ok, false);
    assert.match(r.output, /reported 3 failed tests/);
    assert.match(r.output, /pipefail/);
    assert.equal(r.didNotRun, true, "the check is broken; no change to the work repairs it");
  });

  it("refuses a check that cannot fail, unless the runner itself says it passed", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: blind
    run: "false || true"
  - name: sighted
    run: "printf 'ℹ tests 3\\nℹ fail 0\\n' || true"
`)!;
    const result = await runBar(bar, ctx(dir));
    assert.equal(result.results[0]!.ok, false);
    assert.match(result.results[0]!.output, /exits 0 whatever happened/);
    assert.equal(result.results[1]!.ok, true, "the runner's own summary is evidence");
  });

  it("leaves a real green suite, and a check that expects failure, alone", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: tests
    run: "printf 'ℹ tests 7\\nℹ pass 7\\nℹ fail 0\\n'"
  - name: must-reject
    run: "printf 'ℹ tests 0\\n'; exit 3"
    expect_exit: 3
`)!;
    const result = await runBar(bar, ctx(dir));
    assert.equal(result.ok, true);
  });

  it("parses `empty` strictly on a command check", () => {
    assert.throws(
      () => parseBar(`version: 1\nchecks:\n  - name: t\n    run: "true"\n    empty: yes-please\n`),
      /takes "allow" or "refuse"/,
    );
  });
});

describe("a bar that was only partly asked", () => {
  const TWELVE = `
version: 1
checks:
  - name: fast
    run: "true"
    tags: [fast]
  - name: suite
    run: "true"
    tags: [slow]
  - name: landed
    builtin: files-changed
    tags: [session]
`;

  it("keeps what a tag selection left out, instead of forgetting it", () => {
    const bar = selectChecks(parseBar(TWELVE)!, { skip: ["slow"] });
    assert.deepEqual(bar.checks.map((c) => c.name), ["fast", "landed"]);
    assert.deepEqual(bar.deselected?.map((c) => c.name), ["suite"]);
  });

  it("is undetermined, not met, when a required check was skipped", async () => {
    const dir = ws();
    const bar = selectChecks(parseBar(TWELVE)!, { skip: ["slow", "session"] });
    const result = await runBar(bar, ctx(dir));
    assert.equal(result.ok, false, "a partial bar is not a bar");
    assert.deepEqual(result.undetermined, ["suite", "landed"]);
    const suite = result.results.find((r) => r.name === "suite")!;
    assert.equal(suite.ok, false);
    assert.match(suite.skipped ?? "", /tag selection/);
    assert.equal(result.results.length, 3, "every check in done.yml appears in the result");
  });

  it("calls a session builtin in a standalone prove not applicable rather than unasked", async () => {
    const dir = ws();
    const bar = selectChecks(parseBar(TWELVE)!, { skip: ["session"] });
    const result = await runBar(bar, { ...ctx(dir), standalone: true });
    assert.equal(result.ok, true, "`molt prove --skip session` keeps working");
    const landed = result.results.find((r) => r.name === "landed")!;
    assert.equal(landed.established, false, "and never presents that as having proven anything");
    assert.match(landed.skipped ?? "", /not applicable/);
  });

  it("still calls a skipped COMMAND check unasked in a standalone prove", async () => {
    const dir = ws();
    const bar = selectChecks(parseBar(TWELVE)!, { skip: ["slow", "session"] });
    const result = await runBar(bar, { ...ctx(dir), standalone: true });
    assert.deepEqual(result.undetermined, ["suite"]);
  });

  it("ends the turn undetermined: no accepted receipt, no spent attempts, work left alone", async () => {
    const dir = ws();
    const provider = scriptedProvider([
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "hello\n" } }] },
      { text: "Done: wrote a.txt." },
    ]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: selectChecks(parseBar(TWELVE)!, { skip: ["slow"] }),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 4,
    });
    const events = await drain(engine.run("write a.txt", allowAll));
    const receipts = readdirSync(join(dir, ".molt", "receipts")).filter((f) => f.endsWith(".md"));
    assert.deepEqual(receipts, ["0000-undetermined.md"], "one attempt, and not called accepted");
    const body = readFileSync(join(dir, ".molt", "receipts", receipts[0]!), "utf8");
    assert.match(body, /\| suite \| \*\*not run\*\* \|/);
    assert.equal(provider.calls, 2, "no retry was spent on a check the model cannot run");
    assert.ok(events.some((e) => e.kind === "error" && /undetermined/.test(e.text)));
    assert.ok(!events.some((e) => e.kind === "proof_result"), "never reported as a met bar");
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "hello\n");
    const row = JSON.parse(readFileSync(join(dir, ".molt", "receipts", "index.jsonl"), "utf8").trim());
    assert.deepEqual(row.notRun, ["suite"]);
    assert.deepEqual(row.failed, [], "an unasked check is not a failed one");
    const stats = new Receipts(dir).stats();
    assert.equal(stats.undetermined, 1);
    assert.equal(stats.falseClaimRate, 0, "and it never counts as a false claim");
  });
});

describe("a receipt names the tree it judged", () => {
  it("records HEAD, and says when the tree differed from it", async () => {
    const dir = ws();
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "seed");
    const sha = git("rev-parse", "HEAD");
    writeFileSync(join(dir, "seed.txt"), "x\n");
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "hello\n" } }] },
        { text: "Done." },
      ]).fetchFn,
      bar: parseBar(`version: 1\nchecks:\n  - name: ok\n    run: "true"\n`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
    });
    await drain(engine.run("write a.txt", allowAll));
    const [file] = readdirSync(join(dir, ".molt", "receipts")).filter((f) => f.endsWith(".md"));
    const body = readFileSync(join(dir, ".molt", "receipts", file!), "utf8");
    assert.match(body, new RegExp(`judged tree: ${sha} \\+ uncommitted changes`));
    const row = JSON.parse(readFileSync(join(dir, ".molt", "receipts", "index.jsonl"), "utf8").trim());
    assert.equal(row.head, sha);
    assert.equal(row.dirty, true);
  });

  it("says plainly when there is no commit to name", async () => {
    const dir = ws();
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "hi\n" } }] },
        { text: "Done." },
      ]).fetchFn,
      bar: parseBar(`version: 1\nchecks:\n  - name: ok\n    run: "true"\n`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
    });
    await drain(engine.run("write a.txt", allowAll));
    const [file] = readdirSync(join(dir, ".molt", "receipts")).filter((f) => f.endsWith(".md"));
    assert.match(
      readFileSync(join(dir, ".molt", "receipts", file!), "utf8"),
      /judged tree: not a git commit/,
    );
  });
});

describe("the receipt outranks the summary", () => {
  it("tells whether the tree in front of you is the one a verdict judged", async () => {
    const { driftSince, describeDrift } = await import("../src/git.js");
    const dir = ws();
    const git = (...a: string[]) =>
      execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], {
        cwd: dir,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "judged");
    const judged = git("rev-parse", "HEAD");

    let d = await driftSince(dir, judged, false);
    assert.deepEqual(d, { kind: "same", dirtyThen: false, dirtyNow: false });
    assert.match(describeDrift(d), /exactly the commit it judged/);

    writeFileSync(join(dir, "wip.txt"), "x\n");
    d = await driftSince(dir, judged, false);
    assert.match(describeDrift(d), /uncommitted changes now/);

    git("add", "wip.txt");
    git("commit", "-q", "-m", "later");
    git("commit", "-q", "--allow-empty", "-m", "later still");
    d = await driftSince(dir, judged, false);
    assert.deepEqual(d, { kind: "ahead", commits: 2, dirtyNow: false });
    assert.match(describeDrift(d), /moved 2 commits past/);

    git("checkout", "-q", "--orphan", "other");
    git("commit", "-q", "--allow-empty", "-m", "unrelated");
    d = await driftSince(dir, judged, false);
    assert.equal(d.kind, "elsewhere");
    assert.match(describeDrift(d), /does not describe this tree/);

    d = await driftSince(dir, "0".repeat(40), false);
    assert.equal(d.kind, "unknown");
  });

  it("ignores molt's own writes when deciding a tree is dirty", async () => {
    const { treeState } = await import("../src/git.js");
    const dir = ws();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "s"], {
      cwd: dir,
    });
    new Receipts(dir); // creates .molt/receipts
    writeFileSync(join(dir, ".molt", "note.json"), "{}\n");
    assert.equal((await treeState(dir))?.dirty, false, "every judged tree would read dirty otherwise");
  });
});

describe("a criterion that passed before the work", () => {
  it("is shown as a guard holding, never as proof the task was done", async () => {
    const dir = ws();
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "done.txt", content: "yes\n" } }] },
        { text: "Done: wrote done.txt." },
      ]).fetchFn,
      bar: parseBar(`version: 1\nchecks:\n  - name: ok\n    run: "true"\n`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
    });
    await drain(
      engine.run("create done.txt", allowAll, {
        taskChecks: [
          // Fails on the untouched tree, passes after: this one discriminates.
          { name: "made", kind: "command", run: "test -f done.txt", timeoutMs: 10_000, expectExit: 0, tags: ["task"] },
          // Passes either way: it cannot tell done from not done.
          { name: "guard", kind: "command", run: "true", timeoutMs: 10_000, expectExit: 0, tags: ["task"] },
        ],
      }),
    );
    const [file] = readdirSync(join(dir, ".molt", "receipts")).filter((f) => f.endsWith(".md"));
    assert.match(file!, /accepted/, "a guard is not a reason to refuse — a person sealed it");
    const body = readFileSync(join(dir, ".molt", "receipts", file!), "utf8");
    assert.match(body, /\| task:guard \| pass \(nothing to establish\) \| passed before the work began/);
    assert.match(body, /\| task:made \| pass \|/, "the criterion that discriminated is proof");
  });
});
