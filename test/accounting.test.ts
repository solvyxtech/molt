/**
 * What a turn cost, and how much of that molt actually knows.
 *
 * The meter is the one number people quote back at each other, so its
 * failure mode is not "wrong by a bit" — it is "wrong and confident".
 * These pin the three ways that happened: usage never asked for while
 * streaming (so every figure was a chars/4 guess wearing a measurement's
 * clothes), cached prompt tokens billed at the full rate, and a provider's
 * own dollar figure ignored in favour of molt's arithmetic.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import type { EngineEvent, Msg } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

type Usage = Record<string, unknown>;

/** A JSON provider that replays turns and records every request body. */
function jsonProvider(turns: { message: Msg; usage?: Usage }[]) {
  const bodies: unknown[] = [];
  let n = 0;
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const turn = turns[Math.min(n, turns.length - 1)]!;
    n += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      json: async () => ({
        choices: [{ message: turn.message, finish_reason: "stop" }],
        ...(turn.usage === undefined ? {} : { usage: turn.usage }),
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

/** An SSE provider, because streaming is the default and the path that broke. */
function sseProvider(opts: { frames: string[]; rejectStreamOptions?: boolean }) {
  const bodies: Record<string, unknown>[] = [];
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    if (opts.rejectStreamOptions && body.stream_options) {
      return {
        ok: false,
        status: 400,
        headers: { get: () => "application/json" },
        clone: () => ({ text: async () => '{"error":"unknown field: stream_options"}' }),
        text: async () => '{"error":"unknown field: stream_options"}',
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => "text/event-stream" },
      body: new ReadableStream<Uint8Array>({
        start(c) {
          const enc = new TextEncoder();
          for (const f of opts.frames) c.enqueue(enc.encode(f));
          c.close();
        },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, bodies };
}

const say = (text: string): Msg => ({ role: "assistant", content: text });

function engineWith(dir: string, over: Record<string, unknown>) {
  return new Engine({
    baseUrl: "http://provider.test/v1",
    model: "m",
    provider: "test",
    cwd: dir,
    bar: null,
    ...over,
  });
}

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("token counts molt did not have to guess", () => {
  it("asks for usage when streaming, because streaming responses omit it", async () => {
    const ws = workspace();
    try {
      const p = sseProvider({
        frames: [
          frame({ choices: [{ delta: { content: "hi" }, finish_reason: null }] }),
          frame({ choices: [{ delta: {}, finish_reason: "stop" }] }),
          frame({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 30 } }),
          "data: [DONE]\n\n",
        ],
      });
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: true });
      const events = await drain(engine.run("hello", allowAll));

      assert.deepEqual(p.bodies[0]!.stream_options, { include_usage: true });
      const usage = events.find((e) => e.kind === "usage");
      assert.equal(usage?.kind === "usage" && usage.promptTokens, 900);
      assert.equal(usage?.kind === "usage" && usage.estimated, false);
    } finally {
      ws.cleanup();
    }
  });

  it("keeps a genuine 400 a genuine 400", async () => {
    const ws = workspace();
    try {
      // Every request fails, field or no field. The turn must report the
      // error rather than blame a header — and usage reporting must stay on
      // for a provider that never actually refused it.
      let calls = 0;
      const fetchFn = (async () => {
        calls++;
        return {
          ok: false,
          status: 400,
          headers: { get: () => "application/json" },
          text: async () => '{"error":"no such model"}',
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const engine = engineWith(ws.dir, { fetchFn, stream: true });
      const events = await drain(engine.run("hello", allowAll));
      assert.equal(calls, 2, "did not try once without the field");
      assert.ok(events.some((e) => e.kind === "error" && /400/.test(e.text)));

      // Next turn still asks: nothing proved the field was the problem.
      await drain(engine.run("again", allowAll));
      assert.equal(calls, 4);
    } finally {
      ws.cleanup();
    }
  });

  it("drops the request and says so when a provider refuses it", async () => {
    const ws = workspace();
    try {
      const p = sseProvider({
        rejectStreamOptions: true,
        frames: [
          frame({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ],
      });
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: true });
      const events = await drain(engine.run("hello", allowAll));

      // Asked once, refused, retried without — and the turn still lands.
      assert.equal(p.bodies.length, 2);
      assert.ok(p.bodies[0]!.stream_options);
      assert.ok(!p.bodies[1]!.stream_options);
      assert.ok(events.some((e) => e.kind === "assistant_text"));

      // The refusal is remembered: the next turn does not re-ask.
      const before = p.bodies.length;
      await drain(engine.run("again", allowAll));
      assert.ok(!p.bodies[before]!.stream_options, "re-asked a provider that already said no");
    } finally {
      ws.cleanup();
    }
  });

  it("marks a cost that rests on an estimate", async () => {
    const ws = workspace();
    try {
      // A provider that reports no usage at all — molt has to count, and
      // has to say that it counted.
      const p = jsonProvider([{ message: say("done") }]);
      const engine = engineWith(ws.dir, {
        fetchFn: p.fetchFn,
        stream: false,
        priceInPerMtok: 2,
        priceOutPerMtok: 6,
      });
      await drain(engine.run("hello", allowAll));
      assert.equal(engine.costEstimated, true);
      assert.ok((engine.costUsd() ?? 0) > 0);
    } finally {
      ws.cleanup();
    }
  });
});

describe("what the session actually costs", () => {
  const spend = (dir: string, over: Record<string, unknown>, usage: Usage) => {
    const p = jsonProvider([{ message: say("done"), usage }]);
    return {
      engine: engineWith(dir, { fetchFn: p.fetchFn, stream: false, ...over }),
    };
  };

  it("bills cached prompt tokens at the cache rate, not the full one", async () => {
    const ws = workspace();
    try {
      const { engine } = spend(
        ws.dir,
        { priceInPerMtok: 2, priceOutPerMtok: 6, priceCachedInPerMtok: 0.5 },
        {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 800_000 },
        },
      );
      await drain(engine.run("hello", allowAll));
      // 200k fresh at $2/M + 800k cached at $0.50/M = $0.40 + $0.40.
      assert.equal(engine.costUsd(), 0.8);
      assert.equal(engine.sessionCachedTokens, 800_000);
    } finally {
      ws.cleanup();
    }
  });

  it("charges the full rate when no cache rate is known", async () => {
    const ws = workspace();
    try {
      const { engine } = spend(
        ws.dir,
        { priceInPerMtok: 2, priceOutPerMtok: 6 },
        {
          prompt_tokens: 1_000_000,
          completion_tokens: 0,
          prompt_tokens_details: { cached_tokens: 800_000 },
        },
      );
      await drain(engine.run("hello", allowAll));
      assert.equal(engine.costUsd(), 2);
    } finally {
      ws.cleanup();
    }
  });

  it("prefers the provider's own dollar figure to molt's arithmetic", async () => {
    const ws = workspace();
    try {
      const { engine } = spend(
        ws.dir,
        { priceInPerMtok: 99, priceOutPerMtok: 99 },
        { prompt_tokens: 1000, completion_tokens: 100, cost: 0.0031 },
      );
      await drain(engine.run("hello", allowAll));
      assert.equal(engine.costUsd(), 0.0031);
      assert.equal(engine.costBilled, true);
    } finally {
      ws.cleanup();
    }
  });

  it("does not blend a billed step with an unbilled one", async () => {
    const ws = workspace();
    try {
      // A total that counts one step's bill and ignores another's is neither
      // figure, and is wrong in the direction of too small.
      const p = jsonProvider([
        {
          message: { role: "assistant", content: null, tool_calls: [
            { id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
          ] },
          usage: { prompt_tokens: 1000, completion_tokens: 10, cost: 0.001 },
        },
        { message: say("done"), usage: { prompt_tokens: 1000, completion_tokens: 10 } },
      ]);
      const engine = engineWith(ws.dir, {
        fetchFn: p.fetchFn,
        stream: false,
        priceInPerMtok: 2,
        priceOutPerMtok: 6,
      });
      await drain(engine.run("hello", allowAll));
      assert.equal(engine.costBilled, false);
      // Priced from tokens: 2000 in at $2/M + 20 out at $6/M.
      assert.equal(Number(engine.costUsd()!.toFixed(6)), 0.00412);
    } finally {
      ws.cleanup();
    }
  });

  it("clears the meter when the session is reset", async () => {
    const ws = workspace();
    try {
      const { engine } = spend(
        ws.dir,
        { priceInPerMtok: 2, priceOutPerMtok: 6 },
        { prompt_tokens: 1000, completion_tokens: 10 },
      );
      await drain(engine.run("hello", allowAll));
      assert.ok(engine.sessionTokens > 0);
      engine.reset();
      assert.equal(engine.sessionTokens, 0);
      assert.equal(engine.costUsd(), 0);
    } finally {
      ws.cleanup();
    }
  });
});

describe("what the model is doing, on the record", () => {
  const toolTurn = (name: string, args: Record<string, unknown>): Msg => ({
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } },
    ],
  });

  it("closes every step with what it did and what it cost", async () => {
    const ws = workspace();
    try {
      const p = jsonProvider([
        { message: toolTurn("read_file", { path: "a.txt" }), usage: { prompt_tokens: 100, completion_tokens: 10 } },
        { message: say("done"), usage: { prompt_tokens: 200, completion_tokens: 20 } },
      ]);
      const engine = engineWith(ws.dir, {
        fetchFn: p.fetchFn,
        stream: false,
        priceInPerMtok: 2,
        priceOutPerMtok: 6,
      });
      const events = await drain(engine.run("read it", allowAll));
      const steps = events.filter((e): e is Extract<EngineEvent, { kind: "step_summary" }> =>
        e.kind === "step_summary",
      );

      assert.equal(steps.length, 2);
      assert.deepEqual(steps[0]!.tools, ["read_file"]);
      assert.equal(steps[0]!.outcome, "tools");
      assert.equal(steps[1]!.outcome, "claim");
      assert.equal(steps[1]!.spend.promptTokens, 200);
      // Per-step cost, so a surprising total has a line it came from.
      assert.equal(Number(steps[0]!.spend.costUsd!.toFixed(6)), 0.00026);
      assert.equal(steps[1]!.sessionTokens, 330);
    } finally {
      ws.cleanup();
    }
  });

  it("says what is about to be sent before it is sent", async () => {
    const ws = workspace();
    try {
      const p = jsonProvider([{ message: say("done"), usage: { prompt_tokens: 10, completion_tokens: 2 } }]);
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: false });
      const events = await drain(engine.run("hello", allowAll));
      const req = events.find((e) => e.kind === "request");
      assert.ok(req && req.kind === "request");
      assert.equal(req.model, "m");
      assert.ok(req.messages > 0);
      assert.ok(req.estTokens > 0);
    } finally {
      ws.cleanup();
    }
  });

  it("carries the exact call and the head of its result, verbatim", async () => {
    const ws = workspace();
    try {
      const p = jsonProvider([
        { message: toolTurn("bash", { command: "echo hello-from-the-tool" }), usage: { prompt_tokens: 1, completion_tokens: 1 } },
        { message: say("done"), usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]);
      const engine = engineWith(ws.dir, { fetchFn: p.fetchFn, stream: false });
      const events = await drain(engine.run("run it", allowAll));
      const tool = events.find((e) => e.kind === "tool");
      assert.ok(tool && tool.kind === "tool");
      assert.match(tool.args ?? "", /echo hello-from-the-tool/);
      assert.match(tool.preview ?? "", /hello-from-the-tool/);
      assert.ok((tool.bytes ?? 0) > 0);
    } finally {
      ws.cleanup();
    }
  });

  it("names the checks it is about to run, not just how many", async () => {
    const ws = workspace();
    try {
      const p = jsonProvider([{ message: say("done"), usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
      const engine = engineWith(ws.dir, {
        fetchFn: p.fetchFn,
        stream: false,
        bar: { version: 1, checks: [{ name: "typecheck", kind: "command", run: "true", timeoutMs: 1000, expectExit: 0, tags: [] }] },
      });
      const events = await drain(engine.run("go", allowAll));
      const start = events.find((e) => e.kind === "proof_start");
      assert.ok(start && start.kind === "proof_start");
      assert.deepEqual(start.names, ["typecheck"]);
    } finally {
      ws.cleanup();
    }
  });
});
