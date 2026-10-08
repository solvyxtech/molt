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

  // Rule 5 and the bracket fix, on commands the 2026-10-07 lanes drafted and V-no-value refused.
  const behaviour = [
    // a specific exception, and only the path without it exits non-zero
    `python3 -c "import pricing\ntry:\n    pricing.price('zz-no-such-item-xyz', 1)\nexcept KeyError:\n    raise SystemExit(0)\nraise SystemExit(1)"`,
    `python3 -c "import pricing\ntry:\n    pricing.price('zz', 1)\n    raise SystemExit('no KeyError')\nexcept KeyError:\n    pass"`,
    `python3 -c "import pytest, pricing\nwith pytest.raises(KeyError):\n    pricing.price('zz', 1)"`,
    `cd $(mktemp -d) && cp ../pricing.py . && python3 -c "from pricing import price; price('widget', 1, 'UNKNOWN')" 2>&1 | grep -q 'ValueError' && exit 0 || exit 1`,
    // is None / a literal in the answer, on a call with literal input
    `python3 -c "import pricing; assert pricing.best_coupon('zz', 1) is None, 'no coupon for an unknown item'"`,
    `python3 -c "import sys, pricing; sys.exit(0 if 'SAVE10' in pricing.coupons_for('mug', 2) else 1)"`,
    // a literal grepped from what running the work printed
    `echo -e '!!!\n!!!' | python3 slugify.py | grep -q 'untitled$'`,
    `python3 nextrun.py '* * * * 1' '2023-01-01 12:00' 1 | grep '2023-01-02'`,
    `node summarize.js nonexistent.json 2>&1 | grep -q 'Error reading file'`,
    `./rotate.sh 2>&1 | grep -q 'usage'`,
    // rule 1 inside a test bracket whose $(...) holds a ; or a newline, and $'...' literals
    `[ "$(python3 -c "from pricing import best_coupon; print(best_coupon('A', 5))")" = 'SAVE10' ]`,
    `[ "$(python3 -c "import json; d=json.load(open('configs/api.json')); print(d['version'])")" = "2" ]`,
    `[ $(node summarize.js nonexistent.json 2>&1; echo $?) = 1 ]`,
    `output=$(python3 wc.py f1.txt f2.txt) && [ "$output" = $'2 2 4 f1.txt\n4 5 10 total' ]`,
  ];
  const notBehaviour = [
    // #44 review: weaker than truthiness, or text that must be absent (nothing at all passes too).
    `python3 -c "import pricing; assert pricing.best_coupon('item1', 1) is not None"`,
    `python3 -c "import slug; assert '!' not in slug.slugify('Hello!')"`,
    `python3 -c "import slug; assert not '!' in slug.slugify('Hello!')"`,
    `! python3 tool.py 2>&1 | grep -q Traceback`,
    `python3 tool.py 2>&1 | grep -q Traceback && exit 1`,
    `if python3 tool.py 2>&1 | grep -q Traceback; then exit 1; fi`,
    `python3 t.py | grep -qi 'er'`,
    `python3 t.py | grep -E 'ok|fail'`,
    `d=$(mktemp -d) && cp -r md2html.py src Makefile "$d"/ && cd "$d" && make -s && ! make | grep -q md2html`,
    // Not widened: the work's pattern tried on the check's own strings (4 of 7 such flips were grader failures).
    `python3 -c "import re; p=open('regex.txt').read().strip(); assert re.search(p, 'GET 10.1.2.3 served 2024-05-06 ok'), p"`,
    `python3 -c "import re; p=open('regex.txt').read().strip(); assert re.search(p, 'host 192.168.01.1 seen 2024-05-06') is None, p"`,
    `[ "$(python3 -c "\nimport re\nregex = re.compile(open('regex.txt').read().strip())\nprint('PASS' if not regex.search('192.168.01.1 2023-01-01') else 'FAIL')\n")" = "PASS" ]`,
    // a timing bound with only a type check
    `timeout 5 python3 -c "from pairs import find_pairs; import random; random.seed(1); nums=[random.randint(-10**6,10**6) for _ in range(200000)]; r=find_pairs(nums, 7); assert isinstance(r, list)"`,
    `python3 -c "import time,random,pairs as p;a=[random.randint(0,10**9) for _ in range(200000)];t=time.time();p.find_pairs(a);assert time.time()-t<5"`,
    `python3 -c "import time; from pairs import find_pairs; t0=time.time(); r=find_pairs(list(range(200000)), 199999); assert len(r)>0 and time.time()-t0<5"`,
    // structural: existence, type, non-empty
    `python3 -c 'import pricing; assert hasattr(pricing, "COUPONS"), "COUPONS dict missing"'`,
    `[ "$(python3 -c "import json; d=json.load(open('configs/web.json')); print(type(d['debug']).__name__)")" = "bool" ]`,
    `[ "$(python3 -c "import json; d=json.load(open('configs/w.json')); print(isinstance(d['features'], list))")" = "True" ]`,
    `head -n 1 clean.csv | grep -q 'id,name,email,age,city'`,
    `git log --oneline -n 1 | grep -q 'Revert.*Add experimental cache'`,
    `make clean && ! [ -d build ]`,
    // the outcome is printed, never asserted
    `python3 -c "import pricing; print(pricing.best_coupon('item1', 1) is not None)"`,
    `python3 -c "import pricing; try: pricing.price('item1', 1, 'UNKNOWN'); print('No error'); except ValueError: print('ValueError raised')"`,
    // an exception that is not specific, or only the raising path fails
    `python3 -c "import pricing\ntry:\n    pricing.price('zz', 1)\nexcept Exception:\n    raise SystemExit(0)\nraise SystemExit(1)"`,
    `python3 -c "import pricing\ntry:\n    pricing.price('mug', 1)\nexcept KeyError:\n    raise SystemExit(1)"`,
    // truthiness of an arbitrary call; a comparison of two unknowns; or-ed conditions
    `python3 -c "import tool; assert tool.ok('x')"`,
    `python3 -c "import pricing; assert pricing.price('mug', 2, 'SAVE10') == pricing.price('mug', 2, None) * 0.9"`,
    `python3 -c "import pricing; assert pricing.best_coupon('a', 1) is None or True"`,
    `cd $(mktemp -d) && [ "$(python3 -c "from pricing import price; print(price('w', 2, 'S'))")" = "$(python3 -c "from pricing import price; print(price('w', 2, 'S'))")" ]`,
    // grep that inverts or counts
    `echo -e 'hello\n\nworld' | python3 wrap.py 10 | grep -c '^$'`,
    `python3 tool.py | grep -v 'error'`,
  ];
  for (const c of behaviour) it(`asserts behaviour: ${c.split("\n")[0]}`, () => assert.equal(assertsValue(c), true, c));
  for (const c of notBehaviour) it(`asserts no behaviour: ${c.split("\n")[0]}`, () => assert.equal(assertsValue(c), false, c));

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
      ["task", "value", "exact"],
      ["task"],
    ]);
  });
});

describe("tierOf", () => {
  const ok = (tags: string[], hidden = true) => ({ name: "c", ok: true, hidden: hidden || undefined, kind: "command" as const, tags });
  // Drafted by a separate judge model: the authorship rule is pinned in independent-checks.test.ts.
  // ...and it failed on the tree before the work (the discrimination rule is pinned in discriminating-checks.test.ts).
  const J = { worker: "worker-m", authors: new Map([["c", { kind: "judge" as const, model: "judge-j" }]]), failedBefore: new Set(["c"]) };
  it("needs a passing check that runs the work and asserts an exact value", () => {
    assert.equal(tierOf({ ...J, results: [ok(["task", "value", "exact"])] }).tier, "verified");
    assert.equal(tierOf({ ...J, results: [ok(["task"]), ok(["task", "value", "exact"])] }).tier, "verified");
    assert.equal(tierOf({ ...J, results: [ok(["task"])] }).tier, "passed-checks");
    assert.equal(tierOf({ ...J, results: [ok(["task", "surface", "value"])] }).tier, "passed-checks", "a check that only looks cannot carry it");
    assert.equal(tierOf({ ...J, results: [{ ok: false, hidden: true, tags: ["task", "value", "exact"] }] }).tier, "passed-checks", "a failing check is no evidence");
  });
  it("lets a person's passing check verify, and a contradiction undo any of it", () => {
    assert.equal(tierOf({ ...J, results: [{ ...ok([], false), name: "project" }] }).tier, "verified");
    const r = tierOf({ ...J, results: [ok(["task", "value", "exact"])], review: { votes: "1/3", violations: [] } });
    assert.equal(r.tier, "passed-checks");
    assert.match(r.reason!, /1\/3/);
    assert.equal(tierOf({ ...J, results: [ok(["task", "value", "exact"])], review: { votes: "0/3", violations: [] } }).tier, "verified");
  });
  it("says it in one phrase", () => {
    assert.equal(passedChecksWords("no check asserted an expected value"), "passed its checks (not verified: no check asserted an expected value)");
  });
});

describe("the tier in a turn", () => {
  const TASK = "Write out.txt containing exactly the word hello.";
  const make = (tags: string[], run: string, hidden = true): Check =>
    ({
      name: "made", kind: "command", run, timeoutMs: 5_000, expectExit: 0, tags,
      // Hidden ones as a separate judge model (not the worker "m") drafted them.
      ...(hidden ? { hidden: true, author: { kind: "judge", model: "judge-j" } } : {}),
    }) as Check;
  const SURFACE = make(["task", "surface"], "test -f out.txt");
  const RUNS = make(["task"], "test -s out.txt");
  const VALUE = make(["task", "value", "exact"], `grep -qx hello out.txt`);
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
    // "runs+exact" only with the exact-value rule on (opt-in, MAAT_REQUIRE_EXACT=1).
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
