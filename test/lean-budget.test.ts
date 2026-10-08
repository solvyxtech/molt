import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine, type EngineConfig } from "../src/engine.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

/**
 * Lean budget: hard ceilings on what one turn sends to the provider.
 *
 * 2026-10-07: malformed tool calls were resent in full on every later step,
 * and one task cost 2.68M tokens / $0.82 for a 181-byte file. Every test in
 * this file would have gone red on that build. Each scenario is scripted (no
 * model, no network) and measures three things:
 *
 *   largest  the biggest single request body, in characters
 *   total    every request body of the turn added up, in characters
 *   steps    how many times the provider was asked
 *
 * Ceilings sit at about 1.5x the value measured when they were set, so noise
 * never trips them and a resend-everything regression always does. Each run
 * prints its numbers (`lean-budget <name> ...`); when a change makes a
 * scenario cheaper, tighten its ceiling to 1.5x the new value. Raising one
 * needs a reason in the commit message. See docs/lean.md.
 */

interface Ceiling {
  largest: number;
  total: number;
  steps: number;
}

interface Measured extends Ceiling {
  events: EngineEvent[];
  /** Every request body, so a test can prove its scenario really ran. */
  sent: string;
}

/** One scripted turn: `raw` sends tool-call arguments exactly as given, unparseable or not. */
type Turn =
  | { text: string }
  | { calls: { name: string; args?: Record<string, unknown>; raw?: string }[] };

/**
 * scriptedProvider, plus raw argument strings: a real model's malformed call
 * arrives as text that is not JSON, which JSON.stringify can never produce.
 */
function rawProvider(turns: Turn[]): { fetchFn: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let n = 0;
  let id = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const turn = turns[Math.min(n, turns.length - 1)]!;
    n += 1;
    const message =
      "text" in turn
        ? { role: "assistant", content: turn.text }
        : {
            role: "assistant",
            content: null,
            tool_calls: turn.calls.map((c) => ({
              id: `call_${++id}`,
              type: "function",
              function: { name: c.name, arguments: c.raw ?? JSON.stringify(c.args ?? {}) },
            })),
          };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

async function measure(
  name: string,
  turns: Turn[],
  opts: { setup?: (dir: string) => void; cfg?: Partial<EngineConfig>; task?: string } = {},
): Promise<Measured> {
  const ws = workspace();
  try {
    opts.setup?.(ws.dir);
    const raw = turns.some((t) => "calls" in t && t.calls.some((c) => c.raw !== undefined));
    const provider = raw ? rawProvider(turns) : scriptedProvider(turns as never);
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws.dir,
      fetchFn: provider.fetchFn,
      bar: null,
      stream: false,
      autonomy: "high",
      ...opts.cfg,
    });
    const events = await drain(engine.run(opts.task ?? "do the task", allowAll));
    const sizes = provider.bodies.map((b) => b.length);
    const m = {
      largest: Math.max(0, ...sizes),
      total: sizes.reduce((a, b) => a + b, 0),
      steps: sizes.length,
      events,
      sent: provider.bodies.join("\n"),
    };
    console.log(`lean-budget ${name} largest=${m.largest} total=${m.total} steps=${m.steps}`);
    return m;
  } finally {
    ws.cleanup();
  }
}

function within(name: string, m: Measured, c: Ceiling): void {
  assert.ok(m.largest <= c.largest, `${name}: largest request ${m.largest} chars > ceiling ${c.largest}`);
  assert.ok(m.total <= c.total, `${name}: total request chars ${m.total} > ceiling ${c.total}`);
  assert.ok(m.steps <= c.steps, `${name}: ${m.steps} provider requests > ceiling ${c.steps}`);
}

/**
 * About 1.5x the values measured on 2026-10-07 (the PR #47 build). Measured
 * values in the comments; the build before #47 measured malformed-raw at
 * 369,044 largest / 4,070,554 total / 13 steps and malformed-act at 727,583 /
 * 4,766,054 / 13, which these ceilings fail by 20-60x.
 */
const CEILINGS = {
  small: { largest: 11_700, total: 34_000, steps: 5 }, // 7,805 / 22,690 / 3
  bigRead: { largest: 62_000, total: 195_000, steps: 6 }, // 41,234 / 130,307 / 4
  reread: { largest: 61_000, total: 173_000, steps: 14 }, // 40,732 / 115,399 / 9
  longShed: { largest: 390_000, total: 10_900_000, steps: 92 }, // 259,597 / 7,262,564 / 61
  malformedRaw: { largest: 18_700, total: 104_000, steps: 11 }, // 12,450 / 69,197 / 7
  malformedAct: { largest: 14_100, total: 73_000, steps: 11 }, // 9,384 / 48,455 / 7
  hugeOutput: { largest: 24_800, total: 84_000, steps: 6 }, // 16,537 / 56,108 / 4
} satisfies Record<string, Ceiling>;

const done = { text: "Done." };

describe("lean budget: request-size and step ceilings", () => {
  // Guards: the baseline. System prompt, tool schemas or per-step framing
  // growing until an ordinary three-step task costs noticeably more.
  it("a: a small task (read, write, done)", async () => {
    const m = await measure("small", [
      { calls: [{ name: "read_file", args: { path: "in.txt" } }] },
      { calls: [{ name: "write_file", args: { path: "out.txt", content: "HELLO\n" } }] },
      done,
    ], { setup: (d) => writeFileSync(join(d, "in.txt"), "hello\n"), task: "uppercase in.txt into out.txt" });
    within("small", m, CEILINGS.small);
  });

  // Guards: read_file paging. A 400 KB file must arrive in bounded parts,
  // never whole in one request, and must not be carried whole on every step.
  it("b: one read of a 400 KB file, then work", async () => {
    const m = await measure("big-read", [
      { calls: [{ name: "read_file", args: { path: "big.txt" } }] },
      { calls: [{ name: "write_file", args: { path: "out.txt", content: "summary\n" } }] },
      { calls: [{ name: "bash", args: { command: "wc -c out.txt" } }] },
      done,
    ], { setup: (d) => writeFileSync(join(d, "big.txt"), bigText(400_000)), task: "summarise big.txt" });
    assert.ok(/line 100 abcdefghij/.test(m.sent), "the file never reached the model");
    within("big-read", m, CEILINGS.bigRead);
  });

  // Guards: the repeat pointer. Re-reading the same file must come back as a
  // short "already shown" note, not a fresh copy on every step.
  it("c: the same file read again and again", async () => {
    const reread = { calls: [{ name: "read_file", args: { path: "mid.txt" } }] };
    const m = await measure("re-read", [
      ...Array.from({ length: 8 }, () => reread),
      done,
    ], { setup: (d) => writeFileSync(join(d, "mid.txt"), bigText(40_000)), task: "read mid.txt" });
    assert.ok(/line 100 abcdefghij/.test(m.sent), "the file never reached the model");
    within("re-read", m, CEILINGS.reread);
  });

  // Guards: auto-shed. A long session must shed its history at the default
  // threshold, so requests plateau instead of growing with every step.
  it("d: a long session sheds and stays bounded", async () => {
    const m = await measure("long-shed", [
      ...Array.from({ length: 60 }, (_, i) => ({
        calls: [{ name: "bash", args: { command: `printf '%.0sstep ${i} output line\\n' $(seq 1 300)` } }],
      })),
      done,
    ], { cfg: { maxSteps: 0 }, task: "a long job" });
    assert.ok(m.events.some((e) => e.kind === "shed"), "the long session never shed");
    assert.ok(/step 59 output line/.test(m.sent), "the session ended before its last step");
    within("long-shed", m, CEILINGS.longShed);
  });

  // Guards: the 2026-10-07 regression itself (PR #47). Malformed calls with
  // huge arguments must go back as an excerpt and stop the turn at the limit.
  it("e1: malformed calls with huge unparseable arguments", async () => {
    const broken = `{"path": "out.txt", "content": "${"x".repeat(60_000)}`;
    const m = await measure("malformed-raw", [
      ...Array.from({ length: 12 }, () => ({ calls: [{ name: "write_file", raw: broken }] })),
      done,
    ]);
    within("malformed-raw", m, CEILINGS.malformedRaw);
  });

  // Guards: the same regression on the batch path, where it was first seen:
  // an `act` whose actions cannot be read, carrying a huge payload.
  it("e2: malformed act calls with huge arguments (batch mode)", async () => {
    const m = await measure("malformed-act", [
      ...Array.from({ length: 12 }, () => ({
        calls: [{ name: "act", args: { analysis: "writing", actions: "y".repeat(60_000) } }],
      })),
      { calls: [{ name: "act", args: { analysis: "done", actions: [] } }] },
    ], { cfg: { batch: true } });
    within("malformed-act", m, CEILINGS.malformedAct);
  });

  // Guards: tool-result capping. A command that prints 1 MB must reach the
  // model as a bounded result, and later steps must not resend all of it.
  it("f: a command that prints 1 MB", async () => {
    const m = await measure("huge-output", [
      { calls: [{ name: "bash", args: { command: "yes 'build output line 0123456789' | head -c 1048576" } }] },
      { calls: [{ name: "write_file", args: { path: "out.txt", content: "ok\n" } }] },
      { calls: [{ name: "bash", args: { command: "cat out.txt" } }] },
      done,
    ]);
    assert.ok(/(build output line 0123456789\\n){20}/.test(m.sent), "the command's output never reached the model");
    within("huge-output", m, CEILINGS.hugeOutput);
  });
});

/** Distinct numbered lines, so nothing upstream can compress or dedupe them. */
function bigText(bytes: number): string {
  const lines: string[] = [];
  let size = 0;
  for (let i = 0; size < bytes; i++) {
    const line = `line ${i} ${"abcdefghij".repeat(6)}`;
    lines.push(line);
    size += line.length + 1;
  }
  return lines.join("\n") + "\n";
}
