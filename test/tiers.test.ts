/**
 * "verified" is earned by the evidence, the same on every model (src/tiers.ts).
 *
 * Measured over three models, a verified backed by a check that ran the
 * deliverable AND asserted a value, with no reviewer contradiction, was right
 * 7/7; everything else carrying the word was right 28/50.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { taskChecksFrom } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { assertsValue, passedChecksWords, tierOf } from "../src/tiers.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

describe("the value tag", () => {
  const yes = [
    `[ "$(python3 tool.py in.txt)" = "42" ]`,
    `[ "$(python3 tool.py)" == "hello world" ]`,
    `[ $(wc -l < out.txt) -eq 365 ]`,
    `test "$(cat out.txt)" != "0"`,
    `python3 -c "import tool; assert tool.add(2, 3) == 5"`,
    `python3 -c "import sys, tool; sys.exit(0 if tool.f('a')==['a'] else 1)"`,
    `node -e "const a=require('assert'); a.strictEqual(require('./t').f(2), 4)"`,
    `python3 tool.py | diff - expected.txt`,
    `diff <(python3 tool.py) golden/out.txt`,
    `python3 tool.py | diff - <<'EOF'\nalpha\nbeta\nEOF`,
    `cmp out.bin answer.bin`,
    `python3 tool.py | grep -q "total: 41"`,
    `python3 tool.py | grep -qx "done"`,
    `python3 tool.py | grep -q '^ok: [a-z]*$'`,
  ];
  const no = [
    `test -f out.txt`,
    `python3 -c "import t, u; t.assertEqual(f(2), y)"`,
    `python3 -m py_compile tool.py`,
    `python3 tool.py --help`,
    `[ "$a" = "$b" ]`,
    `[ "$(python3 tool.py)" == "$(cat ref.txt)" ]`,
    `python3 -c "import tool; assert tool.ok()"`,
    `python3 -c "x = 3; print(x)"`,
    `python3 -c "assert a == b"`,
    `diff out.txt in.txt`,
    `grep -q "def main" tool.py`,
    `grep -c "x" out.txt`,
    `grep -q python3 tool.py`,
    `[ $(wc -l < out.txt) -gt 0 ]`,
    `[ -s out.txt ]`,
  ];
  for (const c of yes) it(`asserts a value: ${c.split("\n")[0]}`, () => assert.equal(assertsValue(c), true, c));
  for (const c of no) it(`asserts no value: ${c}`, () => assert.equal(assertsValue(c), false, c));

  it("reaches the sealed check as a tag beside the critic's surface reading", () => {
    const sealed = taskChecksFrom(
      {
        checks: [
          { name: "exists", run: "test -f out.txt", surface: true },
          { name: "grep", run: `grep -q "total: 41" out.txt`, surface: true },
          { name: "runs", run: `[ "$(./tool in)" = "42" ]` },
          { name: "runs-only", run: "./tool in > out" },
        ],
        notes: [],
      },
      { hidden: true },
    );
    assert.deepEqual(sealed.taskChecks.map((t) => t.tags), [
      ["task", "surface"],
      ["task", "surface", "value"],
      ["task", "value"],
      ["task"],
    ]);
  });
});

describe("tierOf", () => {
  const ok = (tags: string[], hidden = true) => ({ ok: true, hidden: hidden || undefined, tags });
  it("needs a passing check that runs the work and asserts a value", () => {
    assert.equal(tierOf({ results: [ok(["task", "value"])] }).tier, "verified");
    assert.equal(tierOf({ results: [ok(["task"]), ok(["task", "value"])] }).tier, "verified");
    assert.equal(tierOf({ results: [ok(["task"])] }).tier, "passed-checks");
    assert.equal(tierOf({ results: [ok(["task", "surface", "value"])] }).tier, "passed-checks", "a check that only looks cannot carry it");
    assert.equal(tierOf({ results: [{ ok: false, hidden: true, tags: ["task", "value"] }] }).tier, "passed-checks", "a failing check is no evidence");
  });
  it("lets a person's passing check verify, and a contradiction undo any of it", () => {
    assert.equal(tierOf({ results: [ok([], false)] }).tier, "verified");
    const r = tierOf({ results: [ok(["task", "value"])], review: { votes: "1/3", violations: [] } });
    assert.equal(r.tier, "passed-checks");
    assert.match(r.reason!, /1\/3/);
    assert.equal(tierOf({ results: [ok(["task", "value"])], review: { votes: "0/3", violations: [] } }).tier, "verified");
  });
  it("says it in one phrase", () => {
    assert.equal(passedChecksWords("no check asserted an expected value"), "passed its checks (not verified: no check asserted an expected value)");
  });
});

describe("the tier in a turn", () => {
  const TASK = "Write out.txt containing exactly the word hello.";
  const make = (tags: string[], run: string, hidden = true): Check =>
    ({ name: "made", kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags, ...(hidden ? { hidden: true } : {}) }) as Check;
  const SURFACE = make(["task", "surface"], "test -f out.txt");
  const RUNS = make(["task"], "test -s out.txt");
  const VALUE = make(["task", "value"], `grep -qx hello out.txt`);
  const work: ScriptedTurn[] = [
    { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
    { text: "Done." },
  ];
  const violation = JSON.stringify({ violations: [{ quote: "exactly the word hello", evidence: "the receipt shows otherwise" }] });
  const clean = JSON.stringify({ violations: [] });

  async function run(check: Check, extra: ScriptedTurn[] = [], review = false) {
    const ws = workspace();
    try {
      const provider = scriptedProvider([...work, ...extra]);
      const receipts = new Receipts(ws.dir);
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null,
        receipts, stream: false, autonomy: "high", ...(review ? { review: { votes: 3 } } : {}),
      });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [check] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      const rows = readFileSync(join(ws.dir, ".maat", "receipts", "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      return { end, events, rows };
    } finally {
      ws.cleanup();
    }
  }

  it("a pass that only looks is passed-checks, not verified", async () => {
    const { end, events, rows } = await run(SURFACE);
    assert.equal(end.outcome, "unverified");
    assert.equal(end.tier, "passed-checks");
    assert.match(end.tierReason!, /ran the work and asserted/);
    assert.ok(events.some((e) => e.kind === "info" && /passed its checks \(not verified: /.test(e.text)));
    assert.deepEqual([rows.at(-1).tier, rows.at(-1).evidence], ["passed-checks", "surface"], "the receipt records the tier");
  });

  it("a pass that ran the work but asserted no value is not verified", async () => {
    const { end, rows } = await run(RUNS);
    assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-checks"]);
    assert.match(end.tierReason!, /asserted an expected value/);
    assert.equal(rows.at(-1).evidence, "runs");
  });

  it("a pass that ran the work and asserted a value is verified", async () => {
    const { end, rows } = await run(VALUE);
    assert.deepEqual([end.outcome, end.tier, end.tierReason], ["verified", "verified", undefined]);
    assert.deepEqual([rows.at(-1).tier, rows.at(-1).evidence], ["verified", "runs+value"]);
  });

  it("a reviewer contradiction takes the word back, and the index row says so", async () => {
    const { end, rows } = await run(VALUE, [{ text: violation }, { text: clean }, { text: clean }], true);
    assert.equal(end.review?.votes, "1/3");
    assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-checks"]);
    assert.match(end.tierReason!, /independent review found 1\/3/);
    assert.equal(rows.at(-1).tier, "passed-checks");
    const clear = await run(VALUE, [{ text: clean }, { text: clean }, { text: clean }], true);
    assert.deepEqual([clear.end.outcome, clear.end.tier, clear.end.review?.votes], ["verified", "verified", "0/3"]);
  });

  it("a person's own passing check still verifies", async () => {
    const { end, rows } = await run(make(["task"], "test -s out.txt", false));
    assert.deepEqual([end.outcome, end.tier], ["verified", "verified"]);
    assert.equal(rows.at(-1).evidence, "person");
  });
});
