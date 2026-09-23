/**
 * A tool call written as text is not a tool call.
 *
 * After a shed, the transcript a model is imitating is a digest that describes
 * calls in prose. A model that answers in kind writes the call into its reply
 * — in whatever wire format it was trained on — sometimes adds a result it
 * made up, and says it is done. The provider returned no tool call, nothing
 * ran, and molt read the message as a completion claim.
 *
 * The payloads below are the shapes real model families emit: OpenAI-style
 * JSON, Anthropic-style `<function_calls>`, Hermes/Qwen `<tool_call>`,
 * Qwen3-coder `<function=…>`, Mistral `[TOOL_CALLS]`, DeepSeek special tokens,
 * and plain "I'll now call write_file(…)". The negatives are the answers that
 * must not trip it: a model reporting what it did, quoting code, and
 * explaining a wire format.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { Engine, NARRATED_CALL_RETRIES } from "../src/engine.js";
import { Journal } from "../src/journal.js";
import { narratedCallIn } from "../src/narrated.js";
import { Receipts } from "../src/receipts.js";
import type { EngineEvent, Msg } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

const POSITIVE: [string, string][] = [
  [
    "OpenAI-style JSON in a trailing fence",
    "I'll create the file now.\n\n```json\n" +
      '{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello\\n"}}\n```',
  ],
  [
    "OpenAI wire shape pasted bare, then a claim",
    '{"tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "edit_file", ' +
      '"arguments": "{\\"path\\": \\"src/a.ts\\", \\"old_text\\": \\"x\\", \\"new_text\\": \\"y\\"}"}}]}\n\n' +
      "The edit is applied and the tests pass.",
  ],
  [
    "Anthropic-style <function_calls>/<invoke>",
    "Now I'll write the file.\n\n<function_calls>\n<invoke name=\"write_file\">\n" +
      '<parameter name="path">a.txt</parameter>\n<parameter name="content">hello</parameter>\n' +
      "</invoke>\n</function_calls>",
  ],
  [
    "Hermes/Qwen <tool_call>",
    '<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}\n</tool_call>',
  ],
  [
    "Qwen3-coder <function=…>",
    "<function=write_file>\n<parameter=path>\na.txt\n</parameter>\n<parameter=content>\nhello\n" +
      "</parameter>\n</function>\n</tool_call>",
  ],
  ["Mistral [TOOL_CALLS]", '[TOOL_CALLS] [{"name": "bash", "arguments": {"command": "npm test"}}]'],
  [
    "DeepSeek special tokens",
    "<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>bash\n```json\n" +
      '{"command": "npm test"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>',
  ],
  ["plain call syntax", 'I\'ll now call write_file(path="a.txt", content="hello") to create it.'],
  ["\"Calling … with\"", "Calling `edit_file` with the corrected import.\n\nDone — the import is fixed."],
  ["announced and not made", "The import is wrong. Let me use edit_file to fix it."],
  [
    "harness transcript imitation with a fabricated result",
    '[Assistant tool call] write_file {"path": "a.txt", "content": "hello"}\n' +
      "[Tool result] Wrote 5 bytes to a.txt\n\nDone. a.txt now contains hello.",
  ],
  [
    "fenced JSON followed by a made-up result and a claim",
    "Here is the change:\n\n```json\n" +
      '{"name": "edit_file", "arguments": {"path": "src/a.ts", "old_text": "1", "new_text": "2"}}\n' +
      "```\n\n[Tool result: success]\n\nAll done; the constant is now 2.",
  ],
  [
    "flat JSON with the tool's own parameters",
    'Writing it now:\n\n```json\n{"tool": "write_file", "path": "a.txt", "content": "hello"}\n```',
  ],
  [
    "ReAct Action / Action Input / Observation",
    "Thought: I need to create the file.\nAction: write_file\nAction Input: " +
      '{"path": "a.txt", "content": "hello"}\nObservation: wrote a.txt\nFinal Answer: done',
  ],
  [
    "a tool_call fence",
    "```tool_call\nwrite_file(path='a.txt', content='hello')\n```\nThe file has been written.",
  ],
];

const NEGATIVE: [string, string][] = [
  [
    "a report of calls that really ran",
    "I used grep to find every caller, then edited src/a.ts with edit_file and ran the " +
      "suite with bash. All 12 tests pass.",
  ],
  [
    "an ask-mode answer quoting molt's own test code",
    "The scripted provider replays turns like this:\n\n```ts\n" +
      '{ calls: [{ name: "write_file", args: { path: "a.txt", content: "real work\\n" } }] }\n' +
      "```\n\nThe last turn repeats forever, which is how the tests model a model that will not stop.",
  ],
  [
    "an answer explaining the wire format with an example",
    "The request body looks like this:\n\n```json\n" +
      '{"name": "write_file", "arguments": {"path": "a.txt", "content": "hi"}}\n```\n\n' +
      "molt parses `arguments` as JSON before the gate sees it, so malformed JSON is refused " +
      "before anything is written.",
  ],
  [
    "the format named in inline code",
    "Hermes-style models emit `<tool_call>` tags and Anthropic's legacy format used " +
      "`<function_calls>`; molt reads neither, only the provider's `tool_calls` field.",
  ],
  ["the format named in bare prose", "Hermes models emit <tool_call> tags around a JSON body."],
  [
    "a fenced example of the format with somebody else's tool",
    "Anthropic's old prompt format looked like:\n\n```xml\n<function_calls>\n" +
      '<invoke name="get_weather">\n<parameter name="city">Paris</parameter>\n</invoke>\n' +
      "</function_calls>\n```",
  ],
  [
    "shell and python code blocks",
    "To reproduce:\n\n```bash\ngrep -rn fetchFn src\nnpm test\n```\n\nor from Python:\n\n" +
      "```python\nsubprocess.run(['grep', '-rn', 'fetchFn', 'src'])\n```",
  ],
  ["the tools named in prose", "The `bash` tool runs a command with a 60 s timeout; `grep` is faster for search."],
  [
    "an answer describing a config object that happens to have a path",
    "The loader reads a manifest like this:\n\n```json\n" +
      '{"name": "molt", "path": "dist/cli.js"}\n```\n\nand resolves `path` against the package root.',
  ],
  ["a report that names the ReAct format", "Older agents used an Action: / Action Input: loop; molt does not."],
  ["an ordinary claim", "Done. src/a.ts now exports `parse`, and the new test covers the empty case."],
  ["empty", ""],
];

describe("narratedCallIn", () => {
  for (const [name, text] of POSITIVE) {
    it(`finds ${name}`, () => {
      assert.ok(narratedCallIn(text), `expected a narrated call in:\n${text}`);
    });
  }
  for (const [name, text] of NEGATIVE) {
    it(`leaves alone ${name}`, () => {
      assert.equal(narratedCallIn(text), null, `false positive on:\n${text}`);
    });
  }
  it("says what it found, in words a model can act on", () => {
    assert.match(narratedCallIn(POSITIVE[3]![1])!, /<tool_call>/);
    assert.match(narratedCallIn(POSITIVE[7]![1])!, /write_file/);
  });
});

// ---- The engine ----

const BAR = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
`);

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws(): string {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function engineIn(dir: string, turns: Parameters<typeof scriptedProvider>[0]) {
  const provider = scriptedProvider(turns);
  const journal = new Journal(dir, "narrated");
  const engine = new Engine({
    baseUrl: "http://mock/v1",
    model: "test-model",
    provider: "mock",
    cwd: dir,
    fetchFn: provider.fetchFn,
    bar: BAR,
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    journal,
    maxProofAttempts: 2,
  });
  return { engine, provider, journal };
}

function sentText(provider: { requests: () => unknown[] }): string {
  return provider
    .requests()
    .flatMap((r) => (r as { messages: Msg[] }).messages)
    .map((m) => m.content ?? "")
    .join("\n");
}

function outcomes(events: EngineEvent[]): string[] {
  return events
    .filter((e): e is Extract<EngineEvent, { kind: "step_summary" }> => e.kind === "step_summary")
    .map((e) => e.outcome);
}

function journalKinds(journal: Journal): { kind: string; data: Record<string, unknown> }[] {
  return readFileSync(journal.path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { kind: string; data: Record<string, unknown> });
}

const HERMES =
  '<tool_call>\n{"name": "write_file", "arguments": {"path": "a.txt", "content": "hello"}}\n' +
  "</tool_call>\n\nDone — a.txt is created.";

describe("a narrated tool call is not a claim", () => {
  it("tells the model nothing ran and waits for a real call, instead of running the bar", async () => {
    const dir = ws();
    const { engine, provider, journal } = engineIn(dir, [
      { text: HERMES },
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "hello" } }] },
      { text: "done" },
    ]);
    const events = await drain(engine.run("create a.txt", allowAll));

    assert.deepEqual(outcomes(events), ["narrated", "tools", "claim"]);
    assert.equal(
      events.filter((e) => e.kind === "proof_start").length,
      1,
      "the narrated reply must not have been sent to the bar",
    );
    assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "hello");

    // Told in the conversation, not only on screen.
    const said = sentText(provider);
    assert.match(said, /shaped like a tool call/);
    assert.match(said, /nothing ran/);
    assert.match(said, /real call/);

    const entry = journalKinds(journal).find((e) => e.kind === "narrated_call");
    assert.ok(entry, "narrated_call must be journalled");
    assert.equal(entry.data.attempt, 1);
    assert.match(String(entry.data.found), /tool_call/);
  });

  it("gives up after NARRATED_CALL_RETRIES and lets the bar decide — which refuses", async () => {
    const dir = ws();
    // A model that will never make a real call.
    const { engine, provider, journal } = engineIn(dir, [{ text: HERMES }]);
    const events = await drain(engine.run("create a.txt", allowAll));

    assert.equal(outcomes(events).filter((o) => o === "narrated").length, NARRATED_CALL_RETRIES);
    assert.ok(events.some((e) => e.kind === "proof_start"), "the last reply goes to the bar");
    assert.ok(!events.some((e) => e.kind === "proof_result" && e.result.ok), "and is not accepted");
    assert.ok(!existsSync(join(dir, "a.txt")), "nothing ran, so nothing was written");
    assert.ok(provider.calls <= 8, `runaway: ${provider.calls} requests`);

    const entries = journalKinds(journal).filter((e) => e.kind === "narrated_call");
    // Nudged exactly NARRATED_CALL_RETRIES times; every reply after that is
    // still journalled, and marked as passed to the bar rather than dropped.
    assert.equal(entries.filter((e) => !e.data.passedToBar).length, NARRATED_CALL_RETRIES);
    assert.equal(entries[NARRATED_CALL_RETRIES]!.data.passedToBar, true, "the give-up is recorded, not silent");
    assert.ok(
      events.some((e) => e.kind === "info" && /did not run/.test(e.text)),
      "and said on screen",
    );
  });

  it("an ask-mode answer with a code example is answered, not nudged", async () => {
    const dir = ws();
    const { engine, provider } = engineIn(dir, [{ text: NEGATIVE[2]![1] }]);
    const events = await drain(engine.run("what does a tool call look like on the wire?", allowAll, { ask: true }));
    assert.deepEqual(outcomes(events), ["claim"]);
    assert.equal(provider.calls, 1);
    assert.doesNotMatch(sentText(provider), /shaped like a tool call/);
  });

  it("each family's shape is caught end to end", async () => {
    for (const [name, text] of POSITIVE) {
      const dir = ws();
      const { engine } = engineIn(dir, [
        { text },
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "x" } }] },
        { text: "done" },
      ]);
      const events = await drain(engine.run("do it", allowAll));
      assert.equal(outcomes(events)[0], "narrated", name);
    }
  });

});
