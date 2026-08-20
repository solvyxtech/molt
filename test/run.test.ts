/**
 * Running commands without stopping the world.
 *
 * molt shelled out with `execSync`, for the `bash` tool and for every bar
 * check. That blocks Node's event loop for the whole life of the command —
 * not "is slow", but *stops*: no timer fires, no keystroke is read, nothing
 * repaints. A two-second command produced exactly zero ticks of the TUI's
 * 90ms spinner, so molt looked frozen for as long as it was working, and the
 * ctrl+C that would have stopped a runaway suite could not be read until the
 * suite was over.
 *
 * The measurement is the test: run something slow, count how often a timer
 * that should fire every 20ms actually fires. A blocked loop scores zero.
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { loadBar } from "../src/bar.js";
import { runCommand } from "../src/run.js";
import { formatMatches, grepFiles, walkAsync } from "../src/files.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/**
 * How long molt may stop responding, in one go, before it counts as frozen.
 *
 * A quarter second is the point where a terminal stops feeling live. The
 * defect this catches stalls for the *entire* duration of the command, so
 * there is a wide margin between the two: measured on this machine, an async
 * command stalls ~22ms and the old synchronous one stalled 100% of its
 * runtime, and both figures hold under eight-way CPU contention.
 */
const MAX_STALL_MS = 250;
const SAMPLE_MS = 20;

/**
 * Run `work`, and report the longest single gap between JS callbacks while it
 * ran — which is what "frozen" actually means for a terminal.
 *
 * Two instruments were tried and rejected before this one, so the reasoning is
 * worth keeping:
 *
 *  - *Counting* ticks and comparing against a free loop's rate measures how
 *    busy the machine is, not whether molt stalled. It failed once in eight
 *    runs on an idle laptop, and a flaky check in molt's own bar costs a real
 *    turn to re-prove.
 *  - `perf_hooks.monitorEventLoopDelay` is maintained in C++ and `spawnSync`
 *    runs a *nested* libuv loop, so the histogram keeps sampling happily while
 *    JS is completely starved. It reported the blocking version as having zero
 *    delay — an instrument that reads clean on the very bug it is aimed at.
 *
 * The longest gap is scale-free and load-insensitive: heavy load makes gaps
 * many and small, blocking makes one gap that spans the whole operation.
 */
function watchStalls(): { stop: () => number } {
  let last = Date.now();
  let worst = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    if (now - last > worst) worst = now - last;
    last = now;
  }, SAMPLE_MS);
  timer.unref?.();
  return {
    stop() {
      clearInterval(timer);
      // The trailing gap counts: when the loop unblocks, the work can finish
      // before the sampler gets another turn in which to notice it did.
      return Math.max(worst, Date.now() - last);
    },
  };
}

async function stallDuring<T>(
  work: () => Promise<T>,
): Promise<{ stalledMs: number; elapsed: number; value: T }> {
  const w = watchStalls();
  const t0 = Date.now();
  try {
    const value = await work();
    return { stalledMs: w.stop(), elapsed: Date.now() - t0, value };
  } catch (e) {
    w.stop();
    throw e;
  }
}

/**
 * Assert molt stayed responsive, two ways.
 *
 * The absolute bound is the promise worth making — a quarter second is where a
 * terminal stops feeling live. The proportional one is what makes the check
 * bite at any duration: blocking stalls for *the whole operation*, so the
 * fraction is ~100% however long or short the work is, while load produces
 * many small gaps and leaves it in the low single digits. Together they hold
 * on a fast machine and a busy one without either being tuned to this laptop.
 *
 * The floor exists so this can never quietly become a test of nothing: work
 * over in a couple of sampling intervals proves neither.
 */
const MIN_MEASURABLE_MS = 150;

function assertResponsive(what: string, r: { stalledMs: number; elapsed: number }): void {
  assert.ok(
    r.elapsed > MIN_MEASURABLE_MS,
    `${what} finished in ${r.elapsed}ms — too fast to prove anything about stalling`,
  );
  assert.ok(
    r.stalledMs < MAX_STALL_MS && r.stalledMs < r.elapsed * 0.5,
    `${what}: molt stopped responding for ${r.stalledMs}ms of ${r.elapsed}ms ` +
      `(${Math.round((100 * r.stalledMs) / r.elapsed)}% of the operation)`,
  );
}

describe("runCommand", () => {
  it("captures both streams and the exit code", async () => {
    const r = await runCommand("echo out; echo err 1>&2; exit 3", { cwd: ws() });
    assert.match(r.stdout, /out/);
    assert.match(r.stderr, /err/);
    assert.equal(r.code, 3);
    assert.equal(r.timedOut, false);
  });

  it("keeps the loop turning while it waits", async () => {
    assertResponsive("a one-second command", await stallDuring(() => runCommand("sleep 1", { cwd: ws() })));
  });

  it("kills a command that runs past its timeout", async () => {
    const r = await runCommand("sleep 30", { cwd: ws(), timeoutMs: 300 });
    assert.equal(r.timedOut, true);
    assert.notEqual(r.signal, null, "reported a timeout without actually killing anything");
  });

  it("kills a command when the turn is cancelled", async () => {
    const ac = new AbortController();
    const started = Date.now();
    setTimeout(() => ac.abort(), 200);
    const r = await runCommand("sleep 30", { cwd: ws(), signal: ac.signal });
    assert.ok(Date.now() - started < 5_000, "the abort was ignored and it ran to completion");
    assert.notEqual(r.signal, null);
  });

  it("does not reject when a command fails — an exit code is a result", async () => {
    const r = await runCommand("exit 1", { cwd: ws() });
    assert.equal(r.code, 1);
  });
});

describe("molt while it works", () => {
  function engineRunning(dir: string, command: string) {
    return new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: dir,
      bar: null,
      stream: false,
      autonomy: "high",
      fetchFn: scriptedProvider([
        { calls: [{ name: "bash", args: { command } }] },
        { text: "done" },
      ]).fetchFn,
    });
  }

  it("stays responsive while a tool runs", async () => {
    // The reported symptom: "molt freezes up while running its programs".
    const engine = engineRunning(ws(), "sleep 1");
    assertResponsive("a tool call", await stallDuring(() => drain(engine.run("run it", allowAll))));
  });

  it("stays responsive while the bar runs", async () => {
    // The longer freeze of the two: a bar check's default timeout is two
    // minutes, and `npm test` is exactly the kind of thing that uses it.
    const dir = ws();
    mkdirSync(join(dir, ".molt"), { recursive: true });
    writeFileSync(
      join(dir, ".molt", "done.yml"),
      "version: 1\nchecks:\n  - name: slow\n    run: sleep 1\n    expect_exit: 0\n",
      "utf8",
    );
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      stream: false,
      fetchFn: scriptedProvider([{ text: "done" }]).fetchFn,
    });
    const r = await stallDuring(() => engine.proveNow());
    assert.ok(r.value?.ok, "the check did not actually run");
    assertResponsive("a bar check", r);
  });

  it("stops the command it is waiting on when the turn is cancelled", async () => {
    // Cancelling only the network left the build running. The point of ctrl+C
    // during a ten-minute suite is that the suite stops.
    const engine = engineRunning(ws(), "sleep 30");
    const started = Date.now();
    setTimeout(() => engine.cancel(), 400);
    await drain(engine.run("run it", allowAll));
    assert.ok(
      Date.now() - started < 10_000,
      "cancelling the turn left the command running to its own end",
    );
  });
});

describe("searching a big tree", () => {
  /**
   * One tree, built once and shared. Sized so a search over it lasts well past
   * MIN_MEASURABLE_MS and no longer — a blocking search stalls for 100% of
   * however long it takes, so the proportional bound bites at this size just
   * as hard as at ten times it, and the fixture is not worth the seconds.
   */
  let big: string | undefined;
  function bigTree(): string {
    if (big) return big;
    const dir = ws();
    for (let i = 0; i < 120; i++) {
      let p = join(dir, `d${i}`);
      mkdirSync(p, { recursive: true });
      for (let d = 0; d < 8; d++) {
        p = join(p, `n${d}`);
        mkdirSync(p, { recursive: true });
        for (let f = 0; f < 10; f++) writeFileSync(join(p, `f${f}.md`), "nothing here\n");
      }
      writeFileSync(join(p, "hit.ts"), "the needle\n");
    }
    big = dir;
    return dir;
  }

  it("expands a brace glob instead of matching it literally", async () => {
    // `*.{ts,tsx}` is the most natural way to write this, and it matched
    // nothing at all — no error, no matches, and a full-tree walk to find that
    // out. Eight minutes, in the session that reported it.
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "the needle\n");
    writeFileSync(join(dir, "b.tsx"), "the needle\n");
    writeFileSync(join(dir, "c.md"), "the needle\n");
    const r = await grepFiles(dir, "needle", { glob: "*.{ts,tsx}" });
    assert.deepEqual(
      r.matches.map((m) => m.path).sort(),
      ["a.ts", "b.tsx"],
      "brace alternation did not expand",
    );
  });

  it("bounds the walk by what it looks at, not by what it keeps", async () => {
    // The bug, stated exactly: `limit` counts entries *collected*, and a glob
    // that collects almost nothing never reaches it. A cap on entries examined
    // is the one that binds. Asserted against a cap small enough that there is
    // no doubt it fired, rather than hoping a fixture is slow enough.
    const dir = bigTree();
    const capped = await walkAsync(dir, {
      depth: 24,
      glob: "*.nothing-matches-this",
      limit: 5_000,
      examine: 500,
    });
    assert.equal(capped.entries.length, 0, "the glob was supposed to keep nothing");
    assert.equal(capped.truncated, true, "collected nothing and walked on regardless");
    assert.ok(capped.examined <= 600, `examined ${capped.examined} entries past a cap of 500`);
  });

  it("stops a walk on the clock as well", async () => {
    // A deadline one millisecond out, so this proves the check fires rather
    // than proving the fixture is slow. Tying it to how long the tree takes to
    // walk made it depend on whether the filesystem cache was warm, and the
    // same tree that took two seconds cold took 121ms warm and never tripped.
    const dir = bigTree();
    const t0 = Date.now();
    const r = await walkAsync(dir, {
      depth: 24,
      glob: "*.nope",
      examine: 10_000_000,
      deadline: Date.now() + 1,
    });
    const ms = Date.now() - t0;
    assert.equal(r.timedOut, true, "ran past its deadline without noticing");
    assert.ok(r.examined > 0, "gave up before looking at anything");
    assert.ok(ms < 3_000, `stopped on the clock but still ran ${ms}ms`);
  });

  it("never reports a cut-short search as a clean miss", async () => {
    // "No match" and "I never looked" are different answers, and a model acts
    // on the difference. Asserted on the message itself, so this cannot pass
    // by the fixture happening not to trip the bound.
    const missed = formatMatches("needle", {
      matches: [],
      truncated: true,
      scanned: 3,
      partialWalk: true,
    });
    assert.match(missed, /NOT evidence/, "a partial search read as proof of absence");

    const clean = formatMatches("needle", { matches: [], truncated: false, scanned: 12 });
    assert.match(clean, /no match/);
    assert.ok(!/NOT evidence/.test(clean), "a complete search hedged for no reason");
  });

  it("stays responsive while it searches", async () => {
    // Deliberately CPU-bound rather than walk-bound: a few big files rather
    // than thousands of small ones. Walking thousands of files is fast or slow
    // depending on the filesystem cache, and a fixture whose duration swings
    // by a factor of sixteen between runs cannot support a timing assertion.
    // Scanning a million lines takes the same time every time.
    const dir = ws();
    const body = Array.from({ length: 40_000 }, (_, i) => `line ${i} with some words in it`).join("\n");
    for (let i = 0; i < 8; i++) writeFileSync(join(dir, `big${i}.ts`), body);
    // A pattern that is not there, so nothing short-circuits the scan, and one
    // that backtracks, so the cost is in the CPU rather than in the disk. Ten
    // megabytes of fixture rather than the hundreds it would take to make a
    // plain literal search last as long.
    const r = await stallDuring(() =>
      grepFiles(dir, ".*with.*some.*words.*absent", { glob: "*.ts" }),
    );
    assert.equal(r.value.matches.length, 0);
    assertResponsive("a search", r);
  });
});

describe("a connection that drops mid-turn", () => {
  function flaky(failures: number) {
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      if (calls <= failures) throw new TypeError("fetch failed");
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({
          choices: [{ message: { role: "assistant", content: "recovered" } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 },
        }),
        text: async () => "",
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, calls: () => calls };
  }

  it("retries a dropped connection instead of ending the turn", async () => {
    const f = flaky(2);
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws(),
      bar: null,
      stream: false,
      retryBackoffMs: [5, 5, 5],
      fetchFn: f.fetchFn,
    });
    const events = await drain(engine.run("go", allowAll));
    assert.ok(f.calls() >= 3, `gave up after ${f.calls()} attempt(s)`);
    const answer = events.find((e) => e.kind === "assistant_text") as { text: string } | undefined;
    assert.equal(answer?.text, "recovered", "the turn died on a blip it could have ridden out");
    // The retry is visible, not silent — you paid for the wait.
    assert.ok(events.some((e) => e.kind === "info" && /retrying/.test(e.text)));
  });

  it("reports what it found when the network is genuinely gone", async () => {
    // The turn's tokens are already spent. Ending with nothing said is the
    // most expensive possible reading of a failed request.
    const f = flaky(Number.MAX_SAFE_INTEGER);
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws(),
      bar: null,
      stream: false,
      retryBackoffMs: [5, 5, 5],
      fetchFn: f.fetchFn,
    });
    const events = await drain(engine.run("go", allowAll));
    const err = events.find((e) => e.kind === "error") as { text: string } | undefined;
    assert.match(err?.text ?? "", /gave up after \d+ attempts/);
    assert.ok(f.calls() > 1, "did not retry at all");
  });
});
