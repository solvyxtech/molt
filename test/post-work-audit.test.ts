/**
 * The post-work audit (`--post-work-audit`, src/post-audit.ts): checks an
 * independent judge drafts after the work, from the task text and the work's
 * interface only, each gated on the work, the pre-work copy and mutants of
 * the changed code.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { parseArgs } from "../src/cli.js";
import { Engine } from "../src/engine.js";
import { interfaceView, changedFiles, signatures } from "../src/interface-view.js";
import { Journal } from "../src/journal.js";
import { auditGates, changedLines, dataMutants, mutantCandidates, parseAuditChecks, planAuditMutants } from "../src/post-audit.js";
import { Receipts } from "../src/receipts.js";
import { auditClaim } from "../src/tiers.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace, type ScriptedTurn } from "./helpers.js";

const TASK =
  "Write sum.js so that `node sum.js FILE` prints the total of the numbers in FILE, one number per line, blank lines ignored.\n" +
  "For input.txt the total is 7.";
const SECRET = "ANSWER-IS-7";

const SUM_JS = [
  "const fs = require(\"fs\");",
  "function total(lines) {",
  "  let t = 0;",
  "  for (const l of lines) {",
  "    if (l.trim() !== \"\") t += Number(l);",
  "  }",
  "  return t;",
  "}",
  "if (process.argv[2] === \"--help\") {",
  "  console.log(\"usage: node sum.js FILE\");",
  "  process.exit(0);",
  "}",
  "const note = \"" + SECRET + "\";",
  "console.log(total(fs.readFileSync(process.argv[2], \"utf8\").split(\"\\n\")));",
  "",
].join("\n");

/** A pre-work tree and a work tree: input.txt before; sum.js, an answer-printing script and out.txt after. */
function trees(): { pre: string; work: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "maat-audit-test-"));
  const pre = join(root, "pre");
  const work = join(root, "work");
  mkdirSync(pre);
  writeFileSync(join(pre, "input.txt"), "3\n\n4\n");
  cpSync(pre, work, { recursive: true });
  writeFileSync(join(work, "sum.js"), SUM_JS);
  // Ignores --help and prints the answer: its output must never reach the view.
  writeFileSync(join(work, "show.js"), `console.log(${JSON.stringify(SECRET)});\n`);
  writeFileSync(join(work, "out.txt"), `7 ${SECRET}\n`);
  return { pre, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("the interface view", () => {
  let t: ReturnType<typeof trees>;
  before(() => {
    t = trees();
  });
  after(() => t.cleanup());

  it("names the new files, shows signatures and usage, and none of the outputs", async () => {
    const v = await interfaceView({ preWorkDir: t.pre, workDir: t.work });
    assert.deepEqual(changedFiles(t.pre, t.work).map((c) => `${c.path}:${c.status}`), ["out.txt:new", "show.js:new", "sum.js:new"]);
    assert.match(v.text, /Files the work added or changed: out\.txt \(new\), show\.js \(new\), sum\.js \(new\)/);
    assert.match(v.text, /function total\(lines\)/);
    assert.match(v.text, /run as: node sum\.js\n  `--help` prints:\n    usage: node sum\.js FILE/);
    assert.match(v.text, /run as: node show\.js  \(no usage text\)/, "an answer printed in reply to --help is not usage");
    assert.match(v.text, /out\.txt: text \(contents not shown\)/);
    assert.match(v.text, /Project files \(top level\): input\.txt out\.txt show\.js sum\.js/);
    assert.ok(!v.text.includes(SECRET), "no output, file content or constant of the work reaches the judge");
    assert.ok(!v.text.includes("t += Number"), "no function body");
  });

  it("signatures are declarations only", () => {
    assert.deepEqual(signatures("a.py", "import sys\ndef parse(line, strict=False):\n    return 42\nclass Row:\n    pass\np.add_argument('--port', type=int)\n"), [
      "def parse(line, strict=False)",
      "class Row",
      "p.add_argument('--port', type=int)",
    ]);
  });
});

describe("the judge's checks", () => {
  it("a check whose quote is not in the task is dropped; one with a verbatim quote is kept", () => {
    const reply = JSON.stringify({
      checks: [
        { name: "total", run: `[ "$(node sum.js input.txt)" = "7" ]`, quote: "For input.txt the total is 7." },
        { name: "guess", run: `[ "$(node sum.js input.txt)" = "8" ]`, quote: "the total for input.txt is 8" },
        { name: "unquoted", run: `[ "$(node sum.js input.txt)" = "7" ]` },
        { name: "tiny", run: `[ "$(node sum.js input.txt)" = "7" ]`, quote: "7." },
      ],
    });
    const p = parseAuditChecks(`\`\`\`json\n${reply}\n\`\`\``, TASK)!;
    assert.deepEqual(p.kept.map((c) => c.name), ["total"]);
    assert.deepEqual(p.dropped.map((d) => d.name), ["guess", "unquoted", "tiny"]);
    assert.match(p.dropped[0]!.why, /not in the task text/);
    assert.equal(parseAuditChecks("no json here", TASK), null);
    const bare = parseAuditChecks(`[{"name":"t","run":"[ \\"$(node sum.js input.txt)\\" = \\"7\\" ]","quote":"For input.txt the total is 7."}]`, TASK)!;
    assert.deepEqual(bare.kept.map((c) => c.name), ["t"], "a bare list of checks is read too");
  });
});

describe("mutants", () => {
  it("only the lines the work wrote are broken, and every mutant still parses", async () => {
    assert.deepEqual([...changedLines("a\nb\nc", "a\nB\nc\nd")], [2, 4]);
    const c = mutantCandidates("sum.js", SUM_JS);
    assert.ok(c.flip.some((m) => m.after.includes('l.trim() === ""')), "a comparison is flipped");
    assert.ok(c.nudge.some((m) => m.after.includes("let t = 1")), "a number is nudged");
    assert.ok(c.delete.length > 0, "a statement can be deleted");
    const plan = await planAuditMutants([{ path: "sum.js", text: SUM_JS }]);
    assert.ok(plan.length >= 3 && plan.length <= 5, `3-5 mutants, got ${plan.length}`);
    assert.equal(new Set(plan.map((m) => m.text)).size, plan.length);
    const py = mutantCandidates("f.py", "def f(x):\n    if x > 3:\n        return 1\n    else:\n        return 2\n");
    assert.ok(py.swap.some((m) => m.text.includes("if x > 3:\n        return 2\n    else:\n        return 1")), "if/else bodies swapped");
    assert.equal(mutantCandidates("f.py", "x = 1\n", "x = 1\n").nudge.length, 0, "an unchanged line is left alone");
    const cfg = dataMutants("c.json", '{\n  "version": 2,\n  "name": "api"\n}\n', '{\n  "name": "api"\n}\n');
    assert.deepEqual(cfg.nudge.map((m) => m.after), ['  "version": 3,'], "a data deliverable's changed number is nudged");
    const planned = await planAuditMutants([{ path: "c.json", text: '{\n  "version": 2,\n  "name": "api"\n}\n', before: '{\n  "name": "api"\n}\n' }]);
    assert.ok(planned.every((m) => { try { JSON.parse(m.text); return true; } catch { return false; } }), "a JSON mutant that no longer parses is not used");
    assert.ok(planned.length >= 1);
    const mixed = await planAuditMutants([{ path: "out.csv", text: "a,1\nb,2\n" }, { path: "sum.js", text: SUM_JS }]);
    assert.ok(mixed.length > 0 && mixed.every((m) => m.path === "sum.js"), "when code changed, an output file it wrote is not what gets broken");
  });
});

describe("the gates", () => {
  let t: ReturnType<typeof trees>;
  before(() => {
    t = trees();
  });
  after(() => t.cleanup());

  it("a check that passes on every mutant is rejected", async () => {
    const mutants = await planAuditMutants([{ path: "sum.js", text: SUM_JS }]);
    const g = await auditGates(
      { name: "exists", run: `[ "$(test -f sum.js && echo yes)" = "yes" ]`, quote: "For input.txt the total is 7." },
      { workDir: t.work, preWorkDir: t.pre, mutants },
    );
    assert.equal(g.accepted, false);
    assert.equal(g.rule, "C-passes-every-mutant");
    assert.deepEqual([g.work, g.preWork], ["pass", "failed"], "it cleared (a) and (b) and still does not show the code works");
  });

  it("a check that passes on the work, fails before it and fails on a mutant is accepted", async () => {
    const mutants = await planAuditMutants([{ path: "sum.js", text: SUM_JS }]);
    const g = await auditGates(
      { name: "total", run: `[ "$(node sum.js input.txt)" = "7" ]`, quote: "For input.txt the total is 7." },
      { workDir: t.work, preWorkDir: t.pre, mutants },
    );
    assert.equal(g.accepted, true, g.why);
    assert.ok(g.mutants!.killed >= 1);
    assert.ok(g.mutants!.survived < g.mutants!.total);
  });

  it("a check that passes before the work, cannot fail, writes, or asserts nothing is rejected before the mutants", async () => {
    const ctx = { workDir: t.work, preWorkDir: t.pre, mutants: [] };
    const q = "For input.txt the total is 7.";
    assert.equal((await auditGates({ name: "a", run: `[ "$(head -1 input.txt)" = "3" ]`, quote: q }, ctx)).rule, "P1-passes-before-work");
    assert.equal((await auditGates({ name: "a2", run: `[ "$(cat input.txt | wc -l | tr -d ' ')" = "3" ]`, quote: q }, ctx)).rule, "V-property-only", "a count is a property");
    assert.equal((await auditGates({ name: "b", run: `[ "$(node sum.js input.txt)" = "7" ] || echo fail`, quote: q }, ctx)).rule, "L16-cannot-fail");
    assert.equal((await auditGates({ name: "c", run: `node sum.js input.txt > out.txt && grep -qx 7 out.txt`, quote: q }, ctx)).rule, "L15-mutates");
    assert.equal((await auditGates({ name: "d", run: `node sum.js input.txt`, quote: q }, ctx)).rule, "V-no-value");
    assert.equal((await auditGates({ name: "e", run: `[ "$(node sum.js input.txt)" = "8" ]`, quote: q }, ctx)).rule, "A-fails-on-work");
  });
});

describe("the audit in a turn", () => {
  const work: ScriptedTurn[] = [
    { calls: [{ name: "write_file", args: { path: "sum.js", content: SUM_JS } }] },
    { text: `Done. The total is 7 and the note says ${SECRET}.` },
  ];
  // The worker's own check: it passes, and earns "passed own checks", not "verified".
  const own: Check = { name: "runs", kind: "command", run: `[ "$(node sum.js input.txt)" = "7" ]`, timeoutMs: 5_000, expectExit: 0, tags: ["task", "value", "exact"], hidden: true, author: { kind: "worker", model: "m" } } as Check;
  const JUDGE_REPLY = JSON.stringify({
    checks: [
      { name: "total", run: `[ "$(node sum.js input.txt)" = "7" ]`, quote: "For input.txt the total is 7." },
      { name: "made-up", run: `[ "$(node sum.js input.txt)" = "9" ]`, quote: "the total is 9" },
    ],
  });

  async function turn(postWorkAudit: boolean, judgeModel: string | null = "judge-x") {
    const ws = workspace();
    const was = process.env.MAAT_JUDGE_MODEL;
    if (judgeModel) process.env.MAAT_JUDGE_MODEL = judgeModel;
    else delete process.env.MAAT_JUDGE_MODEL;
    try {
      writeFileSync(join(ws.dir, "input.txt"), "3\n\n4\n");
      const provider = scriptedProvider(work);
      const judgePrompts: string[] = [];
      const fetchFn = (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string; messages?: { content?: string }[] };
        if (judgeModel && body.model === judgeModel) {
          judgePrompts.push((body.messages ?? []).map((m) => m.content ?? "").join("\n"));
          return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JUDGE_REPLY }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
        }
        return provider.fetchFn(url, init);
      }) as typeof fetch;
      const journal = new Journal(ws.dir, "audit");
      const engine = new Engine({
        baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn, bar: null,
        receipts: new Receipts(ws.dir), stream: false, autonomy: "high", journal,
        ...(postWorkAudit ? { postWorkAudit: true } : {}),
      });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [own], taskNotes: [] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      const rows = readFileSync(join(ws.dir, ".maat", "receipts", "index.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const notes = Journal.read(journal.path).filter((e) => e.kind === "note" && e.data.kind === "post-work-audit");
      return { end, events, rows, notes, judgePrompts };
    } finally {
      if (was === undefined) delete process.env.MAAT_JUDGE_MODEL;
      else process.env.MAAT_JUDGE_MODEL = was;
      ws.cleanup();
    }
  }

  it("an unverified claim earns verified (post-work audit: judge) from a check that clears every gate", async () => {
    const { end, rows, notes, judgePrompts } = await turn(true);
    assert.deepEqual([end.outcome, end.tier, end.claim], ["verified", "verified-audit", auditClaim("judge-x")]);
    assert.equal(end.claim, "verified (post-work audit: judge-x)");
    assert.deepEqual(end.audit, { judge: "judge-x", drafted: 2, grounded: 1, accepted: ["audit:total"] });
    assert.deepEqual([rows.at(-1).tier, rows.at(-1).claim], ["verified-audit", "verified (post-work audit: judge-x)"]);
    const checks = notes[0]!.data.checks as { name: string; accepted: boolean; preWork?: string; mutantsKilled?: number }[];
    assert.deepEqual(checks.map((c) => [c.name, c.accepted, c.preWork]), [["audit:total", true, "failed"]]);
    assert.ok(checks[0]!.mutantsKilled! >= 1);
    assert.equal(judgePrompts.length, 1);
    assert.ok(judgePrompts[0]!.includes("For input.txt the total is 7."), "the judge reads the task");
    assert.ok(judgePrompts[0]!.includes("sum.js (new)"), "and the interface");
    assert.ok(!judgePrompts[0]!.includes(SECRET), "never the worker's claim or the work's contents");
    assert.ok(!judgePrompts[0]!.includes("Done."), "never the transcript");
  });

  it("with the flag off nothing changes: no audit, no judge request, the tier is the sealed checks'", async () => {
    const { end, notes, judgePrompts } = await turn(false);
    assert.deepEqual([end.outcome, end.tier], ["unverified", "passed-own-checks"]);
    assert.equal(end.audit, undefined);
    assert.equal(notes.length, 0);
    assert.equal(judgePrompts.length, 0);
  });

  it("with no judge apart from the worker, the audit is skipped and the tier stands", async () => {
    const { end, notes } = await turn(true, null);
    assert.deepEqual([end.outcome, end.tier, end.audit], ["unverified", "passed-own-checks", undefined]);
    assert.match(String(notes[0]!.data.text), /skipped: the judge \(m\) is the worker model/);
  });
});

describe("parseArgs --post-work-audit", () => {
  it("is off unless asked for", () => {
    assert.equal(parseArgs([]).postWorkAudit, undefined);
    assert.equal(parseArgs(["--post-work-audit"]).postWorkAudit, true);
  });
});
