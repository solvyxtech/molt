/**
 * Model-format quirks that used to be misread into a different outcome.
 *
 * The rule: a quirk is either read when its meaning is not in doubt, or the
 * model is told what was wrong. It is never turned silently into something
 * else — two parallel calls fused into one malformed call, an arguments object
 * dropped as "no arguments", a reply cut off by a dropped connection taken as
 * a finished answer.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { Engine } from "../src/engine.js";
import { narratedCallIn, MOLT_TOOL_NAMES } from "../src/narrated.js";
import { StreamAccumulator, normalizeMessage, readStream, type StreamChunk } from "../src/stream.js";
import type { Msg } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

function sse(chunks: unknown[], done = true): Response {
  const text = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : "");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const tc = (delta: unknown, finish: string | null = null): StreamChunk => ({ choices: [{ delta: delta as never, finish_reason: finish }] });

describe("tool_call deltas", () => {
  it("keep parallel calls apart when the provider sends no index, only ids", () => {
    const acc = new StreamAccumulator();
    acc.push(tc({ tool_calls: [{ id: "a", function: { name: "write_file", arguments: '{"path":"a.txt",' } }] }));
    acc.push(tc({ tool_calls: [{ function: { arguments: '"content":"A"}' } }] }));
    acc.push(tc({ tool_calls: [{ id: "b", function: { name: "write_file", arguments: '{"path":"b.txt","content":"B"}' } }] }, "tool_calls"));
    const calls = acc.finish().message.tool_calls!;
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((c) => [c.id, c.function.name]), [["a", "write_file"], ["b", "write_file"]]);
    assert.deepEqual(JSON.parse(calls[0]!.function.arguments), { path: "a.txt", content: "A" });
    assert.deepEqual(JSON.parse(calls[1]!.function.arguments), { path: "b.txt", content: "B" });
  });

  it("keep calls apart when every one claims index 0 but each carries its own id", () => {
    const acc = new StreamAccumulator();
    acc.push(tc({ tool_calls: [{ index: 0, id: "x", function: { name: "read_file", arguments: '{"path":"a"}' } }] }));
    acc.push(tc({ tool_calls: [{ index: 0, id: "y", function: { name: "list_dir", arguments: '{"path":"."}' } }] }, "tool_calls"));
    const calls = acc.finish().message.tool_calls!;
    assert.deepEqual(calls.map((c) => [c.id, c.function.name, c.function.arguments]), [
      ["x", "read_file", '{"path":"a"}'],
      ["y", "list_dir", '{"path":"."}'],
    ]);
  });

  it("still join a call whose id is re-sent on every fragment", () => {
    const acc = new StreamAccumulator();
    acc.push(tc({ tool_calls: [{ index: 0, id: "x", function: { name: "read_file", arguments: '{"pa' } }] }));
    acc.push(tc({ tool_calls: [{ index: 0, id: "x", function: { name: "read_file", arguments: 'th":"a"}' } }] }));
    const calls = acc.finish().message.tool_calls!;
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.function.name, "read_file");
    assert.equal(calls[0]!.function.arguments, '{"path":"a"}');
  });

  it("read arguments sent as an object instead of a JSON string", () => {
    const acc = new StreamAccumulator();
    acc.push(tc({ tool_calls: [{ index: 0, id: "x", function: { name: "read_file", arguments: { path: "a.txt" } } }] }, "tool_calls"));
    assert.equal(acc.finish().message.tool_calls![0]!.function.arguments, '{"path":"a.txt"}');
  });
});

describe("normalizeMessage", () => {
  it("turns object arguments into a string, fills missing ids and separates duplicates", () => {
    const m = normalizeMessage({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "same", function: { name: "read_file", arguments: { path: "a" } } },
        { id: "same", function: { name: "read_file", arguments: '{"path":"b"}' } },
        { function: { name: "list_dir" } },
      ],
    } as unknown as Msg);
    const calls = m.tool_calls!;
    assert.equal(calls[0]!.function.arguments, '{"path":"a"}');
    assert.equal(calls[2]!.function.arguments, "");
    assert.equal(new Set(calls.map((c) => c.id)).size, 3);
    assert.ok(calls.every((c) => typeof c.id === "string" && c.id.length > 0));
  });

  it("reads content sent as a list of text parts", () => {
    const m = normalizeMessage({ role: "assistant", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] } as unknown as Msg);
    assert.equal(m.content, "hello world");
  });
});

describe("a stream that ends without saying it finished", () => {
  it("is an error, not a finished answer", async () => {
    const body = sse([tc({ content: "I have updated the file and" })], false).body!;
    await assert.rejects(readStream(body, () => {}), /ended before the model finished/);
  });

  it("is fine when a finish_reason or [DONE] arrived", async () => {
    const a = await readStream(sse([tc({ content: "ok" }, "stop")], false).body!, () => {});
    assert.equal(a.message.content, "ok");
    const b = await readStream(sse([tc({ content: "ok" })], true).body!, () => {});
    assert.equal(b.message.content, "ok");
  });

  it("makes the engine ask again rather than treat the half sentence as a claim", async () => {
    const w = workspace();
    try {
      let n = 0;
      const fetchFn = (async () => {
        n += 1;
        if (n === 1) return sse([tc({ content: "Done, I have written the" })], false);
        return sse([tc({ content: "the whole answer" }), tc({}, "stop")]);
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: true, bar: null, retryBackoffMs: [0, 0, 0] });
      const events = await drain(engine.run("q", allowAll));
      assert.equal(n, 2);
      const texts = events.filter((e) => e.kind === "assistant_text").map((e) => (e as { text: string }).text);
      assert.deepEqual(texts, ["the whole answer"]);
    } finally {
      w.cleanup();
    }
  });
});

describe("engine", () => {
  it("runs two parallel streamed calls that carry no index", async () => {
    const w = workspace();
    try {
      let n = 0;
      const fetchFn = (async () => {
        n += 1;
        if (n > 1) return sse([tc({ content: "done" }, "stop")]);
        return sse([
          tc({ tool_calls: [{ id: "a", type: "function", function: { name: "write_file", arguments: '{"path":"a.txt","content":"A"}' } }] }),
          tc({ tool_calls: [{ id: "b", type: "function", function: { name: "write_file", arguments: '{"path":"b.txt","content":"B"}' } }] }, "tool_calls"),
        ]);
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: true, bar: null });
      await drain(engine.run("write both", allowAll));
      assert.equal(readFileSync(join(w.dir, "a.txt"), "utf8"), "A");
      assert.equal(readFileSync(join(w.dir, "b.txt"), "utf8"), "B");
    } finally {
      w.cleanup();
    }
  });

  it("runs an unstreamed call whose arguments are an object, and sends them back as a string", async () => {
    const w = workspace();
    try {
      const bodies: { messages: Msg[] }[] = [];
      let n = 0;
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        n += 1;
        bodies.push(JSON.parse(String(init?.body)));
        const message =
          n === 1
            ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: { path: "o.txt", content: "obj" } } }] }
            : { role: "assistant", content: [{ type: "text", text: "all done" }] };
        return new Response(JSON.stringify({ choices: [{ message, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: false, bar: null });
      const events = await drain(engine.run("write", allowAll));
      assert.ok(existsSync(join(w.dir, "o.txt")));
      assert.equal(readFileSync(join(w.dir, "o.txt"), "utf8"), "obj");
      const sent = bodies[1]!.messages.find((m) => m.tool_calls)!;
      assert.equal(typeof sent.tool_calls![0]!.function.arguments, "string");
      const texts = events.filter((e) => e.kind === "assistant_text").map((e) => (e as { text: string }).text);
      assert.deepEqual(texts, ["all done"]);
    } finally {
      w.cleanup();
    }
  });
});

describe("batch mode written as text", () => {
  const names = [...MOLT_TOOL_NAMES, "act"];
  it("is recognised when the model writes the act call out in a code block", () => {
    const text = 'Here is the plan.\n```json\n{"name":"act","arguments":{"analysis":"x","actions":[{"tool":"bash","args":{"command":"ls"}}]}}\n```';
    assert.equal(narratedCallIn(text), null, "act is not one of the default names");
    assert.match(narratedCallIn(text, names) ?? "", /JSON tool call/);
  });

  it("makes the batch engine tell the model instead of reading the reply as finished", async () => {
    const w = workspace();
    try {
      let n = 0;
      const bodies: { messages: Msg[] }[] = [];
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        n += 1;
        bodies.push(JSON.parse(String(init?.body)));
        const content =
          n === 1
            ? 'Writing it now.\n```json\n{"name":"act","arguments":{"analysis":"x","actions":[{"tool":"write_file","args":{"path":"z.txt","content":"z"}}]}}\n```'
            : "finished";
        return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      const engine = new Engine({ baseUrl: "http://provider.test/v1", model: "m", cwd: w.dir, fetchFn, stream: false, bar: null, batch: true });
      await drain(engine.run("write z", allowAll));
      assert.ok(n >= 2);
      const last = bodies[1]!.messages.at(-1)!;
      assert.match(String(last.content), /shaped like a tool call/);
    } finally {
      w.cleanup();
    }
  });
});
