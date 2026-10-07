/**
 * Judgment: the claims the scale could not settle go to the person.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { draftCriteria } from "../src/criteria.js";
import { parseBar } from "../src/bar.js";
import { cmdJudge, type JudgeIO } from "../src/judge-cli.js";
import { Judgments, caseReason, sendBackPrompt, type OpenCase } from "../src/judgment.js";
import type { Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const check = (name: string, run: string, hidden: boolean): Check => ({
  name,
  kind: "command",
  run,
  timeoutMs: 5_000,
  expectExit: 0,
  tags: ["task", "value"],
  ...(hidden ? { hidden: true, author: { kind: "judge", model: "judge-j" } } : {}),
});

const writesThenClaims = () => [
  { calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] }, { text: "Done." },
  { calls: [{ name: "write_file", args: { path: "a.txt", content: "2" } }] }, { text: "Done." },
  { calls: [{ name: "write_file", args: { path: "a.txt", content: "3" } }] }, { text: "Done." },
  { calls: [{ name: "write_file", args: { path: "a.txt", content: "4" } }] }, { text: "Done." },
];

function engineIn(dir: string, turns: Parameters<typeof scriptedProvider>[0], extra: Record<string, unknown> = {}): Engine {
  const provider = scriptedProvider(turns);
  return new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", ...extra });
}

async function jobEnd(engine: Engine, task: string, taskChecks: Check[] = []) {
  const events = await drain(engine.run(task, allowAll, { taskChecks }));
  const end = events.find((e) => e.kind === "job_end");
  assert.ok(end && end.kind === "job_end");
  return { end, events };
}

describe("which jobs open a case", () => {
  it("refused only by Maat's drafted checks: a case, with the check, its output and the files", async () => {
    const ws = workspace();
    try {
      const { end, events } = await jobEnd(engineIn(ws.dir, writesThenClaims(), { receipts: new Receipts(ws.dir) }), "make a", [check("never", "echo looked at a.txt; false", true)]);
      assert.equal(end.outcome, "unverified");
      assert.equal(end.case, 1);
      assert.ok(events.some((e) => e.kind === "info" && /awaiting your judgment: case 1/.test(e.text)));
      const [c] = new Judgments(ws.dir).pending();
      assert.equal(c!.reason, "drafted checks disagree");
      assert.equal(c!.task, "make a");
      assert.deepEqual(c!.files, ["a.txt"]);
      assert.equal(c!.checks[0]!.name, "task:never");
      assert.equal(c!.checks[0]!.drafted, true);
      assert.match(c!.checks[0]!.output, /looked at a\.txt/);
      assert.ok(c!.receipt && !c!.receipt.startsWith("/"), "the receipt is project-relative");
      assert.ok(existsSync(join(ws.dir, c!.receipt!)), "and it is really there");
    } finally {
      ws.cleanup();
    }
  });

  it("refused by a check a person wrote: not proven, and the check is theirs", async () => {
    const ws = workspace();
    try {
      const { end } = await jobEnd(engineIn(ws.dir, writesThenClaims()), "make a", [check("mine", "false", false)]);
      assert.equal(end.outcome, "not proven");
      const [c] = new Judgments(ws.dir).pending();
      assert.equal(c!.reason, "not proven");
      assert.equal(c!.checks[0]!.drafted, false);
    } finally {
      ws.cleanup();
    }
  });

  it("verified: the scale settled it, no case", async () => {
    const ws = workspace();
    try {
      const { end } = await jobEnd(engineIn(ws.dir, writesThenClaims()), "make a", [check("fine", "true", true)]);
      assert.equal(end.outcome, "verified");
      assert.equal(end.case, undefined);
      assert.equal(new Judgments(ws.dir).all().length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it("an unchecked answer that wrote nothing is not work to judge", async () => {
    const ws = workspace();
    try {
      const { end } = await jobEnd(engineIn(ws.dir, [{ text: "It is 4." }]), "what is 2+2?");
      assert.equal(end.outcome, "unverified");
      assert.equal(end.case, undefined);
      assert.equal(new Judgments(ws.dir).all().length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it("a question asked without '?', refused only because nothing changed, opens no case", async () => {
    const ws = workspace();
    try {
      const bar = parseBar("version: 1\nchecks:\n  - name: work-landed\n    builtin: files-changed\n");
      const { end } = await jobEnd(engineIn(ws.dir, [{ text: "It reads the config and prints it." }], { bar }), "what does main.py do");
      assert.equal(end.outcome, "not proven");
      assert.equal(end.case, undefined);
      assert.equal(new Judgments(ws.dir).all().length, 0);
    } finally {
      ws.cleanup();
    }
  });

  it("work that nothing could check opens a case", async () => {
    const ws = workspace();
    try {
      const { end } = await jobEnd(engineIn(ws.dir, [{ calls: [{ name: "write_file", args: { path: "b.txt", content: "x" } }] }, { text: "Done." }]), "make b");
      assert.equal(end.outcome, "unverified");
      assert.equal(new Judgments(ws.dir).get(end.case!)!.reason, "nothing checked it");
    } finally {
      ws.cleanup();
    }
  });

  it("judgment: false opens nothing (benchmarks, where no person will rule)", async () => {
    const ws = workspace();
    try {
      const { end } = await jobEnd(engineIn(ws.dir, writesThenClaims(), { judgment: false }), "make a", [check("never", "false", true)]);
      assert.equal(end.case, undefined);
      assert.equal(existsSync(join(ws.dir, ".maat", "judgment.jsonl")), false);
    } finally {
      ws.cleanup();
    }
  });

  it("caseReason covers the dissenting review and leaves settled jobs alone", () => {
    assert.equal(caseReason({ outcome: "verified", review: { confirmed: false }, wrote: true }), "reviewers disagree");
    assert.equal(caseReason({ outcome: "verified", review: { confirmed: true }, wrote: true }), null);
    assert.equal(caseReason({ outcome: "unverified", wrote: true, allRetired: true }), "checks retired");
    for (const outcome of ["answered", "cancelled", "error", "stopped"] as const) assert.equal(caseReason({ outcome, wrote: true }), null, outcome);
    // A question asked without the "?": refused only because nothing changed. No case.
    assert.equal(caseReason({ outcome: "not proven", wrote: false, onlyNothingChanged: true }), null);
    assert.equal(caseReason({ outcome: "not proven", wrote: true, onlyNothingChanged: true }), "not proven", "work that was written is still judged");
  });
});

const base = (over: Partial<OpenCase> = {}): OpenCase => ({
  job: 1,
  task: "clean the csv",
  outcome: "unverified",
  reason: "drafted checks disagree",
  checks: [{ name: "task:rows", detail: "python3 count.py", output: "expected 12 rows, got 10", drafted: true }],
  files: ["clean.csv"],
  ...over,
});

describe("the judgment record", () => {
  it("rulings close cases; the last ruling stands; the record keeps every one", () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      const a = j.open(base());
      const b = j.open(base({ task: "second" }));
      assert.deepEqual(j.pending().map((c) => c.n), [a.n, b.n], "oldest first: the order to judge in");
      j.rule(a.n, "sent back", { note: "rows 6 and 13 are duplicates" });
      j.rule(a.n, "accepted");
      const c = j.get(a.n)!;
      assert.equal(c.ruling!.ruling, "accepted");
      assert.equal(c.rulings.length, 2);
      assert.deepEqual(j.pending().map((x) => x.n), [b.n]);
      assert.throws(() => j.rule(99, "accepted"), /no case 99/);
    } finally {
      ws.cleanup();
    }
  });

  it("measures how often the warnings were true: sent back ÷ ruled", () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      assert.equal(j.stats().warningsTrue, null, "unknown until a person rules");
      for (let i = 0; i < 4; i++) j.open(base());
      j.open(base({ reason: "not proven" }));
      j.rule(1, "accepted");
      j.rule(2, "check wrong");
      j.rule(3, "sent back");
      j.rule(5, "sent back");
      const s = j.stats();
      assert.equal(s.ruled, 4);
      assert.equal(s.pending, 1);
      assert.equal(s.warningsTrue, 0.5);
      assert.deepEqual(s.byReason["drafted checks disagree"], { ruled: 3, sentBack: 1 });
      assert.deepEqual(s.byReason["not proven"], { ruled: 1, sentBack: 1 });
    } finally {
      ws.cleanup();
    }
  });

  it("lessons for the drafter: only drafted checks ruled wrong, newest first", () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      j.open(base({ checks: [{ name: "task:rows", detail: "python3 count.py", output: "", drafted: true }] }));
      j.open(base({ reason: "not proven", checks: [{ name: "tests", detail: "pytest", output: "", drafted: false }] }));
      j.open(base({ task: "fix dates", checks: [{ name: "task:iso", detail: "grep -c T out.txt", output: "", drafted: true }] }));
      j.rule(1, "check wrong", { note: "it counted before de-duplicating" });
      j.rule(2, "check wrong");
      j.rule(3, "sent back");
      const l = j.lessons();
      assert.equal(l.length, 1);
      assert.match(l[0]!, /task:rows \(python3 count\.py\) refused work that was right — the person said: "it counted before de-duplicating"/);
    } finally {
      ws.cleanup();
    }
  });

  it("is hash-chained: an edited line is found", () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      j.open(base());
      j.open(base());
      j.rule(1, "accepted");
      assert.deepEqual(j.verify(), { ok: true, lines: 3 });
      const p = j.path;
      writeFileSync(p, readFileSync(p, "utf8").replace('"accepted"', '"sent back"'));
      assert.deepEqual(j.verify(), { ok: false, lines: 3, brokeAt: 3 });
    } finally {
      ws.cleanup();
    }
  });

  it("redacts secrets in the task and in check output", () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      j.open(base({ task: "deploy with key sk-abcdefghij1234567890XYZ", checks: [{ name: "x", detail: "y", output: "Authorization: Bearer sk-abcdefghij1234567890XYZ", drafted: true }] }));
      const raw = readFileSync(j.path, "utf8");
      assert.ok(!raw.includes("sk-abcdefghij1234567890XYZ"));
    } finally {
      ws.cleanup();
    }
  });

  it("a sent-back case becomes the next task, with the person's words", () => {
    const p = sendBackPrompt({ ...base(), type: "case", n: 1, iso: "" }, "rows 6 and 13 are duplicates");
    assert.match(p, /sent it back: rows 6 and 13 are duplicates/);
    assert.match(p, /The task was: clean the csv/);
  });
});

function io(answers: string[] = []): JudgeIO & { text: () => string; errText: () => string } {
  let out = "";
  let err = "";
  return {
    out: (s) => void (out += s),
    err: (s) => void (err += s),
    ask: answers.length ? async () => answers.shift() ?? null : undefined,
    text: () => out,
    errText: () => err,
  };
}

describe("maat judge", () => {
  it("lists, shows, rules and counts", async () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      j.open(base());
      j.open(base({ task: "second task" }));
      let t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "list" }, t), 0);
      assert.match(t.text(), /2 awaiting your judgment/);
      assert.match(t.text(), /Maat's own drafted checks disagreed/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "show 1" }, t), 0);
      assert.match(t.text(), /expected 12 rows, got 10/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "back 1", notes: ["dupes kept"] }, t), 0);
      assert.match(t.text(), /sent back — the work is wrong/);
      assert.match(t.text(), /maat judge prompt 1/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "prompt 1" }, t), 0);
      assert.match(t.text(), /sent it back: dupes kept/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "check 2" }, t), 0);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "stats" }, t), 0);
      assert.match(t.text(), /true 50% of the time \(1 sent back of 2\)/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "list" }, t), 0);
      assert.match(t.text(), /nothing awaits your judgment/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "verify" }, t), 0);
      assert.match(t.text(), /intact · 4 line/);
      // The rulings are in the session journal too.
      const logs = readFileSync(join(ws.dir, ".maat", "log", (await import("node:fs")).readdirSync(join(ws.dir, ".maat", "log"))[0]!), "utf8");
      assert.match(logs, /"kind":"judgment"/);
    } finally {
      ws.cleanup();
    }
  });

  it("bad input is refused with exit 2", async () => {
    const ws = workspace();
    try {
      let t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "accept 4" }, t), 2);
      assert.match(t.errText(), /no case 4/);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "show" }, t), 2);
      t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir, task: "bless 1" }, t), 2);
      assert.match(t.errText(), /unknown judge command/);
    } finally {
      ws.cleanup();
    }
  });

  it("interactive: one case at a time, oldest first; q stops and keeps the rest", async () => {
    const ws = workspace();
    try {
      const j = new Judgments(ws.dir);
      j.open(base());
      j.open(base({ task: "second" }));
      j.open(base({ task: "third" }));
      const t = io(["v", "a", "", "s", "the dates are wrong", "q"]);
      assert.equal(await cmdJudge({ cwd: ws.dir }, t), 0);
      assert.equal(j.get(1)!.ruling!.ruling, "accepted");
      assert.equal(j.get(2)!.ruling!.ruling, "sent back");
      assert.equal(j.get(2)!.ruling!.note, "the dates are wrong");
      assert.equal(j.get(3)!.ruling, undefined);
      assert.match(t.text(), /2 ruled · 1 still awaiting judgment/);
    } finally {
      ws.cleanup();
    }
  });

  it("piped (no way to ask): lists instead of waiting", async () => {
    const ws = workspace();
    try {
      new Judgments(ws.dir).open(base());
      const t = io();
      assert.equal(await cmdJudge({ cwd: ws.dir }, t), 0);
      assert.match(t.text(), /1 awaiting your judgment/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("the drafter learns from 'the check was wrong'", () => {
  it("lessons reach the drafting prompt", async () => {
    let body = "";
    const fetchFn = (async (_u: string, init?: RequestInit) => {
      body = String(init?.body ?? "");
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ checks: [], notes: [] }) }, finish_reason: "stop" }] }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    await draftCriteria({
      task: "clean the csv",
      scripts: [],
      barChecks: [],
      baseUrl: "http://p.test/v1",
      model: "m",
      fetchFn,
      lessons: ['For "clean", the check task:rows (python3 count.py) refused work that was right'],
    });
    assert.match(body, /A person ruled these earlier drafted checks wrong in this project/);
    assert.match(body, /task:rows \(python3 count\.py\) refused work that was right/);
  });
});
