/**
 * A check that failed and a check that never ran are not the same fact.
 *
 * This suite exists because of one real session. A local 8B model drafted the
 * criterion `grep -q "database" .molt/done.yml` for a project that had no
 * `.molt/done.yml`. grep exited 2 with `No such file or directory`, the bar
 * printed FAIL beside it like any other failure, and the model — correctly
 * reading FAIL as "there is work to do" — set about creating the file so the
 * error would stop. It burned every attempt satisfying a typo, and the run
 * ended having verified nothing at all while looking exactly like a run that
 * had verified something and found it wanting.
 *
 * The distinction molt owes its user:
 *
 *  - FAIL means the command ran and the work did not satisfy it. Act on it.
 *  - did not run means nothing was established in either direction. There is
 *    no change that fixes it. A human repairs the check.
 *
 * And the one line that must not move: a broken check still blocks. "Nobody
 * can run this check" is not a reason to accept a claim, so `ok` stays false
 * and the completion stays refused. The only thing that changes is what molt
 * says is wrong, and who it asks to fix it.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { diagnoseFailure, formatBarFailure, parseBar, runBar } from "../src/bar.js";
import { preflightCriteria } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { BarResult, CheckResult } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** A command name nothing on any machine will resolve. */
const MISSING = "molt-no-such-command-9f3a2b";

describe("telling a broken command from a failing one", () => {
  it("calls exit 127 what it is: the command was never found", () => {
    const d = diagnoseFailure(127, "", `sh: ${MISSING}: command not found\n`);
    assert.equal(d.didNotRun, true);
    assert.match(d.hint ?? "", /not found/);
  });

  it("calls exit 126 what it is: the command could not be executed", () => {
    const d = diagnoseFailure(126, "", "sh: ./check.sh: Permission denied\n");
    assert.equal(d.didNotRun, true);
    assert.match(d.hint ?? "", /could not be executed/);
  });

  it("hints at the command when it errored instead of reporting, but does not claim certainty", () => {
    // The exact shape of the session that prompted this suite. grep's exit 2
    // is not a reliable "did not run" signal the way 127 is — some tools use
    // 2 for a genuine failure — so this stays a failure and gains a sentence.
    const d = diagnoseFailure(2, "", "grep: .molt/done.yml: No such file or directory\n");
    assert.equal(d.didNotRun, false, "exit 2 is not proof that nothing ran");
    assert.match(d.hint ?? "", /command failing rather than the work/);
    assert.match(d.hint ?? "", /No such file or directory/, "quotes what the command actually said");
    assert.match(d.hint ?? "", /fix the check/);
  });

  it("stays quiet when the command plainly ran", () => {
    // A suite that printed its results and failed. Nothing to diagnose: this
    // is exactly the case where the model should get to work.
    assert.deepEqual(diagnoseFailure(1, "1 failing\n  expected 2 to equal 3\n", ""), {
      didNotRun: false,
    });
    assert.deepEqual(diagnoseFailure(1, "", ""), { didNotRun: false });
  });

  it("does not mistake a suite's own output for a broken command", () => {
    // The false positive that would matter most: a test suite whose failure
    // message legitimately contains the words. It wrote to stdout, so it ran.
    // Written to stderr, which is where suites usually put failures, with a
    // full run's worth of output on stdout. Only the stdout tells them apart:
    // a command that never ran says nothing there.
    const d = diagnoseFailure(
      1,
      "loader.test.ts .....\n42 passing\n1 failing\n",
      "Error: ENOENT: No such file or directory, open 'fixture.json'\n",
    );
    assert.equal(d.didNotRun, false);
    assert.equal(d.hint, undefined, "a suite that reported a real failure gets no lecture");
  });
});

describe("a broken check at the bar", () => {
  it("marks the result as never having run, and still refuses the claim", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: typo
    run: ${MISSING}
    timeout: 10
`)!;
    const result = await runBar(bar, { cwd: dir, record: [], read: [], ledger: [], archivedBatches: 0 });
    const check = result.results.find((r) => r.name === "typo")!;

    assert.equal(check.didNotRun, true, "the exit code said the command was never found");
    assert.equal(check.ok, false, "a check nobody can run is not a check that passed");
    assert.equal(result.ok, false, "and the bar is not met");
    assert.match(check.output, /\[molt\] the command was not found/);
  });

  it("does not mark an ordinary failure as broken", async () => {
    const dir = ws();
    const bar = parseBar(`
version: 1
checks:
  - name: red
    run: "exit 1"
    timeout: 10
`)!;
    const result = await runBar(bar, { cwd: dir, record: [], read: [], ledger: [], archivedBatches: 0 });
    const check = result.results.find((r) => r.name === "red")!;
    assert.equal(check.ok, false);
    assert.equal(check.didNotRun, undefined, "this one ran and returned a verdict");
  });
});

describe("what the model is told", () => {
  const result = (results: Partial<CheckResult>[]): BarResult => ({
    ok: false,
    results: results.map((r) => ({
      name: "x",
      kind: "command" as const,
      detail: "cmd",
      ok: false,
      output: "",
      durationMs: 1,
      ...r,
    })),
    durationMs: 1,
  });

  it("puts a broken check in its own section and tells the model not to satisfy it", () => {
    const text = formatBarFailure(
      result([
        { name: "suite", detail: "npm test", output: "1 failing" },
        { name: "task:db", detail: MISSING, output: "not found", didNotRun: true, exitCode: 127 },
      ]),
      1,
      3,
    );

    assert.match(text, /DID NOT RUN: task:db/);
    assert.doesNotMatch(text, /FAILED: task:db/, "a broken check is not reported as a failure");
    assert.match(text, /FAILED: suite/, "the real failure is still a failure");
    assert.match(text, /no change you can make to satisfy/);
    assert.match(text, /A human has to repair the check/);
  });

  it("still counts it among the checks that did not pass", () => {
    // The count is the honest one: two checks did not pass. Only the reason
    // differs, and hiding the broken one would understate the bar.
    const text = formatBarFailure(
      result([
        { name: "suite", detail: "npm test" },
        { name: "task:db", detail: MISSING, didNotRun: true },
      ]),
      1,
      3,
    );
    assert.match(text, /2 of 2 checks in \.molt\/done\.yml did not pass/);
  });

  it("does not send the model to the project's output when the only failure is broken", () => {
    // "Start with X — that is your project's own output" is advice for
    // choosing between real failures. With nothing real to choose, it would
    // be pointing at a command that does not exist.
    const text = formatBarFailure(
      result([
        { name: "task:db", detail: MISSING, didNotRun: true },
        { name: "work-landed", kind: "builtin", detail: "files-changed" },
      ]),
      1,
      3,
    );
    assert.doesNotMatch(
      text,
      /Start with/,
      "with only a builtin left to act on, there is no command output to start with",
    );
    // And with a real command failure present, the advice names that one only.
    const both = formatBarFailure(
      result([
        { name: "task:db", detail: MISSING, didNotRun: true },
        { name: "suite", detail: "npm test" },
        { name: "work-landed", kind: "builtin", detail: "files-changed" },
      ]),
      1,
      3,
    );
    assert.match(both, /Start with `suite`/);
    assert.doesNotMatch(both, /Start with[^\n]*task:db/, "never sent to a command that does not run");
  });
});

describe("trying the criteria at seal time, before a token is spent", () => {
  it("says so before the first request, and still lets the turn run", async () => {
    // Reported rather than vetoed on purpose: a criterion can be legitimately
    // unrunnable beforehand if the work is what installs the tool it names.
    // The bar has the final say. This is the early warning, and its value is
    // that it arrives before the money.
    const dir = ws();
    const provider = scriptedProvider([{ text: "Done." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar(`
version: 1
checks:
  - name: always
    run: "true"
`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });

    const events = await drain(
      engine.run("add the database layer", allowAll, {
        taskChecks: [
          { name: "db", kind: "command", run: MISSING, timeoutMs: 10_000, expectExit: 0, tags: ["task"] },
        ],
      }),
    );

    const infos = events.filter((e) => e.kind === "info").map((e) => (e as { text: string }).text);
    const warned = infos.findIndex((t) => /did not run when tried before the work/.test(t));
    assert.ok(warned >= 0, `expected a preflight warning, got: ${infos.join(" | ")}`);
    assert.match(infos[warned], /`db`/, "it names the criterion");
    assert.match(infos[warned], /no work will satisfy it/);
    assert.ok(provider.calls >= 1, "and the turn was not blocked");
  });

  it("stays silent when the criteria can run", async () => {
    const dir = ws();
    const provider = scriptedProvider([{ text: "Done." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar(`
version: 1
checks:
  - name: always
    run: "true"
`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });

    const events = await drain(
      engine.run("add the database layer", allowAll, {
        // Exits 1. Failing before the work is what a criterion is for, and
        // saying anything about it here would train people to ignore this.
        taskChecks: [
          { name: "db", kind: "command", run: "exit 1", timeoutMs: 10_000, expectExit: 0, tags: ["task"] },
        ],
      }),
    );

    const infos = events.filter((e) => e.kind === "info").map((e) => (e as { text: string }).text);
    assert.equal(
      infos.filter((t) => /did not run when tried/.test(t)).length,
      0,
      `a merely failing criterion must draw no comment, got: ${infos.join(" | ")}`,
    );
  });
});

describe("the receipt", () => {
  it("records a broken check as never having run, not as a failure", async () => {
    // The receipt is the document handed to whoever was not there to watch.
    // "FAIL" beside a command that never executed tells that reader something
    // was tried and found wanting. Nothing was tried.
    const dir = ws();
    const receipts = new Receipts(dir);
    const written = receipts.write({
      claim: "done",
      result: {
        ok: false,
        results: [
          {
            name: "task:db",
            kind: "command",
            detail: MISSING,
            ok: false,
            didNotRun: true,
            exitCode: 127,
            output: "[molt] the command was not found",
            durationMs: 3,
          },
        ],
        durationMs: 3,
      },
      attempt: 1,
      verdict: "exhausted",
      model: "test-model",
      provider: "mock",
      sessionTokens: 0,
      shedBatches: 0,
    });
    const text = readFileSync(written.path, "utf8");
    assert.match(text, /\*\*did not run\*\*/, "the summary table");
    assert.match(text, /### task:db — did not run/, "the per-check heading");
    assert.match(text, /result: did-not-run/, "and the grep-able line under it");
    assert.doesNotMatch(text, /\*\*FAIL\*\*/, "nothing here may call it a failure");
    assert.doesNotMatch(text, /result: fail/);
  });
});

describe("a turn whose only unmet check is broken", () => {
  it("stops after one attempt instead of spending them all", async () => {
    const dir = ws();
    const provider = scriptedProvider([{ text: "Done — the database criterion is satisfied." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar(`
version: 1
checks:
  - name: task:db
    run: ${MISSING}
    timeout: 10
`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 4,
    });

    const events = await drain(engine.run("add the database layer", allowAll));
    const errors = events.filter((e) => e.kind === "error").map((e) => (e as { text: string }).text);

    assert.equal(provider.calls, 1, "one request, not four: no further attempt could change this");
    assert.ok(
      events.some((e) => e.kind === "proof_exhausted"),
      "the turn still ends unproven — the claim was never verified",
    );
    assert.ok(
      errors.some((t) => /did not run/.test(t) && /task:db/.test(t)),
      `the error must name the broken check, got: ${errors.join(" | ")}`,
    );
    assert.ok(
      errors.some((t) => /Repair the check/.test(t)),
      "and must ask a human to repair it rather than the model to satisfy it",
    );
  });

  it("keeps spending attempts when a real failure is present alongside it", async () => {
    // The broken check must not become a cheap way out of a red suite.
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), "exit 1\n");
    const provider = scriptedProvider([{ text: "Done." }]);
    const engine = new Engine({
      baseUrl: "http://mock/v1",
      model: "test-model",
      provider: "mock",
      cwd: dir,
      fetchFn: provider.fetchFn,
      bar: parseBar(`
version: 1
checks:
  - name: task:db
    run: ${MISSING}
    timeout: 10
  - name: suite
    run: sh ./check.sh
    timeout: 10
`),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 2,
    });

    await drain(engine.run("add the database layer", allowAll));
    assert.equal(provider.calls, 2, "a real failure is still worth another attempt");
  });
});

describe("trying the criteria before the work", () => {
  it("reports a criterion whose command does not exist", async () => {
    const dir = ws();
    const broken = await preflightCriteria([{ name: "db", kind: "command", run: MISSING }], {
      cwd: dir,
    });
    assert.equal(broken.length, 1);
    assert.equal(broken[0].name, "db");
    assert.match(broken[0].why, /not found/);
  });

  it("says nothing about a criterion that merely fails", async () => {
    // The whole point of a criterion is that it does not pass yet. Reporting
    // this would make the feature unusable and train people to ignore it.
    const dir = ws();
    const broken = await preflightCriteria(
      [
        { name: "not-yet", kind: "command", run: "exit 1" },
        { name: "missing-file", kind: "command", run: "grep -q x ./not-here.txt" },
      ],
      { cwd: dir },
    );
    assert.deepEqual(broken, [], "a file the work is about to create is not a broken command");
  });

  it("treats a criterion that is still running as one that ran", async () => {
    const dir = ws();
    const t0 = Date.now();
    const broken = await preflightCriteria([{ name: "slow", kind: "command", run: "sleep 5" }], {
      cwd: dir,
      timeoutMs: 300,
    });
    assert.deepEqual(broken, []);
    assert.ok(Date.now() - t0 < 4_000, "and does not wait for it");
  });

  it("skips builtins, which are molt's own bookkeeping and never a shell command", async () => {
    // Carrying a `run` too, because these arrive from parsed YAML and JSON
    // where a field can be present whatever the type says. The kind decides.
    const dir = ws();
    const broken = await preflightCriteria(
      [{ name: "wrote-something", kind: "builtin", run: MISSING }],
      { cwd: dir },
    );
    assert.deepEqual(broken, []);
  });
});
