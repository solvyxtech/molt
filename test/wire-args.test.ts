import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript, wireArgs } from "../src/transcript.js";
import { Engine } from "../src/engine.js";
import { parseBar } from "../src/bar.js";
import { Receipts } from "../src/receipts.js";
import { allowAll, drain } from "./helpers.js";

describe("tool-call arguments on the wire", () => {
  it("keeps valid JSON as written", () => {
    assert.equal(wireArgs('{"path":"a.txt"}'), '{"path":"a.txt"}');
  });

  it("repairs what the lenient reader can read, and wraps the rest so the mistake stays visible", () => {
    // StreamLake refused every later request once a broken call was in the history.
    assert.deepEqual(JSON.parse(wireArgs('{"content":"a\nb","re":"\\d"}')), { content: "a\nb", re: "\\d" });
    assert.deepEqual(JSON.parse(wireArgs("not json at all")), { _unparsed: "not json at all" });
  });

  it("sends an object whatever valid JSON the model wrote", () => {
    // The engine refuses anything but an object, and chat templates that
    // iterate `arguments | items` fail on the rest.
    assert.equal(wireArgs("null"), "{}");
    assert.equal(wireArgs(""), "{}");
    assert.equal(wireArgs("  "), "{}");
    for (const raw of ["[]", "[1,2]", "42", '"x"', "true"]) {
      assert.deepEqual(JSON.parse(wireArgs(raw)), { _unparsed: raw }, raw);
    }
  });

  it("repairs only the copy sent to the provider", () => {
    const t = new Transcript("sys");
    t.push({ role: "user", content: "go" });
    t.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt","re":"\\d+"}' } }],
    });
    const wire = t.wire();
    const call = wire.find((m) => m.tool_calls)!.tool_calls![0]!;
    assert.doesNotThrow(() => JSON.parse(call.function.arguments));
    const kept = t.all().find((m) => m.tool_calls)!.tool_calls![0]!;
    assert.equal(kept.function.arguments, '{"path":"a.txt","re":"\\d+"}');
    const raw = t.wire({ repairArgs: false }).find((m) => m.tool_calls)!.tool_calls![0]!;
    assert.equal(raw.function.arguments, '{"path":"a.txt","re":"\\d+"}');
  });

  it("a capture keeps the arguments the model wrote; the next request carries the repair", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maat-wire-"));
    try {
      const cap = join(dir, "captures");
      // A raw newline inside a string: not JSON, but the lenient reader runs it.
      const broken = '{"path": "r.txt", "content": "real\nline\n"}';
      const bodies: string[] = [];
      let n = 0;
      const fetchFn = (async (_u: string, init?: RequestInit) => {
        bodies.push(String(init?.body ?? ""));
        n += 1;
        const message =
          n === 1
            ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: broken } }] }
            : { role: "assistant", content: "Wrote r.txt." };
        return {
          ok: true,
          status: 200,
          json: async () => ({ choices: [{ message }], usage: { prompt_tokens: 100, completion_tokens: 20 } }),
          text: async () => "",
        } as unknown as Response;
      }) as unknown as typeof fetch;
      const engine = new Engine({
        baseUrl: "http://mock/v1", model: "m", cwd: dir, fetchFn, stream: false,
        bar: parseBar("version: 1\nchecks:\n  - name: landed\n    builtin: files-changed\n"),
        receipts: new Receipts(dir), captureDir: cap,
      });
      await drain(engine.run("add r.txt", allowAll));
      assert.equal(readFileSync(join(dir, "r.txt"), "utf8"), "real\nline\n");
      // The request after the call sent valid JSON.
      const sent = JSON.parse(bodies[1]!) as { messages: { tool_calls?: { function: { arguments: string } }[] }[] };
      const sentArgs = sent.messages.find((m) => m.tool_calls)!.tool_calls![0]!.function.arguments;
      assert.deepEqual(JSON.parse(sentArgs), { path: "r.txt", content: "real\nline\n" });
      // The capture kept the broken text.
      const files = readdirSync(cap);
      assert.equal(files.length, 1);
      const c = JSON.parse(readFileSync(join(cap, files[0]!), "utf8")) as { transcript: { tool_calls?: { function: { arguments: string } }[] }[] };
      assert.equal(c.transcript.find((m) => m.tool_calls)!.tool_calls![0]!.function.arguments, broken);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
