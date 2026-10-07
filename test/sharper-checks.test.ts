/**
 * Sharper checks: a wrong drafted check can be disputed, a check's leftovers
 * are cleaned up, and a draft is read cold by a critic before it is sealed.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { formatBarFailure } from "../src/bar.js";
import { applyCritique, checkSelfError, draftCriteria, draftCriteriaCritiqued, repairEscapes, taskChecksFrom } from "../src/criteria.js";
import { arbitrate, parseDisputes, quotedIn } from "../src/dispute.js";
import { Engine } from "../src/engine.js";
import type { BarResult, Check } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const TASK = "Write out.txt containing a greeting. Valid for 365 days.";

function replying(texts: string[]): { fetchFn: typeof fetch; calls: () => number; bodies: string[] } {
  let i = 0;
  const bodies: string[] = [];
  const fetchFn = (async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(String(init?.body ?? ""));
    const content = texts[Math.min(i++, texts.length - 1)]!;
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content }, finish_reason: "stop" }] }), text: async () => "" } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => i, bodies };
}

describe("disputes", () => {
  it("are read from a reply, one per check, in the documented shape", () => {
    const ds = parseDisputes(
      'Done.\nDISPUTE cert-valid: "Valid for 365 days" — the check wants 366\n- DISPUTE `task:other`: “a greeting” — too strict\nDISPUTE cert-valid: "x" — twice',
    );
    assert.deepEqual(ds.map((d) => [d.name, d.quote]), [["cert-valid", "Valid for 365 days"], ["other", "a greeting"]]);
    assert.equal(ds[0]!.why, "the check wants 366");
    assert.deepEqual(parseDisputes("I dispute nothing here"), []);
    assert.ok(quotedIn("valid  FOR 365 days", TASK));
    assert.ok(!quotedIn("valid for 366 days", TASK));
  });

  it("are upheld only by a majority that quotes the task", async () => {
    const yes = JSON.stringify({ contradicts: true, quote: "Valid for 365 days", reason: "asks for more than a year" });
    const invented = JSON.stringify({ contradicts: true, quote: "valid for at least a year", reason: "x" });
    const no = JSON.stringify({ contradicts: false, quote: "", reason: "fair reading" });
    const base = { task: TASK, check: { name: "c", run: "openssl x509 -checkend 31536000" }, output: "Certificate will expire", dispute: { name: "c", quote: "Valid for 365 days", why: "" } };
    const up = await arbitrate({ ...base, votes: 3, ask: { baseUrl: "http://p.test/v1", model: "m", fetchFn: replying([yes, yes, no]).fetchFn } });
    assert.deepEqual([up!.upheld, up!.votes, up!.quote], [true, "2/3", "Valid for 365 days"]);
    const down = await arbitrate({ ...base, votes: 3, ask: { baseUrl: "http://p.test/v1", model: "m", fetchFn: replying([yes, no, no]).fetchFn } });
    assert.equal(down!.upheld, false);
    const ungrounded = await arbitrate({ ...base, ask: { baseUrl: "http://p.test/v1", model: "m", fetchFn: replying([invented]).fetchFn } });
    assert.equal(ungrounded!.upheld, false, "a quote that is not in the task cannot retire a check");
  });

  it("the refusal offers the dispute, and names what must never be changed, only for drafted checks", () => {
    const result = (hidden: boolean): BarResult => ({
      ok: false,
      durationMs: 1,
      results: [{ name: "task:c", kind: "command", detail: "x", ok: false, output: "no", durationMs: 1, exitCode: 1, ...(hidden ? { hidden: true } : {}) }],
    });
    assert.match(formatBarFailure(result(true), 1, 3), /DISPUTE <check name>: "<exact words from the task>"/);
    assert.match(formatBarFailure(result(true), 1, 3), /not \/bin\/sh or other\nsystem binaries, not site-packages/);
    assert.doesNotMatch(formatBarFailure(result(false), 1, 3), /DISPUTE/);
  });
});

describe("a disputed check, in a turn", () => {
  // An arbiter other than the worker: a same-model arbiter is skipped.
  const ARBITER = { model: "arbiter" };
  const checks: Check[] = [
    { name: "made", kind: "command", run: "head -c 5 out.txt | grep -qx hello", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true },
    { name: "too-strict", kind: "command", run: "grep -q 366 out.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden: true },
  ];

  it("an upheld dispute retires the check; the rest still judge the claim", async () => {
    const ws = workspace();
    try {
      const yes = JSON.stringify({ contradicts: true, quote: "Valid for 365 days", reason: "the task says 365" });
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello 365\n" } }] },
        { text: "Done." },
        { text: 'DISPUTE too-strict: "Valid for 365 days" — the check demands 366' },
        { text: yes },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", dispute: ARBITER });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "verified");
      assert.ok(events.some((e) => e.kind === "info" && /check too-strict retired \(1\/1 reviews\)/.test(e.text)));
      const starts = events.filter((e) => e.kind === "proof_start");
      assert.deepEqual(starts.at(-1)!.kind === "proof_start" && starts.at(-1)!.names, ["task:made"]);
      assert.equal(readFile(join(ws.dir, "out.txt")), "hello 365\n", "the work was not bent to the check");
    } finally {
      ws.cleanup();
    }
  });

  // Terminal-Bench pytorch-model-recovery: the one check that ran the model
  // was retired, "it loads, the weights match" was left, and that carried a
  // verified the grader failed on the first forward() call.
  it("retiring the checks that ran the work leaves a claim unverified when what remains only looks", async () => {
    const ws = workspace();
    try {
      const looks: Check[] = [{ ...checks[0]!, tags: ["task", "surface"] }, checks[1]!];
      const yes = JSON.stringify({ contradicts: true, quote: "Valid for 365 days", reason: "the task says 365" });
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello 365\n" } }] },
        { text: "Done." },
        { text: 'DISPUTE too-strict: "Valid for 365 days" — the check demands 366' },
        { text: yes },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", dispute: ARBITER });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: looks }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "unverified");
      assert.ok(events.some((e) => e.kind === "info" && /what is left only looks at it/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });

  it("the critic's surface reading reaches the sealed check as a tag", () => {
    const c = applyCritique(
      { checks: [{ name: "exists", run: "test -f out.txt" }, { name: "runs", run: "./tool in > out" }], notes: [] },
      JSON.stringify({ checks: [{ name: "exists", verdict: "surface", quote: "" }, { name: "runs", verdict: "runs", quote: "" }] }),
      TASK,
    )!;
    const sealed = taskChecksFrom({ checks: c.kept, notes: [] }, { hidden: true });
    assert.deepEqual(sealed.taskChecks.map((t) => t.tags), [["task", "surface"], ["task"]]);
  });

  it("revealOnStuck: a hidden check failing the same way twice is shown once, and the turn goes on", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello again\n" } }] },
        { text: "Done again." },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello 366\n" } }] },
        { text: "Fixed." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", revealOnStuck: true });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      assert.ok(events.some((e) => e.kind === "info" && /showing the model its command once/.test(e.text)));
      assert.ok(provider.bodies.some((b) => b.includes("too-strict: `grep -q 366 out.txt`")), "the command was shown");
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("with revealOnStuck: false (--no-reveal), the same repeat failure ends the turn", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello again\n" } }] },
        { text: "Done again." },
        { text: "unreached" },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", revealOnStuck: false });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      assert.ok(events.some((e) => e.kind === "info" && /failed in exactly the same way twice/.test(e.text)));
      assert.ok(!provider.bodies.some((b) => b.includes("grep -q 366")), "a hidden command leaked");
    } finally {
      ws.cleanup();
    }
  });

  it("one arbiter ask per dispute by default, and --dispute-votes raises it", async () => {
    const ws = workspace();
    try {
      const no = JSON.stringify({ contradicts: false, quote: "", reason: "fair" });
      const run = async (dispute: { model: string; votes?: number }) => {
        const asks = Array.from({ length: dispute.votes ?? 1 }, () => ({ text: no }));
        const provider = scriptedProvider([
          { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
          { text: "Done." },
          { text: 'DISPUTE too-strict: "Valid for 365 days" — wrong' },
          ...asks,
          { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello 366\n" } }] },
          { text: "Done now." },
        ]);
        const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", dispute });
        const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
        return events.find((e) => e.kind === "info" && /dispute of too-strict was rejected/.test(e.text));
      };
      const one = await run({ model: "arbiter" });
      assert.ok(one && one.kind === "info" && /\(0\/1 reviews/.test(one.text), "one ask");
      const three = await run({ model: "arbiter", votes: 3 });
      assert.ok(three && three.kind === "info" && /\(0\/3 reviews/.test(three.text), "configurable");
    } finally {
      ws.cleanup();
    }
  });

  it("a same-model arbiter is skipped: the dispute is rejected with the reason and no ask is made", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
        { text: 'DISPUTE too-strict: "Valid for 365 days" — the check demands 366' },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello 366\n" } }] },
        { text: "Done now." },
      ]);
      // No dispute config: the arbiter would be the worker (same baseUrl and model).
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      assert.ok(events.some((e) => e.kind === "info" && /dispute of too-strict was rejected: no independent arbiter/.test(e.text)));
      assert.ok(provider.bodies.some((b) => b.includes("no independent arbiter")), "the model is told why");
      assert.ok(!provider.bodies.some((b) => b.includes("You settle a disagreement")), "no arbiter ask went out");
      assert.ok(!events.some((e) => e.kind === "info" && /retired/.test(e.text)));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("a rejected dispute leaves the check standing and tells the model so", async () => {
    const ws = workspace();
    try {
      const no = JSON.stringify({ contradicts: false, quote: "", reason: "fair" });
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
        { text: 'DISPUTE too-strict: "Valid for 365 days" — wrong' },
        { text: no },
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello 366\n" } }] },
        { text: "Done now." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", dispute: ARBITER });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      assert.ok(events.some((e) => e.kind === "info" && /dispute of too-strict was rejected \(0\/1/.test(e.text)));
      assert.ok(provider.bodies.some((b) => b.includes("Your dispute of too-strict was rejected")));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end" && end.outcome === "verified");
    } finally {
      ws.cleanup();
    }
  });

  it("retiring every check leaves the claim unverified, never verified by nothing", async () => {
    const ws = workspace();
    try {
      const yes = JSON.stringify({ contradicts: true, quote: "Valid for 365 days", reason: "r" });
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
        { text: 'DISPUTE too-strict: "Valid for 365 days" — wrong' },
        { text: yes },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", dispute: ARBITER });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: [checks[1]!] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "unverified");
    } finally {
      ws.cleanup();
    }
  });
});

function readFile(p: string): string {
  return readFileSync(p, "utf8");
}

describe("what the checks leave behind", () => {
  const leaves: Check = { name: "builds", kind: "command", run: "mkdir -p bin && touch bin/cmain made.o && test -f keep.txt", timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden: true };
  const turn = () => [{ calls: [{ name: "write_file", args: { path: "keep.txt", content: "k\n" } }] }, { text: "Done." }];

  it("is removed in an unattended run, and nothing that existed before is touched", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "made.o.orig"), "mine");
      const provider = scriptedProvider(turn());
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high", unattended: true });
      const events = await drain(engine.run("make keep.txt", allowAll, { taskChecks: [leaves] }));
      assert.ok(!existsSync(join(ws.dir, "bin")) && !existsSync(join(ws.dir, "made.o")));
      assert.ok(existsSync(join(ws.dir, "keep.txt")) && existsSync(join(ws.dir, "made.o.orig")));
      assert.ok(events.some((e) => e.kind === "info" && /removed what the checks created in the project: .*made\.o/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });

  it("is left alone when a person is at the keyboard", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider(turn());
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      await drain(engine.run("make keep.txt", allowAll, { taskChecks: [leaves] }));
      assert.ok(existsSync(join(ws.dir, "made.o")));
    } finally {
      ws.cleanup();
    }
  });
});

describe("the check critic", () => {
  const draft = {
    checks: [
      { name: "exists", run: "test -f out.txt" },
      { name: "strict", run: "openssl x509 -checkend 31536000" },
      { name: "guess", run: "test \"$(cat r.txt)\" = GritLM" },
    ],
    notes: [],
  };
  const reply = (v: object[]) => JSON.stringify({ checks: v });

  it("drops invented and guessed checks only with a task quote, and sees a surface-only draft", () => {
    const c = applyCritique(draft, reply([
      { name: "exists", verdict: "surface", quote: "" },
      { name: "strict", verdict: "invents", quote: "Valid for 365 days" },
      { name: "guess", verdict: "guesses", quote: "the best model, as stated nowhere" },
    ]), TASK)!;
    assert.deepEqual(c.dropped.map((d) => d.name), ["strict"]);
    assert.deepEqual(c.kept.map((k) => k.name), ["exists", "guess"], "an ungrounded quote drops nothing");
    assert.equal(c.surfaceOnly, true, "what is kept only looks, or guesses — nothing kept was judged to run the deliverable");
    const s = applyCritique({ checks: [draft.checks[0]!], notes: [] }, reply([{ name: "exists", verdict: "surface", quote: "" }]), TASK)!;
    assert.equal(s.surfaceOnly, true);
    assert.equal(applyCritique(draft, "not json", TASK), null);
  });

  it("asks once more when nothing runs the deliverable, and keeps the redraft that does", async () => {
    const d1 = JSON.stringify({ checks: [{ name: "exists", run: "test -f out.txt" }], notes: [] });
    const c1 = reply([{ name: "exists", verdict: "surface", quote: "" }]);
    const d2 = JSON.stringify({ checks: [{ name: "greets", run: "python3 out.py | grep -q hello" }], notes: [] });
    const c2 = reply([{ name: "greets", verdict: "runs", quote: "" }]);
    const r = replying([d1, c1, d2, c2]);
    const out = await draftCriteriaCritiqued({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn: r.fetchFn });
    assert.ok(out.ok);
    assert.deepEqual(out.draft.checks.map((c) => c.name), ["greets"]);
    assert.ok(out.critique.some((l) => /a check now runs the deliverable/.test(l)));
    assert.equal(r.calls(), 4);
  });

  // Terminal-Bench dna-insert: "at most 5" degrees apart was stated, no check
  // tested it, and the grader failed the verified work on exactly that.
  it("adds a check for a stated requirement nothing tested, keeping the reviewed ones", async () => {
    const d1 = JSON.stringify({ checks: [{ name: "greets", run: "grep -q hello out.txt" }], notes: [] });
    const c1 = JSON.stringify({ checks: [{ name: "greets", verdict: "runs", quote: "" }], uncovered: ["Valid for 365 days", "never stated anywhere at all"] });
    const d2 = JSON.stringify({ checks: [{ name: "valid-365", run: "grep -q 365 out.txt" }], notes: [] });
    const c2 = reply([{ name: "valid-365", verdict: "runs", quote: "" }]);
    const r = replying([d1, c1, d2, c2]);
    const out = await draftCriteriaCritiqued({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn: r.fetchFn });
    assert.ok(out.ok);
    assert.deepEqual(out.draft.checks.map((c) => c.name), ["greets", "valid-365"]);
    assert.ok(out.critique.some((l) => /added valid-365 for what no check tested: "Valid for 365 days"$/.test(l)), out.critique.join("\n"));
    assert.ok(r.bodies.at(-2)?.includes("Nothing tests these stated requirements yet"));
  });

  it("an uncovered requirement the task never states asks for nothing", () => {
    const c = applyCritique(
      { checks: [{ name: "greets", run: "grep -q hello out.txt" }], notes: [] },
      JSON.stringify({ checks: [{ name: "greets", verdict: "runs", quote: "" }], uncovered: ["must finish in 2 seconds"] }),
      TASK,
    )!;
    assert.deepEqual(c.uncovered, []);
  });

  it("changes nothing when the critic cannot be read", async () => {
    const d1 = JSON.stringify({ checks: [{ name: "exists", run: "test -f out.txt" }], notes: [] });
    const out = await draftCriteriaCritiqued({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn: replying([d1, "no"]).fetchFn });
    assert.ok(out.ok);
    assert.deepEqual(out.draft.checks.map((c) => c.name), ["exists"]);
  });
});

describe("a draft that does not parse", () => {
  it("survives a shell backslash that is not a JSON escape", () => {
    const bad = '{"checks":[{"name":"a","run":"grep -q \'\\.\' x"}]}';
    assert.throws(() => JSON.parse(bad));
    assert.equal(JSON.parse(repairEscapes(bad)).checks[0].run, "grep -q '\\.' x");
    assert.equal(JSON.parse(repairEscapes('{"a":"x\\\\d \\"q\\""}')).a, 'x\\d "q"', "valid escapes are kept whole");
  });

  it("is asked for once more, and the second reply is used", async () => {
    const good = JSON.stringify({ checks: [{ name: "exists", run: "test -f out.txt" }], notes: [] });
    const r = replying(["Sure! Here are the checks you asked for.", good]);
    const out = await draftCriteria({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn: r.fetchFn });
    assert.ok(out.ok);
    assert.deepEqual(out.draft.checks.map((c) => c.name), ["exists"]);
    assert.equal(r.calls(), 2);
  });

  // Terminal-Bench db-wal-recovery / install-windows: two empty replies in a
  // row and the task ran with no checks; the same prompt drafted fine later.
  it("asks again after a pause when the replies came back empty", async () => {
    const good = JSON.stringify({ checks: [{ name: "exists", run: "test -f out.txt" }], notes: [] });
    const r = replying(["", "", "", good]);
    const out = await draftCriteria({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn: r.fetchFn, emptyRetryDelayMs: 1 });
    assert.ok(out.ok);
    assert.deepEqual(out.draft.checks.map((c) => c.name), ["exists"]);
    assert.equal(r.calls(), 4);
  });

  it("does not keep asking when the model answers with something that is not JSON", async () => {
    const r = replying(["prose", "more prose", "never asked"]);
    const out = await draftCriteria({ task: TASK, scripts: [], barChecks: [], baseUrl: "http://p.test/v1", model: "m", fetchFn: r.fetchFn, emptyRetryDelayMs: 1 });
    assert.ok(!out.ok);
    assert.equal(r.calls(), 2);
  });
});

describe("molt's own records in a git repository", () => {
  it("are excluded locally, once, and never through the project's .gitignore", async () => {
    const { excludeMoltFromGit } = await import("../src/leftovers.js");
    const { execFileSync } = await import("node:child_process");
    const { mkdirSync: mk } = await import("node:fs");
    const ws = workspace();
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: ws.dir });
      mk(join(ws.dir, ".maat"), { recursive: true });
      writeFileSync(join(ws.dir, ".maat", "x"), "y");
      assert.match(execFileSync("git", ["status", "--porcelain"], { cwd: ws.dir, encoding: "utf8" }), /\.maat/);
      assert.equal(excludeMoltFromGit(ws.dir), true);
      assert.equal(excludeMoltFromGit(ws.dir), false, "written once");
      assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: ws.dir, encoding: "utf8" }), "");
      assert.ok(!existsSync(join(ws.dir, ".gitignore")));
    } finally {
      ws.cleanup();
    }
  });

  it("is a no-op outside a repository", async () => {
    const { excludeMoltFromGit } = await import("../src/leftovers.js");
    const ws = workspace();
    try {
      assert.equal(excludeMoltFromGit(ws.dir), false);
    } finally {
      ws.cleanup();
    }
  });

  it("an unattended run is told to keep scratch work out of the task's directories", async () => {
    const { UNATTENDED_PROMPT } = await import("../src/engine.js");
    assert.match(UNATTENDED_PROMPT, /go in \$\(mktemp -d\)\. Try a change that rewrites files on a copy first/);
  });
});

describe("high autonomy lets the model test its own work", () => {
  it("runs inline programs and work confined to its own mktemp folder; still asks for real loss", async () => {
    const { isIrreversibleAtHigh, isIrreversible } = await import("../src/autonomy.js");
    const run = [
      'python3 -c "import sizes; print(sizes.parse_size(\'1 KB\'))"',
      "node -e 'console.log(1)'",
      "d=$(mktemp -d); cat > $d/check.py <<EOF\nprint(1)\nEOF\npython3 $d/check.py; rm -rf $d",
      'tmp="$(mktemp -d)" && echo x > "$tmp/a" && rm -rf "$tmp"',
      "a=$(mktemp -d); b=$(mktemp); rm -rf $a $b",
    ];
    const ask = [
      "d=$(mktemp -d); rm -rf src",
      "d=$(mktemp -d); rm -rf $d ~/x",
      "d=$(mktemp -d); rm -rf $d/../../home",
      "d=$(mktemp -d); echo 1 > \"$d/../x\"",
      "d=/etc; rm -rf $d",
      "echo x > config.ini",
      'bash -c "rm x"',
      "sudo ls",
      "git push",
    ];
    for (const c of run) assert.equal(isIrreversibleAtHigh(c), false, c);
    for (const c of ask) assert.equal(isIrreversibleAtHigh(c), true, c);
    assert.equal(isIrreversible(run[0]!), true, "medium autonomy still asks about an inline program");
    // open(): the mode decides, not the letters in the path. A read of
    // data/orders.csv was refused because "data" contains an "a".
    for (const c of [`python3 -c "print(open('data/orders.csv').read())"`, `python3 -c "open('x.csv', encoding='utf-8-sig', newline='').read()"`, `python3 -c "open('a.txt','rb').read()"`]) {
      assert.equal(isIrreversibleAtHigh(c), false, c);
    }
    for (const c of [`python3 -c "open('a.txt', 'w').write('1')"`, `python3 -c "open('a.txt', mode='a')"`, `python3 -c "from pathlib import Path; Path('x').open('w')"`]) {
      assert.equal(isIrreversibleAtHigh(c), true, c);
    }
  });
});

describe("interpreter names in drafted checks", () => {
  it("python and pip become python3 and pip3 only where those are all there is", async () => {
    const { fixInterpreters } = await import("../src/criteria.js");
    const only3 = { present: ["python3", "pip3"] };
    assert.equal(fixInterpreters("python -m doctest sizes.py", only3), "python3 -m doctest sizes.py");
    assert.equal(fixInterpreters("cd x && python t.py | python3 y; pip install a", only3), "cd x && python3 t.py | python3 y; pip3 install a");
    assert.equal(fixInterpreters("mypython x; python-config; ./python", only3), "mypython x; python-config; ./python");
    assert.equal(fixInterpreters("python t.py", { present: ["python", "python3"] }), "python t.py");
  });
});

describe("what a refusal is called", () => {
  const fails = (hidden: boolean): Check => ({ name: "never", kind: "command", run: "false", timeoutMs: 5_000, expectExit: 0, tags: ["task"], ...(hidden ? { hidden: true } : {}) });
  const turns = () => [
    { calls: [{ name: "write_file", args: { path: "a.txt", content: "1" } }] }, { text: "Done." },
    { calls: [{ name: "write_file", args: { path: "a.txt", content: "2" } }] }, { text: "Done." },
    { calls: [{ name: "write_file", args: { path: "a.txt", content: "3" } }] }, { text: "Done." },
    { calls: [{ name: "write_file", args: { path: "a.txt", content: "4" } }] }, { text: "Done." },
  ];

  it("refused only by molt's own drafted checks: unverified, and says which checks disagree", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider(turns());
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run("make a", allowAll, { taskChecks: [fails(true)] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "unverified");
      assert.deepEqual(end.checksDisagree, ["task:never"]);
      assert.ok(events.some((e) => e.kind === "proof_exhausted"), "the work was still refused: only the word changed");
    } finally {
      ws.cleanup();
    }
  });

  it("refused by a check a person chose: still not proven", async () => {
    const ws = workspace();
    try {
      const provider = scriptedProvider(turns());
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run("make a", allowAll, { taskChecks: [fails(false)] }));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "not proven");
      assert.equal(end.checksDisagree, undefined);
    } finally {
      ws.cleanup();
    }
  });

  it("a check that breaks on its own is found before the work, not after it", async () => {
    const { checkSelfError, preflightCriteria } = await import("../src/criteria.js");
    assert.match(checkSelfError("find: -printf: unknown primary or operator")!, /tool rejected/);
    assert.match(checkSelfError("warning: Not a git repository. Use --no-index")!, /outside a git repository/);
    assert.match(checkSelfError('Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nNameError: name \'fs\' is not defined')!, /own program has a bug/);
    assert.match(checkSelfError('Traceback (most recent call last):\n  File "<string>", line 1\nTypeError: Path.read_text() got an unexpected keyword argument \'newlines\'')!, /misuses a library/);
    // The work's business, not the check's:
    assert.equal(checkSelfError('Traceback (most recent call last):\n  File "<string>", line 1\nModuleNotFoundError: No module named \'pairs\''), null);
    assert.equal(checkSelfError('Traceback (most recent call last):\n  File "<string>", line 1\nAttributeError: module \'sizes\' has no attribute \'parse_size\''), null);
    assert.equal(checkSelfError("AssertionError"), null);
    const ws = workspace();
    try {
      const broken = await preflightCriteria(
        [
          { name: "tooling", run: "echo 'find: -printf: unknown primary or operator' >&2; exit 1" },
          { name: "fair", run: "test -f nothing-yet.txt" },
        ],
        { cwd: ws.dir },
      );
      assert.deepEqual(broken.map((b) => b.name), ["tooling"]);
    } finally {
      ws.cleanup();
    }
  });
});

describe("a drafted check that fails in its own code", () => {
  it("is recognised by its compile error, whichever tool wrote it", () => {
    assert.ok(checkSelfError(`  File "<string>", line 10\n    print(f'Line {i}: missing :\n          ^\nSyntaxError: unterminated f-string literal (detected at line 10)`));
    assert.ok(checkSelfError("jq: error: syntax error, unexpected INVALID_CHARACTER (Unix shell quoting issues?) at <top-level>, line 1:\njq: 1 compile error"));
    assert.ok(checkSelfError('Parse error: near "SELEC": syntax error\n  SELEC name FROM t'));
  });

  it("is not blamed for the deliverable's own syntax error, or for the work's missing column", () => {
    const deliverable = `Traceback (most recent call last):\n  File "<string>", line 1, in <module>\n  File "/w/tool.py", line 3\n    def f(:\n          ^\nSyntaxError: invalid syntax`;
    assert.equal(checkSelfError(deliverable), null);
    assert.equal(checkSelfError("Parse error: no such column: total"), null);
  });

  it("is retired at the claim and the claim judged by the checks that remain", async () => {
    const ws = workspace();
    try {
      const checks: Check[] = [
        { name: "made", kind: "command", run: "head -c 5 out.txt | grep -qx hello", timeoutMs: 5_000, expectExit: 0, tags: ["task", "value"], hidden: true },
        // Fails on the missing file before the work, so preflight keeps it; its own bug shows only after.
        { name: "broken-after", kind: "command", run: "test -f out.txt && python3 -c \"print(f'x {1')\"", timeoutMs: 5_000, expectExit: 0, tags: ["task"], hidden: true },
      ];
      const provider = scriptedProvider([
        { calls: [{ name: "write_file", args: { path: "out.txt", content: "hello\n" } }] },
        { text: "Done." },
      ]);
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const events = await drain(engine.run(TASK, allowAll, { taskChecks: checks }));
      assert.ok(events.some((e) => e.kind === "info" && /check broken-after failed in its own code, not on the work/.test(e.text)));
      const end = events.find((e) => e.kind === "job_end");
      assert.ok(end && end.kind === "job_end");
      assert.equal(end.outcome, "verified");
    } finally {
      ws.cleanup();
    }
  });
});

describe("more ways a drafted check fails on its own", () => {
  it("reads a file from a HEAD that does not hold it, or names a revision that does not exist", () => {
    assert.ok(checkSelfError("fatal: path 'pricing.py' does not exist in 'HEAD'"));
    assert.ok(checkSelfError("fatal: ambiguous argument 'HEAD': unknown revision or path not in the working tree."));
  });
  it("misuses the syntax tree", () => {
    assert.ok(checkSelfError("Traceback (most recent call last):\n  File \"<string>\", line 3, in <module>\nAttributeError: 'FunctionDef' object has no attribute 'docstring'"));
  });
  it("but a branch the work was meant to create and did not is the work's failure", () => {
    assert.equal(checkSelfError("fatal: ambiguous argument 'feature-x': unknown revision or path not in the working tree."), null);
  });
});
