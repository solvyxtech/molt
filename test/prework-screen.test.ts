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
import { draftCriteriaCritiqued, PASSES_BEFORE_WORK } from "../src/criteria.js";
import { workspace } from "./helpers.js";

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
