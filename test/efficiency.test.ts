/**
 * Token efficiency, measured rather than asserted.
 *
 * History is resent on every request, so anything that lingers in context is
 * paid for repeatedly. These tests pin the two places molt was leaking.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ELIDED_PREFIX, STALE_FAILURE_PREFIX, Transcript } from "../src/transcript.js";
import { estTokens } from "../src/types.js";

function tc(name: string, args: Record<string, unknown>, id: string) {
  return { id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
}

describe("stale bar failures", () => {
  it("collapses earlier failures instead of carrying them forever", () => {
    const t = new Transcript("SYS");
    const long = (n: number) =>
      `[molt] You indicated the task is complete, but 1 of 2 checks failed. This is attempt ${n} of 4.\n` +
      "--- FAILED: tests\n" +
      "expected 200 received undefined\n".repeat(40);

    t.pushBarFailure(long(1));
    const afterFirst = t.historyTokens();
    t.pushBarFailure(long(2));
    const afterSecond = t.historyTokens();

    const failures = t.all().filter((m) => m.molt?.barFailure);
    assert.equal(failures.length, 2, "both attempts are still visible");
    assert.ok(
      failures[0].content!.startsWith(STALE_FAILURE_PREFIX),
      "the older failure is collapsed to a marker",
    );
    assert.match(failures[0].content!, /attempt 1 was refused/, "and still says what happened");
    assert.ok(
      failures[1].content!.includes("expected 200"),
      "the current failure keeps its real output",
    );

    // Two full failures would roughly double the cost; one full plus a
    // marker must not.
    assert.ok(
      afterSecond < afterFirst * 1.6,
      `stale failure not collapsed: ${afterFirst} → ${afterSecond} tokens`,
    );
  });

  it("does not re-collapse an already-collapsed marker", () => {
    const t = new Transcript("SYS");
    t.pushBarFailure("attempt 1 of 4\nboom");
    t.pushBarFailure("attempt 2 of 4\nboom");
    t.pushBarFailure("attempt 3 of 4\nboom");
    const markers = t.all().filter((m) => m.content?.startsWith(STALE_FAILURE_PREFIX));
    assert.equal(markers.length, 2);
    assert.match(markers[0].content!, /attempt 1/);
    assert.match(markers[1].content!, /attempt 2/);
  });
});

describe("superseded tool results", () => {
  function sessionWith(calls: [string, string][]): Transcript {
    const t = new Transcript("SYS");
    calls.forEach(([name, path], i) => {
      t.push({ role: "assistant", content: null, tool_calls: [tc(name, { path }, `c${i}`)] });
      t.push({ role: "tool", tool_call_id: `c${i}`, content: "F".repeat(2000) });
    });
    return t;
  }

  it("drops a read that a later write made irrelevant", () => {
    const t = sessionWith([
      ["read_file", "src/auth.ts"],
      ["write_file", "src/auth.ts"],
    ]);
    const before = t.historyTokens();
    const r = t.elideSupersededReads();

    assert.equal(r.elided, 1);
    assert.ok(r.tokensSaved > 400, `expected a real saving, got ${r.tokensSaved}`);
    assert.equal(t.historyTokens(), before - r.tokensSaved);

    const results = t.all().filter((m) => m.role === "tool");
    assert.ok(results[0].content!.startsWith(ELIDED_PREFIX));
    assert.match(results[0].content!, /overwritten at step/);
    assert.match(results[0].content!, /remain in the archived record/);
  });

  it("drops an earlier read of a path that was read again", () => {
    const t = sessionWith([
      ["read_file", "a.ts"],
      ["read_file", "a.ts"],
    ]);
    t.elideSupersededReads();
    const results = t.all().filter((m) => m.role === "tool");
    assert.match(results[0].content!, /re-read at step/);
    assert.ok(!results[1].content!.startsWith(ELIDED_PREFIX), "the current read survives");
  });

  it("leaves unrelated reads and all writes alone", () => {
    const t = sessionWith([
      ["read_file", "a.ts"],
      ["read_file", "b.ts"],
      ["write_file", "c.ts"],
    ]);
    assert.equal(t.elideSupersededReads().elided, 0);
  });

  it("never touches the preserved record", () => {
    const t = sessionWith([
      ["read_file", "x.ts"],
      ["write_file", "x.ts"],
    ]);
    t.elideSupersededReads();
    // Elision changes live context only; shedding is what archives, and the
    // archived copy is written from the pre-elision plan.
    const live = t.wire().map((m) => m.content ?? "").join("");
    assert.ok(live.includes(ELIDED_PREFIX));
  });

  it("is idempotent", () => {
    const t = sessionWith([
      ["read_file", "y.ts"],
      ["write_file", "y.ts"],
    ]);
    const first = t.elideSupersededReads();
    const second = t.elideSupersededReads();
    assert.ok(first.elided > 0);
    assert.equal(second.elided, 0, "running twice must not double-count or re-truncate");
  });

  it("survives malformed tool arguments", () => {
    const t = new Transcript("SYS");
    t.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "b", function: { name: "read_file", arguments: "{broken" } }],
    });
    t.push({ role: "tool", tool_call_id: "b", content: "Z".repeat(500) });
    assert.doesNotThrow(() => t.elideSupersededReads());
  });
});

describe("where the tokens actually go", () => {
  it("confirms fixed overhead is not worth optimizing", () => {
    // System prompt + tool schema are a small constant. History is the cost.
    const t = new Transcript("SYS");
    for (let i = 0; i < 8; i++) {
      t.push({ role: "assistant", content: null, tool_calls: [tc("read_file", { path: `f${i}.ts` }, `c${i}`)] });
      t.push({ role: "tool", tool_call_id: `c${i}`, content: "R".repeat(2048) });
    }
    const history = t.historyTokens();
    const fixed = estTokens("SYS") + 157;
    assert.ok(history > fixed * 10, "history dwarfs fixed overhead; optimize history");
  });
});
