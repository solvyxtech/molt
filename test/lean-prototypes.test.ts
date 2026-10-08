/**
 * The lean-sessions prototypes (src/lean.ts) do what the study says they do.
 * All are behind env flags and off by default; these tests set the options
 * directly or set the env for one engine run and restore it.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { Engine } from "../src/engine.js";
import { AGING_DEFAULTS, leanAging, leanShedAt, leanShedMinFree, leanSupersede } from "../src/lean.js";
import { ELIDED_PREFIX, Transcript, type AgingOpts } from "../src/transcript.js";
import { allowAll, drain, scriptedProvider, toolCall, workspace } from "./helpers.js";

/** Run with exactly these lean flags set (any other MAAT_LEAN_* is cleared for the run). */
function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const lean = Object.keys(process.env).filter((k) => k.startsWith("MAAT_LEAN_"));
  const before = Object.fromEntries([...new Set([...lean, ...Object.keys(vars)])].map((k) => [k, process.env[k]]));
  for (const k of lean) delete process.env[k];
  Object.assign(process.env, vars);
  return fn().finally(() => {
    for (const [k, v] of Object.entries(before)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}

/** A single-request session of `n` bash steps, each printing `size` distinct chars. */
function longRun(n: number, size: number): Transcript {
  const t = new Transcript("SYSTEM");
  t.push({ role: "user", content: "the task" });
  for (let i = 0; i < n; i++) {
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `step ${i}` }, `c${i}`)] });
    t.push({ role: "tool", tool_call_id: `c${i}`, content: `${i}:${"r".repeat(size)}` });
  }
  return t;
}

const opts = (o: Partial<AgingOpts> = {}): AgingOpts => ({ ...AGING_DEFAULTS, ...o });

describe("lean flags", () => {
  it("are all off by default", () => {
    for (const k of Object.keys(process.env)) if (k.startsWith("MAAT_LEAN_") || k.startsWith("MOLT_LEAN_")) return;
    assert.equal(leanShedAt(), undefined);
    assert.equal(leanShedMinFree(), 0);
    assert.equal(leanSupersede(), false);
    assert.equal(leanAging(), null);
  });

  it("MAAT_LEAN_AGE reads its options", async () => {
    await withEnv({ MAAT_LEAN_AGE: "keep=4,batch=1000,at=30000", MAAT_LEAN_AGE_ARGS: "1" }, async () => {
      const a = leanAging()!;
      assert.equal(a.keep, 4);
      assert.equal(a.batchChars, 1000);
      assert.equal(a.atTokens, 30000);
      assert.equal(a.args, true);
    });
  });
});

describe("ageing (MAAT_LEAN_AGE)", () => {
  it("sends older results as their ends and a pointer, and keeps the full text everywhere else", () => {
    const t = longRun(20, 5000);
    const before = t.historyTokens();
    const plan = t.planAging(opts({ batchChars: 1000 }))!;
    assert.equal(plan.results.length, 14, "the newest six stay whole");
    t.commitAging(plan, opts(), (id) => `.maat/out/aged-${id}.txt`);
    assert.ok(t.historyTokens() < before / 2, "the history on the wire shrank");
    const wire = JSON.stringify(t.wire());
    assert.ok(wire.includes(".maat/out/aged-c0.txt"), "the pointer is on the wire");
    assert.ok(!wire.includes(`0:${"r".repeat(5000)}`), "the old result is not");
    assert.ok(wire.includes(`19:${"r".repeat(5000)}`), "the newest result is whole");
    const record = JSON.stringify(t.record());
    assert.ok(record.includes(`0:${"r".repeat(5000)}`), "the record keeps the full text");
    assert.ok(JSON.stringify(t.wire({ repairArgs: false })).includes(`0:${"r".repeat(5000)}`), "a capture keeps it too");
  });

  it("waits for a batch, so the cached prefix is not rewritten every step", () => {
    const t = longRun(8, 2000);
    assert.equal(t.planAging(opts({ batchChars: 24_000 })), null);
    assert.ok(t.planAging(opts({ batchChars: 1_000 })));
  });

  it("leaves pointers, notices and short results alone", () => {
    const t = longRun(10, 100);
    assert.equal(t.planAging(opts({ batchChars: 0 }))?.results.length ?? 0, 0);
  });

  it("with args, shortens long arguments but keeps their keys and valid JSON", () => {
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "task" });
    const big = `python3 - <<'EOF'\n${"print(1)\n".repeat(400)}EOF`;
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: big }, "w")] });
    t.push({ role: "tool", tool_call_id: "w", content: "ok" });
    for (let i = 0; i < 7; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `s${i}` }, `c${i}`)] });
      t.push({ role: "tool", tool_call_id: `c${i}`, content: "x" });
    }
    const o = opts({ args: true, batchChars: 0 });
    const plan = t.planAging(o)!;
    assert.equal(plan.calls.length, 1);
    t.commitAging(plan, o, () => ".maat/out/aged-call-w.txt");
    const sent = t.wire().find((m) => m.tool_calls?.[0]?.id === "w")!.tool_calls![0]!.function.arguments;
    const args = JSON.parse(sent) as { command: string };
    assert.ok(args.command.startsWith("python3 - <<'EOF'"));
    assert.ok(args.command.includes(".maat/out/aged-call-w.txt"));
    assert.ok(sent.length < big.length / 4);
  });

  it("soft shed (at=): waits for the threshold, then ages down to half of it or asks for a shed", () => {
    const t = longRun(30, 4000);
    assert.equal(t.planAging(opts({ atTokens: 100_000, batchChars: 0 })), null);
    const plan = t.planAging(opts({ atTokens: 25_000, batchChars: 0 }))!;
    assert.ok(plan.results.length >= 24);
    assert.ok(!plan.thenShed);
    const tight = t.planAging(opts({ atTokens: 2_000, batchChars: 0 }))!;
    assert.equal(tight.thenShed, true);
  });

  it("in an engine run: the full output lands in .maat/out, the wire carries the pointer, and an aged file can be read again", async () => {
    const ws = workspace();
    try {
      writeFileSync(join(ws.dir, "big.txt"), Array.from({ length: 300 }, (_, i) => `line ${i} ${"q".repeat(40)}`).join("\n"));
      const turns = [
        { calls: [{ name: "read_file", args: { path: "big.txt" } }] },
        ...Array.from({ length: 8 }, (_, i) => ({ calls: [{ name: "bash", args: { command: `printf 'step ${i} %.0s......................\\n' $(seq 1 120)` } }] })),
        { calls: [{ name: "read_file", args: { path: "big.txt" } }] },
        { text: "Done." },
      ];
      const p = scriptedProvider(turns as never);
      await withEnv({ MAAT_LEAN_AGE: "batch=1000" }, async () => {
        const e = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", maxSteps: 0 });
        await drain(e.run("look", allowAll));
      });
      const last = p.bodies.at(-1)!;
      assert.match(last, /\.maat\/out\/aged-call_1\.txt/);
      assert.ok(existsSync(join(ws.dir, ".maat", "out", "aged-call_1.txt")));
      assert.match(readFileSync(join(ws.dir, ".maat", "out", "aged-call_1.txt"), "utf8"), /line 299 q/);
      // The second read is served in full, not refused as "already shown".
      const lastRead = JSON.parse(last).messages.filter((m: { role: string }) => m.role === "tool").at(-1).content as string;
      assert.match(lastRead, /line 299 q/);
    } finally {
      ws.cleanup();
    }
  });
});

describe("superseded results (MAAT_LEAN_SUPERSEDE)", () => {
  function step(t: Transcript, calls: [string, Record<string, unknown>, string, string][]) {
    t.push({ role: "assistant", content: null, tool_calls: calls.map(([n, a, id]) => toolCall(n, a, id)) });
    for (const [, , id, out] of calls) t.push({ role: "tool", tool_call_id: id, content: out });
  }
  const body = (s: string) => `${s}\n${"x".repeat(2000)}`;

  it("a write supersedes the read of that file only, not the other reads of its step", () => {
    const run = (lean: boolean) => {
      const t = new Transcript("S");
      t.push({ role: "user", content: "task" });
      step(t, [
        ["read_file", { path: "dur.py" }, "a", body("DUR")],
        ["read_file", { path: "test_dur.py" }, "b", body("TESTS")],
      ]);
      step(t, [["write_file", { path: "dur.py", content: "new" }, "w", "wrote"]]);
      t.elideSupersededReads({ lean });
      return JSON.stringify(t.wire());
    };
    // Today: both results of the step are elided, test_dur.py included.
    assert.ok(!run(false).includes("TESTS"));
    const lean = run(true);
    assert.ok(lean.includes("TESTS"), "test_dur.py was never rewritten and stays");
    assert.ok(!lean.includes("DUR\\n"), "dur.py's stale contents go");
  });

  it("a bash rerun that came back different supersedes the earlier output", () => {
    const t = new Transcript("S");
    t.push({ role: "user", content: "task" });
    step(t, [["bash", { command: "pytest -q" }, "a", body("3 failed")]]);
    step(t, [["bash", { command: "pytest  -q" }, "b", body("3 passed")]]);
    const r = t.elideSupersededReads({ lean: true });
    assert.equal(r.elided, 1);
    const wire = JSON.stringify(t.wire());
    assert.ok(!wire.includes("3 failed") && wire.includes("3 passed") && wire.includes(ELIDED_PREFIX));
  });

  it("a rerun with different options (a longer timeout_s) is a different call: the timeout note stays", () => {
    const t = new Transcript("S");
    t.push({ role: "user", content: "task" });
    step(t, [["bash", { command: "make" }, "a", body("timeout after 120s; call again with timeout_s")]]);
    step(t, [["bash", { command: "make", timeout_s: 600 }, "b", body("built")]]);
    assert.equal(t.elideSupersededReads({ lean: true }).elided, 0);
  });

  it("a rerun that came back the same keeps the earlier output it points at", () => {
    const t = new Transcript("S");
    t.push({ role: "user", content: "task" });
    step(t, [["bash", { command: "ls" }, "a", body("files")]]);
    step(t, [["bash", { command: "ls" }, "b", "[molt: this is the same bash call you made at step 1, and nothing has changed since.]"]]);
    assert.equal(t.elideSupersededReads({ lean: true }).elided, 0);
  });

  it("cat or sed -n of a file, then a write to it, supersedes the read", () => {
    const t = new Transcript("S");
    t.push({ role: "user", content: "task" });
    step(t, [["bash", { command: "sed -n '1,80p' src/a.py" }, "a", body("OLD A")]]);
    step(t, [["bash", { command: "cat src/b.py | head" }, "b", body("B PIPE")]]);
    step(t, [["edit_file", { path: "src/a.py", old: "x", new: "y" }, "e", "edited"]]);
    step(t, [["edit_file", { path: "src/b.py", old: "x", new: "y" }, "f", "edited"]]);
    assert.equal(t.elideSupersededReads({ lean: true }).elided, 1, "a pipeline is not a plain read");
    assert.ok(!JSON.stringify(t.wire()).includes("OLD A"));
  });
});

describe("shed min-free (MAAT_LEAN_SHED_MINFREE)", () => {
  /**
   * The shape of the real run (ml4b-1 duration-bug, 2026-10-07): the request,
   * Maat's acceptance-criteria note and, much later, a bar refusal are all user
   * messages. With two exchanges kept, the cut lands on the criteria note and
   * frees almost nothing: 60,788 -> 60,387 tokens, then a second shed a step
   * later.
   */
  function realShape(firstRead = "f".repeat(2000)): Transcript {
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "the task" });
    t.push({ role: "assistant", content: null, tool_calls: [toolCall("read_file", { path: "a" }, "r0")] });
    t.push({ role: "tool", tool_call_id: "r0", content: firstRead });
    t.push({ role: "user", content: "Acceptance criteria for this task: ..." });
    for (let i = 0; i < 40; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `s${i}` }, `a${i}`)] });
      t.push({ role: "tool", tool_call_id: `a${i}`, content: "o".repeat(5000) });
    }
    t.push({ role: "user", content: "[molt] You indicated the task is complete, but 1 of 3 checks did not pass." });
    for (let i = 0; i < 40; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [toolCall("bash", { command: `t${i}` }, `b${i}`)] });
      t.push({ role: "tool", tool_call_id: `b${i}`, content: "p".repeat(5000) });
    }
    return t;
  }

  it("today the cut on user turns frees under 1% of the history", () => {
    const plan = realShape().planShed()!;
    assert.ok(plan.afterTokens / plan.beforeTokens > 0.99, `${plan.beforeTokens} -> ${plan.afterTokens}`);
  });

  it("today, with a short first exchange, there is no shed at all: auto-shed never fires again", () => {
    assert.equal(realShape("short").planShed(), null);
  });

  it("with min-free, a cut that frees too little cuts on recent messages instead", () => {
    for (const first of ["f".repeat(2000), "short"]) {
      const t = realShape(first);
      t.shedMinFree = 0.25;
      const plan = t.planShed()!;
      assert.ok(plan.afterTokens / plan.beforeTokens < 0.1, `${plan.beforeTokens} -> ${plan.afterTokens}`);
    }
  });

  it("an engine with an archive picks the flag up", async () => {
    const ws = workspace();
    try {
      const p = scriptedProvider([
        ...Array.from({ length: 30 }, (_, i) => ({ calls: [{ name: "bash", args: { command: `printf 'x%.0s' $(seq 1 4000); echo ${i}` } }] })),
        { text: "Done." },
      ] as never);
      await withEnv({ MAAT_LEAN_SHED_MINFREE: "0.25", MAAT_LEAN_SHED_AT: "20000" }, async () => {
        const e = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: p.fetchFn, bar: null, stream: false, autonomy: "high", maxSteps: 0, archive: new Archive(join(ws.dir, ".maat", "exuviae")) });
        assert.equal(e.autoShedAtTokens, 20000);
        const ev = await drain(e.run("go", allowAll));
        assert.ok(ev.some((x) => x.kind === "shed"));
      });
    } finally {
      ws.cleanup();
    }
  });
});
