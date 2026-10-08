/**
 * Drafted checks that cannot show the task was done are fixed at seal time.
 *
 * On 2026-10-07 a separate judge drafted `python3 server.py 8080 & sleep 1;
 * curl -f .../items || echo 'fail'`: it exits 0 whatever happens, passed
 * before server.py existed, and earned a wrong "verified". Two screens now
 * run before a drafted check is sealed:
 *  - L16 (always on): constructs that cannot fail — `|| echo …`, `|| true`,
 *    `; exit 0`, `find … -exec … \;`, PASS/FAIL printed with exit 0;
 *  - P1: the check is tried on a copy of the project taken before the work;
 *    one that already passes there is sent back to the drafter once with the
 *    reason, and dropped if the redraft still passes.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { cannotFail } from "../src/checklint.js";
import { reportsFailure } from "../src/evidence.js";
import { draftCriteriaCritiqued, PASSES_BEFORE_WORK } from "../src/criteria.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";
import { Engine } from "../src/engine.js";
import type { Check } from "../src/types.js";

describe("cannotFail", () => {
  it("flags the constructs that exit 0 whatever happens", () => {
    const flagged = [
      "python3 server.py 8080 & sleep 1; curl -f http://127.0.0.1:8080/items || echo 'fail'",
      "python3 wc.py words.txt || true",
      "grep -q x out.txt; exit 0",
      String.raw`find configs/ -name '*.json' -exec sh -c 'jq -e ".version == 2" {} 2>/dev/null || exit 1' \;`,
      `python3 -c "import csv; h = next(csv.reader(open('clean.csv'))); print('PASS' if len(h) == 5 else 'FAIL')"`,
    ];
    for (const run of flagged) assert.ok(cannotFail(run), run);
  });

  it("flags checks whose exit code does not depend on what they assert", () => {
    const flagged = [
      // The csv-clean class: prints True or False, exits 0 either way.
      `python3 -c "import csv; print(list(csv.reader(open('out.csv'))) == [['a'],['b']])"`,
      `python3 -c "print(open('o').read().strip() == 'x')" || exit 1`,
      `cd sub && python3 -c "print(1 in [1])"`,
      "python3 - <<'EOF'\nimport json\nd = json.load(open('o.json'))\nprint(d['n'] == 3)\nEOF",
      `node -e "console.log(require('fs').readFileSync('o','utf8').trim() === 'x')"`,
      "jq '.count == 3' out.json",
      "awk '$1 > 3' data.txt",
      // An echo of a result.
      "grep -q 42 out.txt; echo $?",
      "test -f out.txt; echo done",
      `if [ "$(cat out)" = 3 ]; then echo yes; fi`,
      `if [ "$(cat out)" = 3 ]; then echo yes; else echo no; fi`,
    ];
    for (const run of flagged) assert.ok(cannotFail(run), run);
  });

  it("leaves a comparison alone when something fails on it, or a later stage reads the output", () => {
    const fine = [
      `python3 -c "print('PASS' if 1 == 1 else 'FAIL')" | grep -qx PASS`,
      `[ "$(python3 -c "print(1 == 1)")" = True ]`,
      `python3 -c "import json; assert json.load(open('o.json'))['n'] == 3"`,
      `python3 -c "import sys; sys.exit(0 if open('o').read() == 'x' else 1)"`,
      "jq -e '.count == 3' out.json",
      "awk 'END { exit !(NR == 3) }' data.txt",
      "if grep -q x f; then exit 0; else exit 1; fi",
      "set -e; grep -q x f; echo ok",
      "test -f out.txt && echo done",
      "python3 server.py & sleep 1; curl -sf localhost:8080/items | jq -e 'length == 2'",
      `python3 -c "import out; print(out.f(2))" | grep -qx 4`,
      `node -e "const a=require('assert'); a.strictEqual(1,1)"`,
      "for f in a b; do grep -q x $f || exit 1; done; echo ok",
    ];
    for (const run of fine) assert.equal(cannotFail(run), null, run);
  });

  it("reportsFailure: a task check's own words decide when its exit code cannot", () => {
    assert.match(reportsFailure("python3 -c 'print(x == y)'", "False\n")!, /printed `False`/);
    assert.ok(reportsFailure(`python3 -c "print('rows: 2'); print('FAIL')"`, "rows: 2\nFAIL\n"));
    assert.ok(reportsFailure("grep -qx 3 out.txt || echo fail", "fail\n"));
    assert.ok(reportsFailure("jq '.n == 3' o.json", "false\n"));
    assert.ok(reportsFailure("grep -q 42 out.txt; echo $?", "1\n"));
    assert.equal(reportsFailure("grep -q 42 out.txt; echo $?", "0\n"), null);
    assert.equal(reportsFailure("python3 -c 'print(x == y)'", "True\n"), null);
    assert.equal(reportsFailure(`python3 -c "print('3 failed, then fixed'); print('ok')"`, "3 failed, then fixed\nok\n"), null, "only the last line is the verdict");
    assert.equal(reportsFailure("python3 -c 'print(1)'", ""), null);
    // The step that decides the exit did not print the verdict: jq inside find, jq -e, grep.
    assert.equal(reportsFailure(String.raw`find configs/ -name '*.json' -exec sh -c 'jq -e ".version == 1" {} && exit 1 || exit 0' \;`, "false\nfalse\n"), null);
    assert.equal(reportsFailure("jq -e '.ok' o.json", "false\n"), null);
    assert.equal(reportsFailure("cat out.txt | grep -c x", "no\n"), null);
  });

  it("leaves checks whose status means something alone", () => {
    const fine = [
      "grep -qx hello out.txt",
      String.raw`find . -name '*.py' -exec grep -l foo {} \; | grep -q .`,
      "find . -name '*.py' -exec grep -q foo {} +",
      `[ "$(cat a.txt)" = "a" ] && echo PASS || { echo FAIL; exit 1; }`,
      "rm -f x || true; python3 wc.py words.txt | grep -qx 3",
      "test -f a || echo missing; exit 1",
    ];
    for (const run of fine) assert.equal(cannotFail(run), null, run);
  });
});

describe("drafted checks tried on the pre-work copy", () => {
  type Msgs = { messages: { role: string; content: string }[] };
  function drafter(script: { first: string; redraft: string }) {
    const asked: string[] = [];
    const prompts: string[] = [];
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Msgs;
      const system = body.messages[0]!.content;
      const prompt = body.messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n");
      const kind = system.startsWith("You review acceptance checks") ? "critic" : prompt.includes("was dropped:") ? "redraft" : "first";
      asked.push(kind);
      prompts.push(prompt);
      const content =
        kind === "critic" ? JSON.stringify({ checks: [], uncovered: [], requirements: [] }) : kind === "redraft" ? script.redraft : script.first;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, asked, prompts };
  }
  const base = { scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", task: "Write out.txt holding the number of words in words.txt" };
  const draft = (...checks: [string, string][]) => JSON.stringify({ checks: checks.map(([name, run]) => ({ name, run })), notes: [] });
  const GOOD: [string, string] = ["counts", "grep -qx 3 out.txt"];
  const ALWAYS: [string, string] = ["input-there", `[ "$(wc -w < words.txt | tr -d ' ')" = "3" ]`];

  /** The project before the work, and a copy of it standing in for the turn-start copy. */
  function before() {
    const ws = workspace();
    const pre = workspace();
    for (const dir of [ws.dir, pre.dir]) writeFileSync(join(dir, "words.txt"), "a b c\n");
    return { cwd: ws.dir, preWorkDir: pre.dir, cleanup: () => (ws.cleanup(), pre.cleanup()) };
  }

  it("a check that already passes is sent back once with the reason, and the replacement is sealed", async () => {
    const p = before();
    try {
      const { fetchFn, asked, prompts } = drafter({ first: draft(GOOD, ALWAYS), redraft: draft(["has-count", "grep -q '^[0-9]' out.txt"]) });
      const r = await draftCriteriaCritiqued({ ...base, cwd: p.cwd, preWorkDir: p.preWorkDir, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(asked.filter((k) => k !== "critic"), ["first", "redraft"]);
      assert.ok(prompts.find((x) => x.includes("was dropped:"))!.includes(PASSES_BEFORE_WORK));
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts", "has-count"]);
      assert.deepEqual(r.lint!.map((l) => [l.name, l.rule, l.redraft]), [["input-there", "P1-passes-before-work", false]]);
    } finally {
      p.cleanup();
    }
  });

  it("a redraft that still passes before the work is dropped", async () => {
    const p = before();
    try {
      const { fetchFn, asked } = drafter({ first: draft(GOOD, ALWAYS), redraft: draft(["still", "test -f words.txt"]) });
      const r = await draftCriteriaCritiqued({ ...base, cwd: p.cwd, preWorkDir: p.preWorkDir, fetchFn });
      assert.ok(r.ok);
      assert.equal(asked.filter((k) => k === "redraft").length, 1, "sent back once, no more");
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts"]);
      assert.deepEqual(r.lint!.map((l) => [l.name, l.rule, l.redraft]), [["input-there", "P1-passes-before-work", false], ["still", "P1-passes-before-work", true]]);
    } finally {
      p.cleanup();
    }
  });

  it("a check that prints FAIL and exits 0 is caught when it runs, and a can't-fail tail by the lint", async () => {
    const p = before();
    try {
      const printsFail = ["verdict", "test -f out.txt && echo ok || echo FAIL"] as [string, string];
      const tail = ["server", "python3 server.py & sleep 1; curl -sf localhost:9/items || echo 'fail'"] as [string, string];
      const { fetchFn } = drafter({ first: draft(GOOD, printsFail, tail), redraft: draft() });
      const r = await draftCriteriaCritiqued({ ...base, cwd: p.cwd, preWorkDir: p.preWorkDir, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts"]);
      const rules = Object.fromEntries(r.lint!.map((l) => [l.name, l.rule]));
      assert.equal(rules.server, "L16-cannot-fail");
      assert.ok(rules.verdict === "L16-cannot-fail" || rules.verdict === "L16-printed-fail", rules.verdict);
    } finally {
      p.cleanup();
    }
  });

  it("without a pre-work copy nothing is tried; the lint still applies", async () => {
    const p = before();
    try {
      const { fetchFn, asked } = drafter({ first: draft(GOOD, ALWAYS), redraft: draft() });
      const r = await draftCriteriaCritiqued({ ...base, cwd: p.cwd, fetchFn });
      assert.ok(r.ok);
      assert.deepEqual(asked.filter((k) => k !== "critic"), ["first"]);
      assert.deepEqual(r.draft.checks.map((c) => c.name), ["counts", "input-there"]);
    } finally {
      p.cleanup();
    }
  });
});

describe("a check that prints a boolean, at the bar", () => {
  // The reviewer's reproduction: sealed as a judge's check, it raised before the
  // work (no out.csv), so the pre-work try counted it as failing there; after
  // WRONG work it printed False and exited 0, and the run read "verified".
  const run = `python3 -c "import csv; print(list(csv.reader(open('out.csv'))) == [['a'],['b']])"`;
  const check = { name: "rows", kind: "command", run, timeoutMs: 10_000, expectExit: 0, tags: ["task", "value"], hidden: true, author: { kind: "judge", model: "judge-j" } } as Check;
  async function turn(csv: string) {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.csv", content: csv } }] },
        { text: "Done." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", maxProofAttempts: 1 });
      const events = await drain(engine.run("Write out.csv with rows a then b.", allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      return { end, events };
    } finally {
      ws.cleanup();
    }
  }
  it("wrong work: it printed False, so it failed, and nothing is verified", async () => {
    const { end, events } = await turn("b\na\n");
    assert.notEqual(end.outcome, "verified");
    const refused = events.find((e) => e.kind === "proof_refused" || e.kind === "proof_exhausted");
    assert.match(JSON.stringify(refused), /printed `False` and exited 0/);
  });
  it("right work: it printed True and passes as before", async () => {
    const { end } = await turn("a\nb\n");
    assert.deepEqual([end.outcome, end.claim], ["verified", "verified (independent checks: judge-j)"]);
  });
});

