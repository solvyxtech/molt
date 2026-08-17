/**
 * Streaming tests.
 *
 * The transport is not the risky part — delta reassembly is. Tool call
 * arguments arrive split at arbitrary byte offsets, and getting it wrong
 * fails SILENTLY: the JSON is malformed, the tool call becomes empty, and
 * the agent appears to simply not act. So the splits here are chosen to be
 * hostile, not convenient.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { loadBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import { SseParser, StreamAccumulator, readStream } from "../src/stream.js";
import { allowAll, drain, kinds, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));
function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function sse(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function streamOf(text: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}
/** Deliver a payload in fixed-size slices, ignoring frame boundaries. */
function chunkedStream(text: string, size: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  let i = 0;
  return new ReadableStream({
    pull(c) {
      if (i >= bytes.length) {
        c.close();
        return;
      }
      c.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
}

describe("SseParser", () => {
  it("extracts payloads and honours [DONE]", () => {
    const p = new SseParser();
    const out = p.push('data: {"a":1}\n\ndata: {"a":2}\n\ndata: [DONE]\n\n');
    assert.deepEqual(out, ['{"a":1}', '{"a":2}']);
    assert.equal(p.done, true);
  });

  it("survives events split mid-line across reads", () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: {"a'), []);
    assert.deepEqual(p.push('":1}\n'), []);
    assert.deepEqual(p.push("\n"), ['{"a":1}']);
  });

  it("ignores comments and non-data fields", () => {
    const p = new SseParser();
    assert.deepEqual(p.push(': ping\nevent: message\ndata: {"a":1}\n\n'), ['{"a":1}']);
  });

  it("handles CRLF line endings", () => {
    const p = new SseParser();
    assert.deepEqual(p.push('data: {"a":1}\r\n\r\n'), ['{"a":1}']);
  });

  it("returns a trailing event that never got its blank line", () => {
    const p = new SseParser();
    p.push('data: {"a":1}');
    assert.deepEqual(p.flush(), ['{"a":1}']);
  });
});

describe("StreamAccumulator", () => {
  it("concatenates content deltas", () => {
    const a = new StreamAccumulator();
    assert.equal(a.push({ choices: [{ delta: { content: "Hel" } }] }), "Hel");
    a.push({ choices: [{ delta: { content: "lo" } }] });
    assert.equal(a.finish().message.content, "Hello");
  });

  it("reassembles tool arguments split at a hostile boundary", () => {
    const a = new StreamAccumulator();
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file" } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"src/a' } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'uth.ts","content":"x' } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"}' } }] } }] });

    const call = a.finish().message.tool_calls![0];
    assert.equal(call.function.name, "write_file");
    const args = JSON.parse(call.function.arguments) as { path: string; content: string };
    assert.equal(args.path, "src/auth.ts");
    assert.equal(args.content, "x");
  });

  it("keeps parallel tool calls separate by index", () => {
    const a = new StreamAccumulator();
    a.push({ choices: [{ delta: { tool_calls: [
      { index: 0, id: "a", function: { name: "read_file", arguments: '{"path":"' } },
      { index: 1, id: "b", function: { name: "bash", arguments: '{"command":"' } },
    ] } }] });
    a.push({ choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: 'ls"}' } },
      { index: 0, function: { arguments: 'a.ts"}' } },
    ] } }] });

    const calls = a.finish().message.tool_calls!;
    assert.equal(calls.length, 2);
    assert.equal(JSON.parse(calls[0].function.arguments).path, "a.ts");
    assert.equal(JSON.parse(calls[1].function.arguments).command, "ls");
  });

  it("reassembles a name delivered in fragments", () => {
    const a = new StreamAccumulator();
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "write" } }] } }] });
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: "_file" } }] } }] });
    assert.equal(a.finish().message.tool_calls![0].function.name, "write_file");
  });

  it("tolerates a provider that omits index for a single call", () => {
    const a = new StreamAccumulator();
    a.push({ choices: [{ delta: { tool_calls: [{ index: undefined as unknown as number, id: "z", function: { name: "bash", arguments: "{}" } }] } }] });
    assert.equal(a.finish().message.tool_calls!.length, 1);
  });

  it("picks up usage from the final frame", () => {
    const a = new StreamAccumulator();
    a.push({ choices: [{ delta: { content: "hi" } }] });
    a.push({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } });
    const r = a.finish();
    assert.equal(r.promptTokens, 11);
    assert.equal(r.completionTokens, 3);
  });

  it("leaves content null when only tool calls arrived", () => {
    const a = new StreamAccumulator();
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{}" } }] } }] });
    assert.equal(a.finish().message.content, null);
  });
});

describe("readStream", () => {
  it("emits fragments incrementally as they arrive", async () => {
    const body =
      sse({ choices: [{ delta: { content: "one " } }] }) +
      sse({ choices: [{ delta: { content: "two " } }] }) +
      sse({ choices: [{ delta: { content: "three" } }] }) +
      "data: [DONE]\n\n";

    const seen: string[] = [];
    const result = await readStream(streamOf(body), (f) => seen.push(f));
    assert.deepEqual(seen, ["one ", "two ", "three"]);
    assert.equal(result.message.content, "one two three");
  });

  it("survives the payload being sliced every 7 bytes", async () => {
    const body =
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "write_file", arguments: '{"path":"deep/nested/file.ts","content":"hello world"}' } }] } }] }) +
      sse({ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";

    const result = await readStream(chunkedStream(body, 7), () => {});
    const call = result.message.tool_calls![0];
    const args = JSON.parse(call.function.arguments) as { path: string; content: string };
    assert.equal(args.path, "deep/nested/file.ts");
    assert.equal(args.content, "hello world");
    assert.equal(result.finishReason, "stop");
  });

  it("skips one malformed frame rather than losing the turn", async () => {
    const body =
      sse({ choices: [{ delta: { content: "good " } }] }) +
      "data: {not json at all\n\n" +
      sse({ choices: [{ delta: { content: "still good" } }] }) +
      "data: [DONE]\n\n";
    const result = await readStream(streamOf(body), () => {});
    assert.equal(result.message.content, "good still good");
  });
});

describe("streaming through the engine", () => {
  async function sseServer(frames: string[]): Promise<{ url: string }> {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const f of frames) res.write(f);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    cleanups.push(() => server.close());
    return { url: `http://127.0.0.1:${port}/v1` };
  }

  it("yields deltas and still runs the proof gate", async () => {
    const dir = ws();
    mkdirSync(join(dir, ".molt"), { recursive: true });
    writeFileSync(
      join(dir, ".molt", "done.yml"),
      "version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n",
    );

    const { url } = await sseServer([
      sse({ choices: [{ delta: { content: "All " } }] }),
      sse({ choices: [{ delta: { content: "done." }, finish_reason: "stop" }] }),
      "data: [DONE]\n\n",
    ]);

    const engine = new Engine({
      baseUrl: url,
      model: "m",
      cwd: dir,
      bar: loadBar(dir),
      archive: new Archive(dir),
      receipts: new Receipts(dir),
      maxProofAttempts: 1,
    });

    const events = await drain(engine.run("do it", allowAll));
    const order = kinds(events);
    assert.ok(order.includes("delta"), "fragments must reach the caller");

    const deltas = events
      .filter((e): e is { kind: "delta"; text: string } => e.kind === "delta")
      .map((e) => e.text)
      .join("");
    assert.equal(deltas, "All done.");

    // Streaming must not weaken the gate: nothing was written, so refuse.
    assert.ok(order.includes("proof_exhausted"));
    assert.ok(!order.includes("assistant_text"), "an unproven claim is not emitted");
  });

  it("falls back to JSON when the provider does not stream", async () => {
    const dir = ws();
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { role: "assistant", content: "plain response" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    cleanups.push(() => server.close());

    const engine = new Engine({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m",
      cwd: dir,
      bar: null,
    });
    const events = await drain(engine.run("hi", allowAll));
    const text = events.find((e) => e.kind === "assistant_text") as { text: string } | undefined;
    assert.equal(text?.text, "plain response");
  });

  it("leaves the transcript untouched when cancelled mid-stream", async () => {
    const dir = ws();
    const server = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(sse({ choices: [{ delta: { content: "partial" } }] }));
        // then hang, so the only way out is cancellation
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    cleanups.push(() => server.close());

    const engine = new Engine({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "m",
      cwd: dir,
      bar: null,
    });

    const before = JSON.stringify(engine.getRecord());
    setTimeout(() => engine.cancel(), 250);
    const events = await drain(engine.run("start something long", allowAll));

    assert.ok(kinds(events).includes("cancelled"), "cancellation is reported, not swallowed");
    const after = JSON.parse(JSON.stringify(engine.getRecord())) as { content: string | null }[];
    // The user turn is present; no half-written assistant turn follows it.
    assert.ok(before.length <= JSON.stringify(after).length);
    assert.ok(
      !after.some((m) => m.content === "partial"),
      "a cancelled stream must not commit a partial assistant turn",
    );
  });
});
