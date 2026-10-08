/**
 * With the exact-value rule on (opt-in, MAAT_REQUIRE_EXACT=1), "verified"
 * needs a passing independent check that compares the work's output with an
 * EXACT expected value (src/tiers.ts assertsExact).
 *
 * On a 2026-10-07 bench lane (a worker model checked by a judge model) cron-next
 * was labelled verified on four judge checks that all tested properties: 8
 * lines, each minute a multiple of 15, sorted, unique; "every date is the 13th
 * or a Friday"; two runs agree; "starts with 2024-06-1". The grader asked for
 * `*\/15 * * * *` from 2025-01-01 00:07 and got 00:45, 01:00, 01:45 instead of
 * 00:15, 00:30, 00:45: wrong output with the right shape passes all four.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CRITERIA_MAX_EXPECT, CRITIC_SYSTEM, DRAFT_SYSTEM, DRAFT_SYSTEM_EXACT, criticPrompt, draftSystem, sanitizeCriteria, taskChecksFrom } from "../src/criteria.js";
import { AUDIT_SYSTEM, AUDIT_SYSTEM_EXACT, auditGates, auditSystem, parseAuditChecks } from "../src/post-audit.js";
import { assertsExact, assertsValue, exactRuleOn, passedChecksWords, PROPERTY_ONLY_REASON, tierOf } from "../src/tiers.js";
import type { CheckAuthor } from "../src/types.js";
import { cannotFail } from "../src/checklint.js";

/** The four judge checks the cron-next run passed, verbatim from its receipt. */
const CRON_NEXT = [
  `cd "$PWD" && a=$(python3 nextrun.py '0 12 * * 7' '2024-01-01 00:00' 5) && b=$(python3 nextrun.py '0 12 * * 0' '2024-01-01 00:00' 5) && [ -n "$a" ] && [ "$a" = "$b" ] && echo "$a" | wc -l | grep -qx ' *5'`,
  `cd "$PWD" && python3 nextrun.py '0 0 13 * 5' '2024-01-01 00:00' 6 | python3 -c "import sys,datetime as d; ls=sys.stdin.read().splitlines(); assert len(ls)==6; ds=[d.datetime.strptime(l,'%Y-%m-%d %H:%M') for l in ls]; assert all(x.day==13 or x.weekday()==4 for x in ds); assert all(a<b for a,b in zip(ds,ds[1:])); assert ds[0]>d.datetime(2024,1,1)"`,
  `cd "$PWD" && python3 nextrun.py '30 14 * * *' '2024-06-15 14:30' 1 | python3 -c "import sys; l=sys.stdin.read().splitlines(); assert len(l)==1 and l[0]!='2024-06-15 14:30' and l[0].startswith('2024-06-1') and l[0].endswith(' 14:30')"`,
  `python3 -c "import subprocess;o=subprocess.run(['python3','nextrun.py','*/15 * * * *','2024-01-01 00:00','8'],capture_output=True,text=True);L=o.stdout.split('\\n')[:-1];assert o.returncode==0 and len(L)==8;assert all(int(l[-2:])%15==0 for l in L);assert L==sorted(set(L))"`,
];

const EXACT = [
  // the cron-next requirement, checked exactly
  `python3 nextrun.py '*/15 * * * *' '2025-01-01 00:07' 3 | diff - <(printf '2025-01-01 00:15\\n2025-01-01 00:30\\n2025-01-01 00:45\\n')`,
  `python3 nextrun.py '*/15 * * * *' '2025-01-01 00:07' 3 | diff - <<'EOF'\n2025-01-01 00:15\n2025-01-01 00:30\n2025-01-01 00:45\nEOF`,
  `python3 nextrun.py '*/15 * * * *' '2025-01-01 00:07' 1 | grep -qx '2025-01-01 00:15'`,
  `python3 -c "import subprocess;o=subprocess.run(['python3','nextrun.py','*/15 * * * *','2025-01-01 00:07','3'],capture_output=True,text=True);assert o.stdout.split()[1::2]==['00:15','00:30','00:45'], o.stdout"`,
  `[ "$(python3 nextrun.py '0 9 * * *' '2023-01-01 08:00' 1)" = "2023-01-01 09:00" ]`,
  // a specific worked-out value found in what the program printed on literal input
  `python3 nextrun.py '0 9 * * *' '2023-01-01 08:00' 1 | grep -q '2023-01-01 09:00'`,
  // equality with a literal, in each language and helper
  `python3 -c "import slug; assert slug.slugify('Hello World') == 'hello-world'"`,
  `python3 -c "import sys, tool; sys.exit(0 if tool.f('a')==['a'] else 1)"`,
  `node -e "const a=require('assert'); a.strictEqual(require('./t').f(2), 4)"`,
  `node -e 'const g=require("./x")("a");if(g!=="b")throw new Error(g)'`,
  `curl -s localhost:8080/items/9 | jq -e '.error=="not found"'`,
  `python3 -c "import json; d=json.load(open('out.json')); assert d['total'] == 12, d"`,
  // both sides of a rule, from a literal table of cases (1.2.3.4.5 just outside the IP rule)
  `python3 -c "import ipcheck as m\ncases=[('1.2.3.4', True), ('1.2.3.4.5', False)]\nfor s, want in cases:\n    assert m.valid(s) == want, s"`,
  `python3 -c "import p; assert p.parse('bad') is None"`,
  // a specific error status the task names
  `d=$(mktemp -d); touch "$d/a.log"; out=$(./rotate.sh -n 0 "$d" 2>/dev/null); rc=$?; [ $rc -eq 2 ] && [ -z "$out" ]`,
  // inside bash -c
  `bash -c 'git rev-parse --abbrev-ref HEAD | grep -qx master'`,
  // an oracle: the expected value built from the task's input file, running nothing
  `python3 -c 'import json\nrows=json.load(open("in.json"))\nexp=[r["name"].upper() for r in rows]\nassert open("out.txt").read().splitlines()==exp'`,
];

const PROPERTY = [
  ...CRON_NEXT,
  // counts and sizes
  `[ $(wc -l < out.txt) -eq 365 ]`,
  `[ "$(grep -c '^ERROR' report.txt)" -eq 3 ]`,
  `test -f report.txt && wc -l < report.txt | grep -q '^10$'`,
  // a format, not a value
  `python3 wc.py /etc/passwd | grep -q '^[0-9]\\+ [0-9]\\+ [0-9]\\+ /etc/passwd$'`,
  // membership in a file, a prefix
  `head -n 1 clean.csv | grep -q 'id,name,email,age,city'`,
  `python3 -c "import t; assert t.f('x').startswith('ab')"`,
  // the same constant across every item
  `find configs/ -name '*.json' -exec sh -c 'jq -e ".version == 2" {} 2>/dev/null || exit 1' \\;`,
  `python3 -c "import json,glob,sys; sys.exit(any(json.load(open(f)).get('version')==1 for f in glob.glob('configs/*.json')))"`,
  // a check that cannot fail
  `python3 server.py 8081 & sleep 1; curl -s http://127.0.0.1:8081/items | jq -e '.[0].id == 1' || echo 'fail'`,
  `python3 -c "import pricing; print(pricing.price('item1', 2, 'SAVE10') == 18.0)"`,
  // exit statuses that only say it ran, or that are read only on the failing path
  `node summarize.js nonexistent.json 2>/dev/null || test $? -eq 1`,
  `python3 vsort.py < versions.txt; test $? -eq 0`,
  // an absent line
  `out=$(python3 nextrun.py '*/15 * * * *' '2024-01-01 00:00' 4); ! echo "$out" | grep -qx '2024-01-01 00:00'`,
  // two literals, nothing from the work
  `[ "$(echo 7)" = "7" ]`,
  // #46 review: a crash whose message repeats the input it was handed
  `python3 tool.py '2024-06-13' 2>&1 | grep -q '2024-06-13'`,
  `python3 nextrun.py '0 9 * * *' '2023-01-01 09:00' 1 | grep -q '2023-01-01 09:00'`,
  // a named constant compared across every item is still the same constant
  `python3 -c "import cron; out=cron.next('*/15 * * * *', 8); ok=True; assert len(out) == 8; assert all(cron.valid(t) == ok for t in out)"`,
  // asserts that can never fail
  `python3 -c "import tool; assert (tool.f('a') == 'x', 'msg')"`,
  `python3 -c "import tool; assert tool.f('a') == 'x' or True"`,
  `python3 -c "import tool; assert tool.f('a') == 'x' if False else True"`,
  `python3 -O -c "import tool; assert tool.f('a') == 'x'"`,
  `PYTHONOPTIMIZE=1 python3 -c "import tool; assert tool.f('a') == 'x'"`,
  // one trivial literal: any stub returns it, any crash exits with it
  `python3 -c "import tool; assert tool.f('a') == []"`,
  `python3 -c "import tool; assert tool.f('a') == False"`,
  `[ "$(python3 tool.py a)" = "" ]`,
  `python3 tool.py bad; rc=$?; [ $rc -eq 1 ]`,
];

describe("the exact tag", () => {
  for (const c of EXACT) it(`exact: ${c.split("\n")[0]!.slice(0, 110)}`, () => assert.equal(assertsExact(c), true, c));
  for (const c of PROPERTY) it(`property: ${c.split("\n")[0]!.slice(0, 110)}`, () => assert.equal(assertsExact(c), false, c));

  it("the cron-next checks still assert a value; none is exact", () => {
    for (const c of CRON_NEXT) assert.equal(assertsValue(c), true, c);
    const sealed = taskChecksFrom({ checks: CRON_NEXT.map((run, i) => ({ name: `c${i}`, run })), notes: [] }, { hidden: true });
    for (const t of sealed.taskChecks) assert.deepEqual(t.tags, ["task", "value"]);
  });

  it("asserts that can never fail are refused at seal time too (L16)", () => {
    for (const c of [
      `python3 -c "import tool; assert (tool.f('a') == 'x', 'msg')"`,
      `python3 -c "import tool; assert tool.f('a') == 'x' or True"`,
      `python3 -c "import tool; assert tool.f('a') == 'x' if False else True"`,
      `python3 -O -c "import tool; assert tool.f('a') == 'x'"`,
    ]) assert.ok(cannotFail(c), c);
    assert.equal(cannotFail(`python3 -c "import tool; assert (tool.f('a') == 'x'), 'msg'"`), null, "parenthesised condition, then a message");
  });

  it("is only ever tagged beside value", () => {
    const sealed = taskChecksFrom({ checks: [{ name: "e", run: EXACT[2]! }], notes: [] }, { hidden: true });
    assert.deepEqual(sealed.taskChecks[0]!.tags, ["task", "value", "exact"]);
  });
});

describe("tierOf: property checks do not earn verified", () => {
  const JUDGE: CheckAuthor = { kind: "judge", model: "judge-model" };
  const worker = "worker-model";
  const sealed = (runs: string[]) =>
    taskChecksFrom({ checks: runs.map((run, i) => ({ name: `task:c${i}`, run })), notes: [] }, { hidden: true, author: JUDGE }).taskChecks;
  const tier = (runs: string[], extra: Partial<Parameters<typeof tierOf>[0]> = {}) => {
    const checks = sealed(runs);
    return tierOf({
      results: checks.map((c) => ({ name: c.name, ok: true, hidden: true, kind: "command" as const, tags: c.tags })),
      worker,
      authors: new Map(checks.map((c) => [c.name, JUDGE])),
      failedBefore: new Set(checks.map((c) => c.name)),
      requireExact: true,
      ...extra,
    });
  };

  it("the mmhd cron-next run: four passing independent property checks, not verified", () => {
    const t = tier(CRON_NEXT);
    assert.equal(t.tier, "passed-checks");
    assert.equal(t.reason, PROPERTY_ONLY_REASON);
    assert.equal(t.reason, "passed checks that test properties only");
    assert.equal(t.evidence, "runs+value");
    assert.equal(passedChecksWords(t.reason), "passed its checks (not verified: passed checks that test properties only)");
  });

  it("the same, with discrimination required and in review-advisory mode", () => {
    assert.equal(tier(CRON_NEXT, { requireDiscriminating: true }).reason, PROPERTY_ONLY_REASON);
    assert.equal(tier(CRON_NEXT, { reviewAdvisory: true }).reason, PROPERTY_ONLY_REASON);
  });

  it("one exact check beside them earns the word", () => {
    const t = tier([...CRON_NEXT.slice(0, 3), EXACT[0]!]);
    assert.deepEqual([t.tier, t.evidence, t.basis], ["verified", "runs+exact", "independent"]);
  });

  it("an exact check that did not fail before the work is passed-untested under the gate, not property-only", () => {
    const checks = sealed([EXACT[0]!]);
    const t = tierOf({
      requireExact: true,
      requireDiscriminating: true,
      results: checks.map((c) => ({ name: c.name, ok: true, hidden: true, kind: "command" as const, tags: c.tags })),
      worker,
      authors: new Map(checks.map((c) => [c.name, JUDGE])),
      failedBefore: new Set(),
    });
    assert.equal(t.tier, "passed-untested");
  });

  it("the worker's own exact check is still its own", () => {
    const checks = sealed([EXACT[0]!]);
    const t = tierOf({ requireExact: true, results: checks.map((c) => ({ name: c.name, ok: true, hidden: true, kind: "command" as const, tags: c.tags })), worker, authors: new Map([[checks[0]!.name, { kind: "worker", model: worker } as CheckAuthor]]) });
    assert.equal(t.tier, "passed-own-checks");
  });

  it("is opt-in: without MAAT_REQUIRE_EXACT the property checks earn the word as before", () => {
    const saved = process.env.MAAT_REQUIRE_EXACT;
    delete process.env.MAAT_REQUIRE_EXACT;
    try {
      assert.equal(exactRuleOn(), false);
      const t = tier(CRON_NEXT, { requireExact: undefined });
      assert.deepEqual([t.tier, t.evidence], ["verified", "runs+value"]);
      process.env.MAAT_REQUIRE_EXACT = "1";
      assert.equal(exactRuleOn(), true);
      assert.equal(tier(CRON_NEXT, { requireExact: undefined }).reason, PROPERTY_ONLY_REASON);
    } finally {
      if (saved === undefined) delete process.env.MAAT_REQUIRE_EXACT;
      else process.env.MAAT_REQUIRE_EXACT = saved;
    }
  });
});

describe("the post-work audit drops property checks", () => {
  // The V gates run before anything touches a tree.
  const ctx = { workDir: "/nonexistent-work", preWorkDir: "/nonexistent-pre", mutants: [], requireExact: true };
  it("only with the exact rule on", async () => {
    const g = await auditGates({ name: "p", run: CRON_NEXT[0]!, quote: "the next N run times" }, { ...ctx, requireExact: false });
    assert.notEqual(g.rule, "V-property-only");
  });

  it("V-property-only, after V-no-value", async () => {
    for (const run of CRON_NEXT) {
      const g = await auditGates({ name: "p", run, quote: "the next N run times" }, ctx);
      assert.equal(g.rule, "V-property-only", run);
    }
  });
});

describe("the drafting prompts ask for exact expected outputs", () => {
  it("the drafter: an exact check per requirement, its source in expect, edge and near-miss inputs", () => {
    assert.match(DRAFT_SYSTEM_EXACT, /For each thing the task says the work must do, at least one check/);
    assert.match(DRAFT_SYSTEM_EXACT, /EXACT expected output/);
    assert.match(DRAFT_SYSTEM_EXACT, /"expect":"where the expected output comes from"/);
    assert.match(DRAFT_SYSTEM_EXACT, /the task words quoted, or the derivation/);
    assert.match(DRAFT_SYSTEM_EXACT, /1\.2\.3\.4\.5 for an IP rule/);
    assert.match(DRAFT_SYSTEM_EXACT, /empty input/);
    assert.match(DRAFT_SYSTEM_EXACT, /each side of an either\/or rule/);
    assert.match(DRAFT_SYSTEM_EXACT, /never instead of one/);
    assert.doesNotMatch(DRAFT_SYSTEM_EXACT, /Never write an expected value you worked out yourself/, "the old rule pushed drafters to property checks");
  });

  it("is opt-in: the default prompts are the ones before the exact rule", () => {
    assert.match(DRAFT_SYSTEM, /Never write an expected value you worked out yourself/);
    assert.doesNotMatch(DRAFT_SYSTEM, /EXACT expected output|"expect":/);
    assert.doesNotMatch(AUDIT_SYSTEM, /EXACT expected output|"expect":/);
    assert.equal(draftSystem(true), DRAFT_SYSTEM_EXACT);
    assert.equal(auditSystem(true), AUDIT_SYSTEM_EXACT);
    assert.equal(auditSystem(false), AUDIT_SYSTEM);
  });

  it("the critic sees where each expected value comes from, and is told a derivation is not a guess", () => {
    const p = criticPrompt("Print the next N cron times.", undefined, [
      { name: "step", run: EXACT[0]!, expect: "*/15 from 00:07: 00:15, 00:30, 00:45" },
      { name: "plain", run: "test -f nextrun.py" },
    ]);
    assert.match(p, /- step: .*\n {2}expect: \*\/15 from 00:07: 00:15, 00:30, 00:45\n- plain: test -f nextrun.py$/);
    assert.match(CRITIC_SYSTEM, /derived step by step from a rule the task states/);
  });

  it("sanitizeCriteria keeps expect, trimmed and capped, and drops a non-string one", () => {
    const d = sanitizeCriteria({ checks: [{ name: "a", run: "true", expect: `  ${"x".repeat(CRITERIA_MAX_EXPECT + 50)} ` }, { name: "b", run: "true", expect: 3 }], notes: [] });
    assert.equal(d.checks[0]!.expect!.length, CRITERIA_MAX_EXPECT);
    assert.equal("expect" in d.checks[1]!, false);
  });

  it("the post-work audit: exact comparisons, no count example, edge inputs, expect for a derivation", () => {
    assert.match(AUDIT_SYSTEM_EXACT, /the EXACT expected output/);
    assert.match(AUDIT_SYSTEM_EXACT, /such a\s+check is dropped/);
    assert.match(AUDIT_SYSTEM_EXACT, /1\.2\.3\.4\.5 for an IP rule/);
    assert.match(AUDIT_SYSTEM_EXACT, /each side of an either\/or rule/);
    assert.doesNotMatch(AUDIT_SYSTEM_EXACT, /grep -c/, "a count is not an example of an exact check");
    const task = "For input.txt the total is 7.";
    const p = parseAuditChecks(JSON.stringify({ checks: [{ name: "t", run: `[ "$(node sum.js input.txt)" = "7" ]`, quote: "the total is 7", expect: "stated" }] }), task)!;
    assert.deepEqual(p.kept, [{ name: "t", run: `[ "$(node sum.js input.txt)" = "7" ]`, quote: "the total is 7", expect: "stated" }]);
  });
});
