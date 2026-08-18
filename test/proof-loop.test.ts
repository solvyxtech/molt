/**
 * The tests that decide whether molt is worth building.
 *
 * If molt cannot refuse a model that lies about finishing, nothing else in
 * this repository matters.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, drain, kinds, scriptedProvider, workspace } from "./helpers.js";

const BAR = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
`);

const BAR_WITH_TESTS = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
  - name: suite
    run: sh ./check.sh
    timeout: 10
`);

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

function engineIn(
  dir: string,
  turns: Parameters<typeof scriptedProvider>[0],
  opts: { bar?: ReturnType<typeof parseBar> | null; maxProofAttempts?: number } = {},
) {
  const provider = scriptedProvider(turns);
  const engine = new Engine({
    baseUrl: "http://mock/v1",
    model: "test-model",
    provider: "mock",
    cwd: dir,
    fetchFn: provider.fetchFn,
    bar: opts.bar === undefined ? BAR : opts.bar,
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    maxProofAttempts: opts.maxProofAttempts ?? 4,
  });
  return { engine, provider };
}

describe("the proof loop", () => {
  it("refuses a model that claims completion having done nothing", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { text: "Done! I fixed the bug and everything passes." },
      { calls: [{ name: "write_file", args: { path: "fix.txt", content: "the actual fix\n" } }] },
      { text: "Fixed for real this time." },
    ]);

    const events = await drain(engine.run("fix the bug", allowAll));
    const order = kinds(events);

    assert.ok(order.includes("proof_refused"), "first claim must be refused");
    assert.ok(order.includes("proof_result"), "second claim must be accepted");
    assert.ok(
      order.indexOf("proof_refused") < order.indexOf("proof_result"),
      "refusal must come before acceptance",
    );

    // The final answer is emitted only after the bar passed.
    const textIdx = order.indexOf("assistant_text");
    assert.ok(textIdx > order.indexOf("proof_result"), "no answer before the bar passes");
    assert.equal(events.filter((e) => e.kind === "assistant_text").length, 1);

    // The first claim's text never reached the user.
    const texts = events.filter((e): e is Extract<EngineEvent, { kind: "assistant_text" }> =>
      e.kind === "assistant_text",
    );
    assert.equal(texts[0].text, "Fixed for real this time.");

    assert.ok(existsSync(join(dir, "fix.txt")), "the real write landed");
  });

  it("gives up honestly instead of accepting a persistent liar", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [{ text: "All done, tests pass." }], {
      maxProofAttempts: 3,
    });

    const events = await drain(engine.run("fix the bug", allowAll));
    const order = kinds(events);

    assert.ok(order.includes("proof_exhausted"), "must report exhaustion");
    assert.ok(!order.includes("assistant_text"), "a false claim must never be emitted");

    const err = events.find((e) => e.kind === "error");
    assert.ok(err && /reporting failure rather than success/.test((err as { text: string }).text));
  });

  it("stops re-running a bar the model cannot have changed", async () => {
    // The model repeats its claim without touching anything. Re-running the
    // bar can only produce the same answer, and a bar is not cheap — this
    // one is a whole test suite in the projects molt is built for. The old
    // loop paid for it once per attempt.
    const dir = ws();
    const { engine } = engineIn(dir, [{ text: "All done, tests pass." }], {
      maxProofAttempts: 4,
    });

    const events = await drain(engine.run("fix the bug", allowAll));

    assert.equal(
      events.filter((e) => e.kind === "proof_start").length,
      1,
      "ran the bar more than once against identical state",
    );
    assert.equal(events.filter((e) => e.kind === "proof_refused").length, 1);
    assert.ok(events.some((e) => e.kind === "proof_exhausted"));
    // The refusal is still on the record: stopping early must not skip the
    // receipt, or the failure becomes unauditable.
    assert.ok(events.some((e) => e.kind === "receipt"));
    assert.ok(
      events.some((e) => e.kind === "info" && /changed nothing since the last check/.test(e.text)),
      "never said why it stopped",
    );
  });

  it("keeps looping while the model is actually doing something", async () => {
    // The stop must trigger on inaction, not on failure. A model that acts
    // between attempts still gets its full allowance.
    const dir = ws();
    const { engine } = engineIn(
      dir,
      [
        { text: "All done." },
        { calls: [{ name: "read_file", args: { path: "nope.txt" } }] },
        { text: "All done, honest." },
      ],
      { maxProofAttempts: 3 },
    );

    const events = await drain(engine.run("fix the bug", allowAll));
    assert.equal(
      events.filter((e) => e.kind === "proof_start").length,
      2,
      "stopped a loop that was still making progress",
    );
  });

  it("lets a question be answered without inventing a file to change", async () => {
    // The reported bug: ask the weather in a repo whose bar demands a write,
    // and molt refuses an honest, correct answer four times over — because
    // the only way to satisfy work-landed is to fabricate an edit, which is
    // the exact behaviour molt exists to prevent.
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), "exit 0\n");
    const { engine } = engineIn(dir, [{ text: "It is 64°F and sunny." }], {
      bar: BAR_WITH_TESTS,
    });

    const events = await drain(engine.run("what is the weather", allowAll, { ask: true }));
    const order = kinds(events);

    assert.ok(!order.includes("proof_refused"), "refused a question for changing nothing");
    assert.ok(order.includes("proof_result"), "the rest of the bar must still run");
    assert.equal(events.filter((e) => e.kind === "assistant_text").length, 1);

    // Narrowed in the open: the check that was dropped is named, and the
    // one that still applies actually ran.
    const start = events.find((e) => e.kind === "proof_start");
    assert.ok(start && start.kind === "proof_start");
    assert.deepEqual(start.names, ["suite"]);
    assert.ok(
      events.some((e) => e.kind === "info" && /require a file change are not run/.test(e.text)),
      "narrowed the bar without saying so",
    );
  });

  it("still refuses a question that fails a check it could have passed", async () => {
    // /ask drops the write check and nothing else. A failing suite still
    // refuses the claim — asking is not a way out of the bar.
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), 'echo "suite is broken"\nexit 1\n');
    const { engine } = engineIn(dir, [{ text: "It is 64°F and sunny." }], {
      bar: BAR_WITH_TESTS,
      maxProofAttempts: 2,
    });

    const events = await drain(engine.run("what is the weather", allowAll, { ask: true }));
    assert.ok(kinds(events).includes("proof_refused"));
    assert.ok(!kinds(events).includes("assistant_text"));
  });

  it("feeds the exact failing output back to the model", async () => {
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), 'echo "3 tests failed: auth token refresh"\nexit 1\n');
    const { engine, provider } = engineIn(
      dir,
      [
        { calls: [{ name: "write_file", args: { path: "a.txt", content: "x\n" } }] },
        { text: "Done." },
      ],
      { bar: BAR_WITH_TESTS, maxProofAttempts: 2 },
    );

    await drain(engine.run("do the thing", allowAll));

    const lastRequest = provider.requests().at(-1) as { messages: { content: string }[] };
    const injected = lastRequest.messages.map((m) => m.content ?? "").join("\n");
    assert.match(injected, /auth token refresh/, "real check output must reach the model");
    assert.match(injected, /do not modify \.molt\/done\.yml/i, "and the anti-cheat instruction");
  });

  it("passes straight through when every check is already satisfied", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "done.txt", content: "ok\n" } }] },
      { text: "Wrote the file." },
    ]);

    const events = await drain(engine.run("write a file", allowAll));
    assert.ok(!kinds(events).includes("proof_refused"), "no refusal when the work is real");
    assert.equal(events.filter((e) => e.kind === "assistant_text").length, 1);
  });

  it("says so loudly when there is no bar to check against", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [{ text: "Done." }], { bar: null });

    const events = await drain(engine.run("anything", allowAll));
    const info = events.find((e) => e.kind === "info") as { text: string } | undefined;
    assert.ok(info && /unverified/.test(info.text), "unverified completion must be announced");
    assert.ok(kinds(events).includes("assistant_text"));
  });

  it("catches a write that was reverted after the fact", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "gone.txt", content: "here\n" } }] },
      { calls: [{ name: "bash", args: { command: "rm gone.txt" } }] },
      { text: "All set." },
    ]);

    const events = await drain(engine.run("write then delete", allowAll));
    assert.ok(kinds(events).includes("proof_refused"), "a vanished write must fail the bar");

    const refusal = events.find((e) => e.kind === "proof_refused") as
      | { result: { results: { output: string }[] } }
      | undefined;
    const out = refusal?.result.results.map((r) => r.output).join("\n") ?? "";
    assert.match(out, /no longer on disk/);
  });

  it("catches a rewrite that changed nothing", async () => {
    const dir = ws();
    writeFileSync(join(dir, "same.txt"), "identical\n");
    const { engine } = engineIn(dir, [
      { calls: [{ name: "write_file", args: { path: "same.txt", content: "identical\n" } }] },
      { text: "Updated the file." },
    ]);

    const events = await drain(engine.run("update it", allowAll));
    assert.ok(kinds(events).includes("proof_refused"));
    const refusal = events.find((e) => e.kind === "proof_refused") as
      | { result: { results: { output: string }[] } }
      | undefined;
    assert.match(refusal?.result.results.map((r) => r.output).join("\n") ?? "", /no actual change/);
  });
});

describe("receipts", () => {
  it("records refusals as well as acceptances", async () => {
    const dir = ws();
    const { engine } = engineIn(dir, [
      { text: "Done." },
      { calls: [{ name: "write_file", args: { path: "r.txt", content: "real\n" } }] },
      { text: "Now done." },
    ]);

    await drain(engine.run("go", allowAll));

    const receipts = new Receipts(dir).list();
    assert.equal(receipts.length, 2, "one receipt per completion attempt");
    assert.ok(receipts.some((f) => f.includes("refused")));
    assert.ok(receipts.some((f) => f.includes("accepted")));

    const refused = readFileSync(join(dir, ".molt", "receipts", receipts[0]), "utf8");
    assert.match(refused, /## Claim/);
    assert.match(refused, /Done\./, "the claim itself is preserved verbatim");
    assert.match(refused, /molt refused the completion claim/);
  });

  it("keeps the failing output in the receipt, not just the verdict", async () => {
    const dir = ws();
    writeFileSync(join(dir, "check.sh"), 'echo "specific failure detail 4711"\nexit 1\n');
    const { engine } = engineIn(
      dir,
      [
        { calls: [{ name: "write_file", args: { path: "b.txt", content: "y\n" } }] },
        { text: "Done." },
      ],
      { bar: BAR_WITH_TESTS, maxProofAttempts: 1 },
    );

    await drain(engine.run("go", allowAll));
    const files = new Receipts(dir).list();
    const body = readFileSync(join(dir, ".molt", "receipts", files[0]), "utf8");
    assert.match(body, /specific failure detail 4711/);
  });
});
