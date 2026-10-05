/**
 * The JSON-RPC framing both ACP directions share.
 *
 * Framing bugs do not look like framing bugs from outside: a message split
 * across two reads that is dropped reads as an agent that never answered, and
 * a stray line on stdout reads as an editor that hung. These pin the parts a
 * pipe actually exercises — partial lines, several messages in one read,
 * garbage, and correlation of replies to the calls that asked.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  PARSE_ERROR,
  RpcError,
  RpcPeer,
} from "../src/jsonrpc.js";

/** A peer whose output is captured as parsed messages. */
function peer(opts: Partial<ConstructorParameters<typeof RpcPeer>[0]> = {}) {
  const lines: string[] = [];
  const p = new RpcPeer({ write: (l) => lines.push(l), ...opts });
  return { p, lines, sent: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>) };
}

const tick = () => new Promise((r) => setImmediate(r));

describe("RpcPeer framing", () => {
  it("writes one newline-terminated JSON object per message", () => {
    const { p, lines } = peer();
    p.notify("session/update", { a: 1 });
    void p.request("initialize", { protocolVersion: 1 }).catch(() => {});
    assert.equal(lines.length, 2);
    for (const l of lines) {
      assert.ok(l.endsWith("\n"));
      assert.equal(l.indexOf("\n"), l.length - 1, "a frame never contains a raw newline");
    }
    assert.deepEqual(JSON.parse(lines[0]!), { jsonrpc: "2.0", method: "session/update", params: { a: 1 } });
    assert.deepEqual(JSON.parse(lines[1]!), {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: 1 },
    });
  });

  it("keeps a message split across reads until its newline arrives", async () => {
    const seen: string[] = [];
    const { p } = peer({ onNotify: (m) => seen.push(m) });
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: {} }) + "\n";
    p.feed(frame.slice(0, 10));
    assert.deepEqual(seen, []);
    p.feed(frame.slice(10, 20));
    assert.deepEqual(seen, []);
    p.feed(frame.slice(20));
    assert.deepEqual(seen, ["session/cancel"]);
  });

  it("handles several messages in one read, in order", () => {
    const seen: string[] = [];
    const { p } = peer({ onNotify: (m) => seen.push(m) });
    p.feed(
      ["a", "b", "c"].map((m) => JSON.stringify({ jsonrpc: "2.0", method: m }) + "\n").join("") + "\n\n",
    );
    assert.deepEqual(seen, ["a", "b", "c"]);
  });

  it("tolerates CRLF line endings", () => {
    const seen: string[] = [];
    const { p } = peer({ onNotify: (m) => seen.push(m) });
    p.feed(JSON.stringify({ jsonrpc: "2.0", method: "x" }) + "\r\n");
    assert.deepEqual(seen, ["x"]);
  });

  it("answers a non-JSON line with PARSE_ERROR when it is the server", () => {
    const { p, sent } = peer({ onGarbage: "reply" });
    p.feed("this is not json\n");
    assert.deepEqual(sent(), [{ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } }]);
  });

  it("ignores a non-JSON line when told to — a child's banner is not a protocol error", () => {
    const { p, lines } = peer({ onGarbage: "ignore" });
    p.feed("Update available: 1.0.41\n");
    assert.deepEqual(lines, []);
  });

  it("refuses a batch as an invalid request rather than half-handling it", () => {
    const { p, sent } = peer({ onGarbage: "reply" });
    p.feed("[1,2]\n");
    assert.equal((sent()[0]!.error as { code: number }).code, INVALID_REQUEST);
  });
});

describe("RpcPeer requests", () => {
  it("resolves a request with the result that carries its id", async () => {
    const { p } = peer();
    const a = p.request("one", {});
    const b = p.request("two", {});
    // Out of order on purpose: correlation is by id, not by arrival.
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, result: "second" }) + "\n");
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "first" }) + "\n");
    assert.equal(await a, "first");
    assert.equal(await b, "second");
  });

  it("rejects with an RpcError carrying the peer's code and data", async () => {
    const { p } = peer();
    const r = p.request("x", {});
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "auth", data: { k: 1 } } }) + "\n");
    await assert.rejects(r, (e: unknown) => {
      assert.ok(e instanceof RpcError);
      assert.equal(e.code, -32000);
      assert.equal(e.message, "auth");
      assert.deepEqual(e.data, { k: 1 });
      return true;
    });
  });

  it("fails every pending request together when the connection dies", async () => {
    const { p } = peer();
    const a = p.request("a", {});
    const b = p.request("b", {});
    p.fail(new Error("pipe closed"));
    await assert.rejects(a, /pipe closed/);
    await assert.rejects(b, /pipe closed/);
    assert.equal(p.closed, true);
    await assert.rejects(p.request("c", {}), /pipe closed/);
  });

  it("writes nothing once closed", () => {
    const { p, lines } = peer();
    p.fail(new Error("gone"));
    p.notify("x", {});
    assert.deepEqual(lines, []);
  });
});

describe("RpcPeer answering", () => {
  it("answers a request with the handler's result, and null for undefined", async () => {
    const { p, sent } = peer({
      onRequest: async (m) => (m === "nothing" ? undefined : { echoed: m }),
    });
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "hello", params: {} }) + "\n");
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: "s", method: "nothing" }) + "\n");
    await tick();
    assert.deepEqual(sent(), [
      { jsonrpc: "2.0", id: 7, result: { echoed: "hello" } },
      { jsonrpc: "2.0", id: "s", result: null },
    ]);
  });

  it("answers METHOD_NOT_FOUND when there is no handler", async () => {
    const { p, sent } = peer();
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "nope" }) + "\n");
    await tick();
    assert.equal((sent()[0]!.error as { code: number }).code, METHOD_NOT_FOUND);
  });

  it("uses an RpcError's own code, and the default code for anything else", async () => {
    const { p, sent } = peer({
      onRequest: async (m) => {
        if (m === "bad") throw new RpcError(INVALID_PARAMS, "cwd must be absolute");
        throw new Error("boom");
      },
    });
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "bad" }) + "\n");
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "worse" }) + "\n");
    await tick();
    const [a, b] = sent();
    assert.deepEqual(a!.error, { code: INVALID_PARAMS, message: "cwd must be absolute" });
    assert.deepEqual(b!.error, { code: INTERNAL_ERROR, message: "boom" });
  });

  it("can keep an older peer's error code and wording", async () => {
    const { p, sent } = peer({
      onRequest: async () => {
        throw new Error("boom");
      },
      defaultErrorCode: -32000,
      describeError: (e) => String(e),
    });
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "x" }) + "\n");
    await tick();
    assert.deepEqual(sent()[0]!.error, { code: -32000, message: "Error: boom" });
  });

  it("delivers a notification without answering it", async () => {
    const got: unknown[] = [];
    const { p, lines } = peer({ onNotify: (m, params) => got.push([m, params]) });
    p.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "s" } }) + "\n");
    await tick();
    assert.deepEqual(got, [["session/cancel", { sessionId: "s" }]]);
    assert.deepEqual(lines, []);
  });

  it("keeps serving while a slow handler is still working", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const notes: string[] = [];
    const { p, sent } = peer({
      onRequest: async () => {
        await gate;
        return "late";
      },
      onNotify: (m) => notes.push(m),
    });
    p.feed(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session/prompt" }) + "\n");
    p.feed(JSON.stringify({ jsonrpc: "2.0", method: "session/cancel" }) + "\n");
    await tick();
    assert.deepEqual(notes, ["session/cancel"], "a cancel is heard while the prompt is still open");
    release();
    await tick();
    assert.deepEqual(sent(), [{ jsonrpc: "2.0", id: 1, result: "late" }]);
  });
});
