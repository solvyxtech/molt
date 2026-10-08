import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Engine, MALFORMED_STOP } from "../src/engine.js";
import { Transcript, excerpt, MALFORMED_EXCERPT_CHARS, wireArgs } from "../src/transcript.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Receipts } from "../src/receipts.js";
import { parseBar } from "../src/bar.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

/**
 * 2026-10-07: a worker sent 17 malformed `act` calls in a row, each carrying a
 * large argument payload. Every one went back to the provider in full on
 * every later step; prompts reached 630k tokens and one task cost $0.82 for a
 * 181-byte file. Refused calls now go back as an excerpt, and the turn ends
 * after MALFORMED_STOP of them in a row.
 */
const BIG = "x".repeat(50_000);

describe("malformed tool calls stay cheap", () => {
  it("excerpt keeps the start and says how much was left out", () => {
    assert.equal(excerpt("short"), "short");
    const e = excerpt(BIG);
    assert.ok(e.length < MALFORMED_EXCERPT_CHARS + 60);
    assert.match(e, /49700 more characters not resent/);
  });

  it("unreadable arguments go back as a capped _unparsed", () => {
    const w = JSON.parse(wireArgs(`{"broken": ${BIG}`)) as { _unparsed: string };
    assert.ok(w._unparsed.length < MALFORMED_EXCERPT_CHARS + 60);
  });

  it("a refused call's arguments are excerpted on the wire, kept whole in the record", () => {
    const t = new Transcript("sys");
    t.push({ role: "user", content: "go" });
    t.push({ role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "act", arguments: JSON.stringify({ actions: BIG }) } }] });
    t.push({ role: "tool", tool_call_id: "c1", content: "refused" });
    t.markMalformedCall("c1");
    const sent = JSON.stringify(t.wire());
    assert.ok(sent.length < 2_000, `wire was ${sent.length} chars`);
    assert.ok(JSON.stringify(t.wire({ repairArgs: false })).length > 50_000, "the record keeps the full text");
  });

  it("ten 50 KB malformed calls never make a request carry them in full, and the turn ends at the limit", async () => {
    const ws = workspace();
    try {
      const turns = [
        ...Array.from({ length: 10 }, () => ({ calls: [{ name: "act", args: { actions: BIG } }] })),
        { text: "Done." },
      ];
      const provider = scriptedProvider(turns);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const ev = await drain(engine.run("write out.txt", allowAll));
      const sizes = provider.bodies.map((b) => b.length);
      assert.ok(Math.max(...sizes) < 40_000, `largest request ${Math.max(...sizes)} chars`);
      assert.ok(provider.calls <= MALFORMED_STOP + 2, `provider asked ${provider.calls} times`);
      assert.ok(ev.some((e) => e.kind === "info" && /malformed tool calls in a row/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });

  it("a good call in between resets the count", async () => {
    const ws = workspace();
    try {
      const bad = { calls: [{ name: "act", args: { actions: "not a list" } }] };
      const good = { calls: [{ name: "list_dir", args: { path: "." } }] };
      const provider = scriptedProvider([bad, bad, bad, bad, bad, good, bad, bad, bad, bad, bad, { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const ev = await drain(engine.run("look around", allowAll));
      assert.ok(!ev.some((e) => e.kind === "info" && /malformed tool calls in a row/.test(e.text)));
    } finally {
      ws.cleanup();
    }
  });

  it("tells the model firmly at three in a row", async () => {
    const ws = workspace();
    try {
      const bad = { calls: [{ name: "act", args: { actions: "not a list" } }] };
      const provider = scriptedProvider([bad, bad, bad, { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      await drain(engine.run("go", allowAll));
      assert.ok(provider.bodies.some((b) => b.includes("3 malformed calls in a row")));
    } finally {
      ws.cleanup();
    }
  });

  it("calls to a tool that does not exist count toward the streak", async () => {
    const ws = workspace();
    try {
      const ghost = { calls: [{ name: "no_such_tool", args: { payload: BIG } }] };
      const provider = scriptedProvider([...Array.from({ length: 8 }, () => ghost), { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: null, stream: false, autonomy: "high" });
      const ev = await drain(engine.run("go", allowAll));
      assert.ok(ev.some((e) => e.kind === "info" && /malformed tool calls in a row/.test(e.text)));
      assert.ok(Math.max(...provider.bodies.map((b) => b.length)) < 40_000);
    } finally {
      ws.cleanup();
    }
  });

  it("with work on disk, the turn ends as the model's doing and the receipt says so", async () => {
    const ws = workspace();
    try {
      const write = { calls: [{ name: "write_file", args: { path: "out.txt", content: "y" } }] };
      const bad = { calls: [{ name: "act", args: { actions: "not a list" } }] };
      const provider = scriptedProvider([write, bad, bad, bad, bad, bad, bad, bad, { text: "Done." }]);
      const engine = new Engine({ baseUrl: "http://p.test/v1", model: "m", cwd: ws.dir, fetchFn: provider.fetchFn, bar: parseBar("version: 1\nchecks:\n  - name: has-out\n    run: test -f out.txt\n")!, receipts: new Receipts(ws.dir), stream: false, autonomy: "high" });
      const ev = await drain(engine.run("write out.txt", allowAll));
      const end = ev.find((e) => e.kind === "job_end") as { endedBy?: string } | undefined;
      assert.equal(end?.endedBy, "malformed");
      const dir = join(ws.dir, ".maat", "receipts");
      const text = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
      assert.match(text, /malformed tool calls several times in a row/);
      assert.doesNotMatch(text, /The provider failed/);
    } finally {
      ws.cleanup();
    }
  });

  it("the excerpt mark lives on the message", () => {
    const t = new Transcript("sys");
    t.push({ role: "assistant", content: null, tool_calls: [{ id: "c9", type: "function", function: { name: "act", arguments: BIG } }] });
    t.markMalformedCall("c9");
    const rec = t.record().find((m) => m.role === "assistant")!;
    assert.deepEqual(rec.molt?.refusedCalls, ["c9"]);
  });
});
