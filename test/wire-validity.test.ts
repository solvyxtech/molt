/**
 * Shedding cuts the message list. Cut in the wrong place and you send a
 * provider a `tool` message whose originating `assistant` turn is gone —
 * OpenAI-compatible endpoints reject that payload outright, which kills the
 * session. This is not a theoretical risk: the tool-boundary fallback added
 * for long single-request runs is precisely the code that could do it.
 *
 * So: generate adversarial tool-heavy transcripts, shed them to death, and
 * assert the wire payload stays valid every single time.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Transcript } from "../src/transcript.js";
import type { Msg, ToolCall } from "../src/types.js";

/**
 * A wire payload is valid when every tool result refers to a call made by
 * the assistant turn immediately preceding its group.
 */
function assertValidWire(messages: Omit<Msg, "molt">[], label: string): void {
  let open = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "assistant") {
      open = new Set((m.tool_calls ?? []).map((c) => c.id));
      continue;
    }
    if (m.role === "tool") {
      assert.ok(
        m.tool_call_id && open.has(m.tool_call_id),
        `${label}: orphaned tool result at index ${i} (id=${m.tool_call_id}). ` +
          `A provider would reject this payload.`,
      );
      continue;
    }
    // user / system end any open tool group
    open = new Set();
  }
}

/** Deterministic PRNG so a failure is reproducible from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function buildAdversarial(seed: number): Transcript {
  const rand = rng(seed);
  const t = new Transcript("SYSTEM");
  let id = 0;

  const turns = 8 + Math.floor(rand() * 24);
  for (let i = 0; i < turns; i++) {
    const roll = rand();

    if (roll < 0.18 || i === 0) {
      t.push({ role: "user", content: `request ${i} ${"u".repeat(200 + Math.floor(rand() * 1800))}` });
      continue;
    }

    if (roll < 0.75) {
      // An assistant turn with one or more tool calls, then their results.
      const n = 1 + Math.floor(rand() * 3);
      const calls: ToolCall[] = Array.from({ length: n }, () => ({
        id: `call_${++id}`,
        type: "function" as const,
        function: {
          name: ["read_file", "write_file", "bash"][Math.floor(rand() * 3)],
          arguments: JSON.stringify({ path: `f${id}.ts`, command: `echo ${id}` }),
        },
      }));
      t.push({ role: "assistant", content: null, tool_calls: calls });
      for (const c of calls) {
        t.push({
          role: "tool",
          tool_call_id: c.id,
          content: `result ${c.id} ${"r".repeat(200 + Math.floor(rand() * 2500))}`,
        });
      }
      continue;
    }

    t.push({ role: "assistant", content: `answer ${i} ${"a".repeat(200 + Math.floor(rand() * 1500))}` });
  }
  return t;
}

describe("wire validity under repeated shedding", () => {
  it("never orphans a tool result across 400 randomized transcripts", () => {
    let totalSheds = 0;
    let fallbackSheds = 0;

    for (let seed = 1; seed <= 400; seed++) {
      const t = buildAdversarial(seed);
      assertValidWire(t.wire(), `seed ${seed} (pre-shed)`);

      const userTurns = t
        .all()
        .filter((m) => m.role === "user" && !m.molt?.digest).length;

      for (let round = 0; round < 12; round++) {
        const plan = t.planShed(2);
        if (!plan) break;
        t.commitShed(plan);
        totalSheds++;
        if (userTurns <= 2) fallbackSheds++;
        assertValidWire(t.wire(), `seed ${seed}, shed ${round + 1}`);
      }
    }

    assert.ok(totalSheds > 200, `expected heavy shedding, got ${totalSheds}`);
    assert.ok(
      fallbackSheds > 0,
      "the tool-boundary fallback path must actually be exercised by this fuzz",
    );
  });

  it("sheds a long single-request tool run that has no user turn to cut on", () => {
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "do a big multi-step job" });
    for (let i = 0; i < 20; i++) {
      const id = `c${i}`;
      t.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      });
      t.push({ role: "tool", tool_call_id: id, content: `output ${i} ${"o".repeat(2000)}` });
    }

    const before = t.historyTokens();
    const plan = t.planShed(2);
    assert.ok(plan, "a 41-message single-request run must be sheddable");
    t.commitShed(plan);

    assert.ok(t.historyTokens() < before, "context must shrink");
    assertValidWire(t.wire(), "single-request run");

    // Nothing was lost: every tool output is still in the record.
    const record = t
      .record()
      .map((m) => m.content ?? "")
      .join("\n");
    for (let i = 0; i < 20; i++) {
      assert.match(record, new RegExp(`output ${i} `), `output ${i} survives`);
    }
  });

  it("refuses to cut when the only available cut would orphan a result", () => {
    const t = new Transcript("SYSTEM");
    t.push({ role: "user", content: "go" });
    t.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "a", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    for (let i = 0; i < 8; i++) {
      t.push({ role: "tool", tool_call_id: "a", content: `chunk ${i} ${"x".repeat(2000)}` });
    }
    const plan = t.planShed(2);
    if (plan) {
      t.commitShed(plan);
      assertValidWire(t.wire(), "pathological tool block");
    }
    // Either it declined, or it cut safely. Both are acceptable; sending an
    // invalid payload is not.
    assert.ok(true);
  });
});
