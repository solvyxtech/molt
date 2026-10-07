import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Transcript, wireArgs } from "../src/transcript.js";

describe("tool-call arguments on the wire", () => {
  it("keeps valid JSON as written", () => {
    assert.equal(wireArgs('{"path":"a.txt"}'), '{"path":"a.txt"}');
  });

  it("repairs what the lenient reader can read, and sends {} for the rest", () => {
    // StreamLake refused every later request once a broken call was in the history.
    assert.deepEqual(JSON.parse(wireArgs('{"content":"a\nb","re":"\\d"}')), { content: "a\nb", re: "\\d" });
    assert.equal(wireArgs("not json at all"), "{}");
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
  });
});
