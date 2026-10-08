import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Archive } from "../src/archive.js";
import { Engine, type EngineConfig } from "../src/engine.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";
import { breakdown, summarize, table, type Summary } from "./lean-breakdown.js";

/**
 * Lean sessions: where a long session's request characters go.
 *
 * Two long sessions, both scripted (no model, no network):
 *
 *   long-shed  scenario d of the lean-budget suite: 60 bash steps of ~6 KB each
 *   replay     a real 92-step bench run (duration-bug, Mistral Large 4,
 *              2026-10-07) replayed call for call: the assistant turns and tool
 *              results recovered verbatim from its exuviae, the last 7 steps
 *              from its journal (command, and a result of the recorded size)
 *
 * Each run prints a breakdown of every request by component (see
 * lean-breakdown.ts). The env flags of the lean-sessions prototypes apply, so
 * the same test measures a prototype: `MAAT_LEAN_X=1 node --test ...`. With
 * LEAN_SESSIONS_OUT=<file> the summaries are also written there as JSON.
 *
 * The assertions only prove each scenario really ran to its end; the ceilings
 * live in lean-budget.test.ts.
 */

type Call = { name: string; args: Record<string, unknown> };
/** `writes`: files the replay puts in place before the turn's calls run. */
type Turn = { text?: string; calls?: Call[]; writes?: [string, string][] };

/**
 * `realistic` reports usage the way a caching provider does: prompt tokens at
 * molt's own chars/4, and the leading messages shared with the previous
 * request as cached. Molt's cache-protection (elision deferral) keys on that,
 * so the replay measures what a real cached session would do. Off, usage is
 * the flat 100/20 the lean-budget suite reports.
 */
function provider(turns: Turn[], dir: string, realistic = false): { fetchFn: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let n = 0;
  let id = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const turn = turns[Math.min(n, turns.length - 1)]!;
    n += 1;
    for (const [p, body] of turn.writes ?? []) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), body);
    }
    const usage = realistic
      ? (() => {
          const b = bodies.at(-1)!;
          const prev = bodies.at(-2);
          const kept = prev ? breakdown(b, prev).stablePrefix : 0;
          return {
            prompt_tokens: Math.ceil(b.length / 4),
            completion_tokens: 20,
            prompt_tokens_details: { cached_tokens: Math.floor(kept / 4) },
          };
        })()
      : { prompt_tokens: 100, completion_tokens: 20 };
    const message = {
      role: "assistant",
      content: turn.text ?? null,
      ...(turn.calls?.length
        ? {
            tool_calls: turn.calls.map((c) => ({
              id: `call_${++id}`,
              type: "function",
              function: { name: c.name, arguments: JSON.stringify(c.args) },
            })),
          }
        : {}),
    };
    return {
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message }], usage }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

async function run(
  turns: Turn[],
  opts: { setup?: (dir: string) => void; task: string; archive?: boolean; realistic?: boolean; cfg?: Partial<EngineConfig> },
): Promise<{ bodies: string[]; events: EngineEvent[]; sent: string }> {
  const ws = workspace();
  try {
    opts.setup?.(ws.dir);
    const p = provider(turns, ws.dir, opts.realistic);
    const engine = new Engine({
      baseUrl: "http://p.test/v1",
      model: "m",
      cwd: ws.dir,
      fetchFn: p.fetchFn,
      bar: null,
      stream: false,
      autonomy: "high",
      maxSteps: 0,
      ...(opts.archive ? { archive: new Archive(join(ws.dir, ".maat", "exuviae")) } : {}),
      ...opts.cfg,
    });
    const events = await drain(engine.run(opts.task, allowAll));
    return { bodies: p.bodies, events, sent: p.bodies.join("\n") };
  } finally {
    ws.cleanup();
  }
}

/** The long-shed scenario, exactly as lean-budget d runs it. */
export function longShedTurns(): Turn[] {
  return [
    ...Array.from({ length: 60 }, (_, i) => ({
      calls: [{ name: "bash", args: { command: `printf '%.0sstep ${i} output line\\n' $(seq 1 300)` } }],
    })),
    { text: "Done." },
  ];
}

type Fixture = {
  source: string;
  task: string;
  steps: { text: string; calls: { name: string; args: Record<string, unknown>; result: string }[] }[];
  tail: { textChars: number; calls: { name: string; detail: string; bytes: number }[] }[];
};

function root(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    try {
      readFileSync(join(dir, "package.json"));
      return dir;
    } catch {
      dir = dirname(dir);
    }
  }
  throw new Error("could not find the project root");
}

/** Code-shaped filler of exactly `bytes` bytes, distinct per seed: the tail's results. */
function filler(bytes: number, seed: string): string {
  let out = "";
  for (let i = 0; out.length < bytes; i++) out += `${seed}:${i}    const value${i} = compute(input, ${i}); // ${"x".repeat(i % 40)}\n`;
  return out.slice(0, bytes);
}

const prose = (chars: number) => "Checking the next part of the code. ".repeat(Math.ceil(chars / 36)).slice(0, chars);

/**
 * The replay: each real bash call becomes `cat` of a file holding its real
 * output, followed by the original command as a comment, so the call's
 * arguments are the same size as the model's and the result is byte for byte
 * what the model saw. One file per distinct command, rewritten with that
 * step's output just before the step runs: a rerun is the same call here too,
 * and comes back the same or different exactly as it did. read_file and
 * write_file run as they were.
 */
export function replay(fx: Fixture): { turns: Turn[]; files: Map<string, string>; task: string } {
  const files = new Map<string, string>();
  const byCmd = new Map<string, string>();
  const fxFile = (cmd: string): string => {
    let f = byCmd.get(cmd);
    if (!f) {
      f = `.fx/${String(byCmd.size).padStart(3, "0")}.txt`;
      byCmd.set(cmd, f);
    }
    return f;
  };
  const turns: Turn[] = [];
  const step = (text: string | undefined, calls: { name: string; args?: Record<string, unknown>; cmd?: string; out?: string }[]) => {
    const writes: [string, string][] = [];
    const out: Call[] = calls.map((c) => {
      if (c.cmd === undefined) return { name: c.name, args: c.args ?? {} };
      const cmd = c.cmd.replace(/\s+/g, " ");
      const f = fxFile(cmd);
      writes.push([f, c.out ?? ""]);
      return { name: "bash", args: { command: `cat ${f} # ${cmd}` } };
    });
    turns.push({ ...(text ? { text } : {}), calls: out, writes });
  };
  for (const s of fx.steps) {
    for (const c of s.calls)
      if (c.name === "read_file" && !files.has(String(c.args.path))) files.set(String(c.args.path), c.result);
    step(
      s.text,
      s.calls.map((c) => (c.name === "bash" ? { name: "bash", cmd: String(c.args.command ?? ""), out: c.result } : c)),
    );
  }
  fx.tail.forEach((s, i) =>
    step(
      s.textChars ? prose(s.textChars) : undefined,
      s.calls.map((c, k) => ({ name: "bash", cmd: c.detail, out: filler(c.bytes, `t${i}.${k}`) })),
    ),
  );
  turns.push({ text: "Done." });
  return { turns, files, task: fx.task };
}

/** Real bench runs with their exuviae: see test/fixtures/README.md. */
export const REPLAYS = ["duration-bug", "perf-pairs"] as const;

export function loadFixture(name: (typeof REPLAYS)[number]): Fixture {
  return JSON.parse(readFileSync(join(root(), "test", "fixtures", `lean-replay-${name}.json`), "utf8")) as Fixture;
}

const results: Record<string, Summary & { sheds: number; ageings: number }> = {};

function report(name: string, bodies: string[], events: EngineEvent[] = []): Summary & { sheds: number; ageings: number } {
  const s = {
    ...summarize(bodies),
    sheds: events.filter((e) => e.kind === "shed").length,
    ageings: events.filter((e) => e.kind === "info" && /^aged \d+ older/.test(String((e as { text?: string }).text))).length,
  };
  results[name] = s;
  console.log(`${table(`lean-sessions ${name}`, s)}\n  sheds ${s.sheds}, ageing passes ${s.ageings}`);
  if (process.env.LEAN_SESSIONS_OUT) {
    mkdirSync(dirname(process.env.LEAN_SESSIONS_OUT), { recursive: true });
    writeFileSync(process.env.LEAN_SESSIONS_OUT, JSON.stringify(results, null, 1));
  }
  return s;
}

describe("lean sessions: where a long session's characters go", () => {
  it("long-shed (lean-budget d)", async () => {
    const r = await run(longShedTurns(), { task: "a long job" });
    assert.ok(/step 59 output line/.test(r.sent), "the session ended before its last step");
    const s = report("long-shed", r.bodies, r.events);
    assert.equal(s.steps, 61);
  });

  it("long-shed with a caching provider", async () => {
    const r = await run(longShedTurns(), { task: "a long job", realistic: true });
    assert.ok(/step 59 output line/.test(r.sent), "the session ended before its last step");
    report("long-shed-cached", r.bodies, r.events);
  });

  for (const name of REPLAYS) {
    it(`replay of a real bench run: ${name}`, async () => {
      const fx = loadFixture(name);
      const { turns, files, task } = replay(fx);
      const r = await run(turns, {
        task,
        archive: true,
        realistic: true,
        setup: (dir) => {
          for (const [p, body] of files) writeFileSync(join(dir, p), body);
        },
      });
      if (process.env.LEAN_DEBUG)
        for (const e of r.events.slice(-12)) console.log("EV", e.kind, JSON.stringify(e).slice(0, 300));
      // The last real result and the last synthetic one both reached the model.
      const lastReal = fx.steps.at(-1)!.calls.at(-1)!.result.split("\n").find((l) => l.trim().length > 20)!;
      assert.ok(r.sent.includes(JSON.stringify(lastReal).slice(1, -1)), "the replay stopped before its last real step");
      const lastTail = fx.tail
        .flatMap((t, i) => t.calls.map((c, k) => ({ c, tag: `t${i}.${k}:` })))
        .filter((x) => x.c.bytes > 0)
        .at(-1);
      if (lastTail) assert.ok(r.sent.includes(lastTail.tag), "the replay stopped before its tail");
      const s = report(`replay-${name}`, r.bodies, r.events);
      assert.equal(s.steps, turns.length);
    });
  }
});
