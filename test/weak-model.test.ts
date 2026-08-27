/**
 * What molt does when the model, not the task, is the problem.
 *
 * Session 0581ccd8 (2026-08-27, receipts 0039 and 0040) ran a 20B local model
 * against this repository for 55 minutes and 1,068,428 prompt tokens, and left
 * behind a tree that did not compile. Three separate things went wrong, and
 * molt had something to say about none of them:
 *
 *  1. Step 11 came back with no text and no tool call. molt read the absence
 *     of tool calls as "the model says it is done" and spent a 26-second bar
 *     proving that nothing had happened. The receipt's claim reads
 *     "(no final message)".
 *  2. Step 15 sent `new_text` as unified-diff body. molt wrote the `+`
 *     characters into the TypeScript, `tsc` said `TS1109`, and it stayed said.
 *  3. Steps 17-63 re-read the same twenty lines. molt noticed — 22
 *     `repeat_step` entries — and told the user, on screen, in a channel the
 *     model cannot read. The one party able to break the loop was never told
 *     it was in one.
 *
 * These pin the three answers. None of them ends a turn: the model is given
 * the fact and left to act on it.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { Engine, EMPTY_TURN_RETRIES } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { EngineEvent, Msg } from "../src/types.js";
import { allowAll, drain, scriptedProvider, workspace } from "./helpers.js";

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
  const engine = new Engine({
    baseUrl: "http://mock/v1",
    model: "test-model",
    provider: "mock",
    cwd: dir,
    fetchFn: provider.fetchFn,
    bar: BAR,
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    maxProofAttempts: 2,
  });
  return { engine, provider };
}

/** Every message molt has sent, across every request in the run. */
function sentText(provider: { requests: () => unknown[] }): string {
  return provider
    .requests()
    .flatMap((r) => (r as { messages: Msg[] }).messages)
    .map((m) => m.content ?? "")
    .join("\n");
}

/** The preview of the first tool result in a run. */
function toolPreview(events: EngineEvent[]): string {
  const tool = events.find((e): e is Extract<EngineEvent, { kind: "tool" }> => e.kind === "tool");
  assert.ok(tool, "expected a tool event");
  return tool.preview ?? "";
}

function outcomes(events: EngineEvent[]): string[] {
  return events
    .filter((e): e is Extract<EngineEvent, { kind: "step_summary" }> => e.kind === "step_summary")
    .map((e) => e.outcome);
}

describe("an empty turn is not a claim", () => {
  it("asks again instead of running the bar on an unchanged tree", async () => {
    const dir = ws();
    const { engine, provider } = engineIn(dir, [
      { text: "" },
      { calls: [{ name: "write_file", args: { path: "a.txt", content: "real work\n" } }] },
      { text: "done" },
    ]);
    const events = await drain(engine.run("do the thing", allowAll));

    // The bar ran once, after the write — not against the empty turn.
    const proofs = events.filter((e) => e.kind === "proof_start");
    assert.equal(proofs.length, 1, "the empty turn must not have triggered a bar run");
    assert.ok(
      events.some((e) => e.kind === "proof_result"),
      "the turn should still finish, and pass, once real work lands",
    );

    // The step is accounted for, and accounted for as what it was.
    assert.deepEqual(outcomes(events), ["empty", "tools", "claim"]);

    // And the model was told, in the conversation, what had happened.
    assert.match(sentText(provider), /that turn arrived empty/);
  });

  it("gives up asking rather than looping forever", async () => {
    const dir = ws();
    // Every turn is empty. The last scripted turn repeats forever, so this is
    // a model that will never say anything at all.
    const { engine, provider } = engineIn(dir, [{ text: "" }]);
    const events = await drain(engine.run("do the thing", allowAll));

    const empties = outcomes(events).filter((o) => o === "empty").length;
    assert.equal(empties, EMPTY_TURN_RETRIES, "asks exactly EMPTY_TURN_RETRIES times");
    assert.ok(
      events.some((e) => e.kind === "proof_start" || e.kind === "proof_refused"),
      "after the retries, an empty turn is taken as the claim it never was",
    );
    // Terminates. Before this guard the same script also terminated; the point
    // is that it still does, having spent two extra requests and no bars.
    assert.ok(provider.calls <= 6, `runaway: ${provider.calls} requests`);
  });
});

describe("a diff sent where file content belongs", () => {
  it("refuses the exact edit that broke session 0581ccd8", async () => {
    const dir = ws();
    const original = 'import { runCommand } from "./run.js";\nexport const x = 1;\n';
    writeFileSync(join(dir, "engine.ts"), original);

    const { engine } = engineIn(dir, [
      {
        calls: [
          {
            name: "edit_file",
            args: {
              path: "engine.ts",
              old_text: 'import { runCommand } from "./run.js";',
              // Verbatim shape of receipt 0040's edit: diff body, markers at
              // column 0, sent as though it were file content.
              new_text:
                "+// TODO: Implement multi-agent support. This will allow running several\n" +
                "+// concurrent agent instances to speed up work. The current engine only\n" +
                "+// handles one agent loop at a time.\n" +
                'import { runCommand } from "./run.ts";',
            },
          },
        ],
      },
      { text: "done" },
    ]);
    const events = await drain(engine.run("add multi-agent support", allowAll));

    assert.equal(
      readFileSync(join(dir, "engine.ts"), "utf8"),
      original,
      "the file must be untouched — a refused edit is not a partial edit",
    );
    const preview = toolPreview(events);
    assert.match(preview, /looks like a unified diff/);
    assert.match(preview, /no leading `\+`/, "the refusal has to say what to send instead");
  });

  it("refuses a whole file written as a patch", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      {
        calls: [
          {
            name: "write_file",
            args: {
              path: "out.ts",
              content: "@@ -1,3 +1,4 @@\n const a = 1;\n+const b = 2;\n const c = 3;\n",
            },
          },
        ],
      },
      { text: "done" },
    ]);
    const events = await drain(engine.run("write the file", allowAll));
    assert.match(toolPreview(events), /write refused/);
  });

  it("still writes a real patch file", async () => {
    const dir = ws();
    const patch = "--- a/x.ts\n+++ b/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "fix.patch", content: patch } }] },
      { text: "done" },
    ]);
    await drain(engine.run("save the patch", allowAll));
    assert.equal(readFileSync(join(dir, "fix.patch"), "utf8"), patch);
  });
});

describe("a step that only repeated itself", () => {
  it("tells the model, not only the screen", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const read = { calls: [{ name: "read_file", args: { path: "a.ts" } }] };

    // One fresh read, then three that return what molt has already shown.
    const { engine, provider } = engineIn(dir, [read, read, read, read, { text: "done" }]);
    const events = await drain(engine.run("look at a.ts", allowAll));

    const sent = sentText(provider);
    assert.match(sent, /steps in a row have now returned things you had already been given/);
    assert.match(sent, /say plainly what is blocking you/);

    // The screen still gets its version — this adds a channel, it does not
    // move one.
    assert.ok(
      events.some((e) => e.kind === "info" && /steps in a row/.test(e.text)),
      "the user is still told",
    );
    // And the turn is not taken away: repetition remains non-fatal.
    assert.ok(
      events.some((e) => e.kind === "proof_start"),
      "the model still got to finish and be judged",
    );
  });

  it("says nothing while the model is making progress", async () => {
    const dir = ws();
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export const b = 2;\n");
    writeFileSync(join(dir, "c.ts"), "export const c = 3;\n");
    const { engine, provider } = engineIn(dir, [
      { calls: [{ name: "read_file", args: { path: "a.ts" } }] },
      { calls: [{ name: "read_file", args: { path: "b.ts" } }] },
      { calls: [{ name: "read_file", args: { path: "c.ts" } }] },
      { calls: [{ name: "write_file", args: { path: "d.ts", content: "export const d = 4;\n" } }] },
      { text: "done" },
    ]);
    await drain(engine.run("read three files", allowAll));
    assert.doesNotMatch(sentText(provider), /steps in a row have now returned/);
  });
});
