/**
 * With --require-discriminating (MAAT_REQUIRE_DISCRIMINATING=1), "verified"
 * needs a check that tells this work from no work. Off by default: replayed
 * over the 2026-10-07 lanes it removed 2 wrong verifieds and denied 10 right
 * ones; the cause is fixed at seal time instead (criteria.ts screen).
 *
 * On the 2026-10-07 container bench a separate judge drafted
 * `python3 server.py 8080 & sleep 1; curl -f .../items || echo 'fail'` and two
 * more like it. Each exits 0 whatever happens, so each passed on the tree
 * before server.py existed, and the run was labelled verified; the grader got
 * a non-JSON 404. A passing independent runs+value check now earns the word
 * only when it FAILED on the tree before the work (the pre-work try in
 * sealCriteria). One that passed then too, or was never tried then, guards
 * against a regression and proves nothing about this work: the tier is
 * "passed-untested", outcome unverified, exit code 3.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli.js";
import { diagnoseFailure } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { Receipts } from "../src/receipts.js";
import { preWorkCopy } from "../src/scratch.js";
import { claimLabel, noteCoverage, tierOf, UNTESTED_CLAIM } from "../src/tiers.js";
import type { Check, CheckAuthor } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const JUDGE: CheckAuthor = { kind: "judge", model: "qwen3-coder-30b-a3b" };
const value = (name: string) => ({ name, ok: true, hidden: true as const, tags: ["task", "value"] });

describe("tierOf: a check that did not fail before the work cannot earn verified", () => {
  const names = ["task:server-starts-and-listens", "task:get-all-items", "task:post-new-item"];
  const authors = new Map(names.map((n) => [n, JUDGE]));
  const worker = "qwen/qwen3-235b-a22b-2507";

  it("the http-json-server run: every independent value check passed before the work too, so not verified", () => {
    const t = tierOf({ requireDiscriminating: true, results: names.map(value), worker, authors, guards: new Set(names), failedBefore: new Set() });
    assert.equal(t.tier, "passed-untested");
    assert.equal(t.basis, "independent", "the checks were independent; independence was not the problem");
    assert.match(t.reason!, /`task:get-all-items` passed before the work began too/);
    assert.equal(claimLabel("unverified", t), UNTESTED_CLAIM);
    assert.equal(UNTESTED_CLAIM, "passed checks that did not test this work, not verified");
  });

  it("a check that failed before the work and passes after: verified", () => {
    const t = tierOf({ requireDiscriminating: true, results: names.map(value), worker, authors, guards: new Set(names.slice(0, 2)), failedBefore: new Set([names[2]!]) });
    assert.deepEqual([t.tier, t.basis, t.by], ["verified", "independent", ["qwen3-coder-30b-a3b"]]);
  });

  it("a check with no pre-work try (broken then, or joined late with no copy) does not discriminate", () => {
    const t = tierOf({ requireDiscriminating: true, results: [value(names[0]!)], worker, authors, failedBefore: new Set() });
    assert.equal(t.tier, "passed-untested");
    assert.match(t.reason!, /was not tried before the work began/);
    assert.equal(tierOf({ requireDiscriminating: true, results: [value(names[0]!)], worker, authors }).tier, "passed-untested", "no pre-work record at all: nothing discriminates");
  });

  it("only independent value checks count: a discriminating check the worker wrote is still its own", () => {
    const mixed = new Map<string, CheckAuthor>([[names[0]!, JUDGE], [names[1]!, { kind: "worker", model: worker }]]);
    const t = tierOf({ requireDiscriminating: true, results: [value(names[0]!), value(names[1]!)], worker, authors: mixed, guards: new Set([names[0]!]), failedBefore: new Set([names[1]!]) });
    assert.equal(t.tier, "passed-untested");
    const own = tierOf({ requireDiscriminating: true, results: [value(names[1]!)], worker, authors: mixed, failedBefore: new Set([names[1]!]) });
    assert.equal(own.tier, "passed-own-checks", "the authorship rule is unchanged");
  });

  it("a failing or surface-only discriminating check carries nothing; a person's check still verifies", () => {
    const fb = new Set([names[0]!]);
    assert.equal(tierOf({ requireDiscriminating: true, results: [{ ...value(names[0]!), ok: false }], worker, authors, failedBefore: fb }).tier, "passed-checks");
    assert.equal(tierOf({ requireDiscriminating: true, results: [{ ...value(names[0]!), tags: ["task", "surface", "value"] }], worker, authors, failedBefore: fb }).tier, "passed-checks");
    assert.equal(tierOf({ requireDiscriminating: true, results: [{ name: "project", ok: true, kind: "command" as const, tags: [] }], worker }).tier, "verified");
  });
});

describe("tierOf without --require-discriminating: #32's tiering, unchanged", () => {
  it("ignores the pre-work record", () => {
    const authors = new Map([["task:v", JUDGE]]);
    const t = tierOf({ results: [value("task:v")], worker: "w", authors, guards: new Set(["task:v"]), failedBefore: new Set() });
    assert.deepEqual([t.tier, t.basis], ["verified", "independent"]);
  });
});

describe("noteCoverage", () => {
  it("matches a note to a check only on most of its meaningful words", () => {
    const cover = noteCoverage(
      ["Server must handle GET /items returning sorted list by id", "Rows keep the input order"],
      [
        { name: "task:get-all-items", text: "python3 server.py 8081 & sleep 1; curl -s http://127.0.0.1:8081/items | jq -e '.[0].id == 1'" },
        { name: "task:order-kept", text: "python3 -c 'rows keep input order' && diff clean.csv expected.csv" },
      ],
    );
    assert.deepEqual(cover[0]!.by, [], "sharing get/items/server is not covering a sort");
    assert.deepEqual(cover[1]!.by, ["task:order-kept"]);
  });
});

describe("the rule in a turn", () => {
  const TASK = "Write out.txt containing exactly the word hello.";
  const work: ScriptedTurn[] = [
    { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }, { name: "write_file", args: { path: "tool.sh", content: "exit 0\n" } }] },
    { text: "Done." },
  ];
  const check = (name: string, run: string): Check =>
    ({ name, kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true, author: JUDGE }) as Check;

  async function turn(checks: Check[], notes: string[] = [], requireDiscriminating = true) {
    const ws = workspace();
    try {
      const provider = scriptedProvider(work);
      const journal = new Journal(ws.dir, "disc");
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null,
        receipts: new Receipts(ws.dir), stream: false, autonomy: "high", journal,
        ...(requireDiscriminating ? { requireDiscriminating: true } : {}),
      });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks, taskNotes: notes }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      const dir = join(ws.dir, ".maat", "receipts");
      const rows = readFileSync(join(dir, "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const receipt = readdirSync(dir).filter((f) => f.endsWith(".md")).sort().map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      const tried = Journal.read(journal.path).filter((e) => e.kind === "note" && e.data.kind === "pre-work-try");
      return { end, events, rows, receipt, tried };
    } finally {
      ws.cleanup();
    }
  }

  it("only checks that passed before the work: passed checks that did not test this work, unverified", async () => {
    // Exits 0 with or without the work, like `curl ... || echo 'fail'`.
    const { end, events, rows, receipt, tried } = await turn([check("always", `[ "$(echo ok)" = "ok" ] || echo fail`)], ["out.txt holds hello"]);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["unverified", "passed-untested", UNTESTED_CLAIM]);
    assert.match(end.tierReason!, /`task:always` passed before the work began too/);
    assert.ok(events.some((e) => e.kind === "info" && e.text.startsWith(UNTESTED_CLAIM)));
    assert.deepEqual([rows.at(-1).tier, rows.at(-1).claim], ["passed-untested", UNTESTED_CLAIM]);
    assert.match(receipt, /before the work: passed \(a guard/);
    assert.match(receipt, /out\.txt holds hello — not matched to any check that failed before the work/);
    assert.deepEqual(tried[0]!.data.passed, ["task:always"]);
  });

  it("off by default: the same turn is verified as under #32, and the receipt still records the pre-work try", async () => {
    const { end, receipt, tried } = await turn([check("always", `[ "$(echo ok)" = "ok" ] || echo fail`)], [], false);
    assert.deepEqual([end.outcome, end.tier], ["verified", "verified"]);
    assert.match(receipt, /before the work: passed \(a guard/);
    assert.deepEqual(tried[0]!.data.passed, ["task:always"]);
  });

  it("a check that failed before the work and passes after: verified, and the receipt says it discriminates", async () => {
    const { end, receipt, tried } = await turn([check("always", `[ "$(echo ok)" = "ok" ]`), check("greeting", "grep -qx hello out.txt")], ["out.txt holds exactly hello greeting"]);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["verified", "verified", "verified (independent checks: qwen3-coder-30b-a3b)"]);
    assert.match(receipt, /before the work: failed \(this check can tell the work from none\)/);
    assert.match(receipt, /out\.txt holds exactly hello greeting — plausibly covered by `task:greeting`/);
    assert.deepEqual(tried[0]!.data.failed, ["task:greeting"]);
  });

  it("a check that could not run before the work has no pre-work try: not verified, on every platform", async () => {
    // Before tool.sh exists, `bash tool.sh` exits 127, and `sh tool.sh` exits 127
    // where sh is bash (macOS) and 2 where it is dash (Debian, Ubuntu): both are
    // read as broken, not failing, so neither counts as tried.
    for (const run of ["bash tool.sh", "sh tool.sh"]) {
      const { end, receipt } = await turn([check("tool", run)]);
      assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-untested"], run);
      assert.match(end.tierReason!, /`task:tool` was not tried before the work began/);
      assert.match(receipt, /before the work: not tried/);
    }
  });

  it("dash's missing-script exit reads as bash's", () => {
    assert.equal(diagnoseFailure(2, "", "sh: 0: cannot open tool.sh: No such file\n").didNotRun, true);
    assert.equal(diagnoseFailure(127, "", "bash: tool.sh: No such file or directory\n").didNotRun, true);
    assert.equal(diagnoseFailure(2, "", "python3: can't open file 'x.py': [Errno 2] No such file or directory\n").didNotRun, false, "an interpreter's own missing file is the work missing");
  });

  it("a drafted check is tried before the work under the shell the bar runs it with", async () => {
    // `==` inside `[ ]` and `echo -e` are bash; under dash the first errs and the
    // second prints "-e x". Tried under sh it "failed before the work" on Linux
    // and passed at the bar under bash: a guard counted as discriminating.
    const { tried } = await turn([check("bashism", `[ "$(echo -e x)" == "x" ]`)], [], false);
    assert.deepEqual(tried[0]!.data.passed, ["task:bashism"]);
  });
});

describe("parseArgs --require-discriminating", () => {
  it("is off unless asked for", () => {
    assert.equal(parseArgs([]).requireDiscriminating, undefined);
    assert.equal(parseArgs(["--require-discriminating"]).requireDiscriminating, true);
  });
});

describe("late checks and the copy taken before the work", () => {
  const later = <T>(v: T, ms: number) => new Promise<T>((r) => setTimeout(() => r(v), ms));
  const nothing = async () => ({ taskChecks: [] as Check[], taskNotes: [] as string[] });
  const mk = (name: string, run: string): Check => ({ name, kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true, author: JUDGE }) as Check;

  const TASK = "Write out.txt containing exactly the word hello.";
  async function lateTurn(dir: string, calls: { name: string; args: Record<string, unknown> }[], checks: Check[]) {
    const provider = scriptedProvider([{ calls }, { text: "Done." }]);
    const journal = new Journal(dir, "late-copy");
    const engine = new Engine({
      baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", journal,
      requireDiscriminating: true,
    });
    engine.setTurnDeadline(600_000);
    const events = await drain(engine.run(TASK, allowAll, { pendingCriteria: later({ taskChecks: checks, taskNotes: [] }, 300), criteriaSoFar: nothing, criteriaWaitMs: 100 }));
    const end = events.find((e) => e.kind === "job_end");
    assert.ok(end && end.kind === "job_end");
    return { end, tried: Journal.read(journal.path).filter((e) => e.kind === "note" && e.data.kind === "pre-work-try"), copies: Journal.read(journal.path).filter((e) => e.kind === "note" && e.data.kind === "pre-work-copy") };
  }

  it("is tried on the copy when the copy is untouched: the check failed before the work and discriminates", async () => {
    const ws = workspace();
    try {
      const { end, tried, copies } = await lateTurn(ws.dir, [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }], [mk("greeting", "grep -qx hello out.txt")]);
      assert.equal(copies.length, 1, "the copy is journalled with its timing");
      assert.equal(typeof copies[0]!.data.ms, "number");
      assert.deepEqual(tried.at(-1)!.data.failed, ["task:greeting"]);
      assert.equal(end.outcome, "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("a copy the worker changed during the work is not the tree before it: late checks count as not tried", async () => {
    const ws = workspace();
    const seed = `seed-${process.pid}-${Date.now()}.txt`;
    writeFileSync(join(ws.dir, seed), "pristine\n");
    try {
      // The worker, as Maat's own uid, finds the copy under the temp folder and edits it.
      const tamper = `for f in "\${TMPDIR:-/tmp}"/maat-check-*/*/${seed}; do echo hello > "$f"; done; cp ${seed} /dev/null`;
      const { end, tried } = await lateTurn(
        ws.dir,
        [{ name: "bash", args: { command: tamper } }, { name: "write_file", args: { path: "out.txt", content: "hello\n" } }],
        [mk("seeded", `grep -qx hello ${seed} || grep -qx hello out.txt`)],
      );
      const note = tried.find((e) => e.data.tampered === true);
      assert.ok(note, "the change to the copy is journalled");
      assert.deepEqual(note!.data.untried, ["task:seeded"]);
      assert.equal(end.tier, "passed-untested");
    } finally {
      ws.cleanup();
    }
  });

  it("a late check that names the project's absolute path is not tried on the copy", async () => {
    const ws = workspace();
    try {
      const { tried } = await lateTurn(ws.dir, [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }], [mk("abs", `grep -qx hello ${join(ws.dir, "out.txt")}`)]);
      assert.ok(tried.some((e) => Array.isArray(e.data.untried) && (e.data.untried as string[]).includes("task:abs")));
    } finally {
      ws.cleanup();
    }
  });
});

describe("preWorkCopy", () => {
  it("knows when the copy changed", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "a.txt"), "a\n");
      const c = await preWorkCopy(ws.dir);
      assert.ok(c);
      try {
        assert.equal(await c.intact(), true);
        writeFileSync(join(c.dir, "a.txt"), "b\n");
        assert.equal(await c.intact(), false, "same size, different content");
        writeFileSync(join(c.dir, "a.txt"), "a\n");
        assert.equal(await c.intact(), true);
        writeFileSync(join(c.dir, "new.txt"), "");
        assert.equal(await c.intact(), false, "a file added");
      } finally {
        await c.cleanup();
      }
    } finally {
      ws.cleanup();
    }
  });
});

