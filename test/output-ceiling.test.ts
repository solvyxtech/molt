/**
 * How much the model is allowed to write, and what happens when it runs out.
 *
 * The ceiling was 8192 output tokens, sent on every native request and never
 * settable. That number reserves nothing and costs nothing — billing is on
 * tokens actually produced — so the only thing it bought was truncation, and
 * molt's report of a truncation was wrong in the way that matters most: a
 * `write_file` cut off mid-JSON came back to the model as "your arguments
 * were not valid JSON, so nothing ran. Send them again as a JSON object". The
 * model sent the same too-long call again, was cut off in the same place, and
 * was told the same thing. Nothing in that loop said "you ran out of room".
 *
 * Three separate facts, and this suite keeps them apart:
 *
 *  - The default is generous, because a small one only ever costs answers.
 *  - A model whose own maximum is lower says so in its refusal, and molt reads
 *    the number out of it rather than failing the turn.
 *  - A reply that stopped at the ceiling is not a claim of completion and is
 *    not malformed JSON. It is an unfinished sentence, and molt says so.
 */
import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { DEFAULT_MAX_TOKENS, outputCeiling, toRequest } from "../src/anthropic.js";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { Engine } from "../src/engine.js";
import { Receipts } from "../src/receipts.js";
import type { Msg } from "../src/types.js";
import { allowAll, drain, workspace } from "./helpers.js";

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

function ws() {
  const w = workspace();
  cleanups.push(w.cleanup);
  return w.dir;
}

/** Anthropic's own wording when max_tokens is above a model's maximum. */
const REFUSAL = JSON.stringify({
  type: "error",
  error: {
    type: "invalid_request_error",
    message:
      "max_tokens: 32768 > 8192, which is the maximum allowed number of output tokens for " +
      "claude-3-5-sonnet-20241022",
  },
});

describe("the default ceiling", () => {
  it("is well above the 8192 that used to truncate large writes", () => {
    assert.ok(
      DEFAULT_MAX_TOKENS >= 32_768,
      `a large file must land in one piece; got ${DEFAULT_MAX_TOKENS}`,
    );
  });

  it("is what a request carries when nothing else is asked for", () => {
    const body = toRequest([{ role: "user", content: "hi" }], [], { model: "claude-opus-5" });
    assert.equal(body.max_tokens, DEFAULT_MAX_TOKENS);
  });

  it("yields to an explicit setting", () => {
    const body = toRequest([{ role: "user", content: "hi" }], [], {
      model: "claude-opus-5",
      maxTokens: 1024,
    });
    assert.equal(body.max_tokens, 1024);
  });
});

describe("reading a model's own maximum out of its refusal", () => {
  it("takes the number the model named", () => {
    assert.equal(outputCeiling(REFUSAL), 8192);
  });

  it("reads the other common phrasings", () => {
    assert.equal(outputCeiling("max_tokens must be less than or equal to 4096"), 4096);
    assert.equal(outputCeiling("maximum allowed number of output tokens is 4096"), 4096);
  });

  it("leaves an unrelated 400 alone", () => {
    // The narrowness is the point, exactly as with cache_control: a 400 that
    // says nothing about output tokens is a real 400 and must not be quietly
    // reinterpreted as a ceiling problem.
    assert.equal(outputCeiling('{"error":{"message":"invalid api key"}}'), null);
    assert.equal(outputCeiling("context length exceeded: 200000 tokens"), null);
    assert.equal(outputCeiling("max_tokens is required"), null);
  });
});

/** A native-shaped endpoint whose first N requests fail with `body`. */
function nativeStub(opts: { failTimes: number; status: number; body: string }) {
  const state = { calls: 0, sent: [] as Record<string, unknown>[] };
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    state.sent.push(JSON.parse(String(init?.body ?? "{}")));
    state.calls += 1;
    if (state.calls <= opts.failTimes) {
      return {
        ok: false,
        status: opts.status,
        text: async () => opts.body,
        json: async () => JSON.parse(opts.body),
      } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: "text", text: "Done." }],
        stop_reason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, state };
}

function nativeEngine(dir: string, fetchFn: typeof fetch) {
  return new Engine({
    baseUrl: "https://api.anthropic.com/v1",
    apiKey: "test-key",
    model: "claude-3-5-sonnet-20241022",
    provider: "anthropic",
    cwd: dir,
    fetchFn,
    stream: false,
    bar: parseBar(`
version: 1
checks:
  - name: always
    run: "true"
`),
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    maxProofAttempts: 1,
  });
}

describe("a model whose maximum is lower than the default", () => {
  it("adopts the maximum it named and carries on", async () => {
    const dir = ws();
    const stub = nativeStub({ failTimes: 1, status: 400, body: REFUSAL });
    await drain(nativeEngine(dir, stub.fetchFn).run("do the thing", allowAll));

    assert.ok(stub.state.calls >= 2, "the refusal must cost a retry, not the turn");
    assert.equal(stub.state.sent[0].max_tokens, DEFAULT_MAX_TOKENS);
    assert.equal(stub.state.sent[1].max_tokens, 8192, "the second asks for what the model allows");
  });

  it("does not lower the ceiling over an unrelated 400", async () => {
    const dir = ws();
    const body = '{"error":{"type":"authentication_error","message":"invalid x-api-key"}}';
    const stub = nativeStub({ failTimes: 1, status: 400, body });
    await drain(nativeEngine(dir, stub.fetchFn).run("do the thing", allowAll));

    for (const sent of stub.state.sent) {
      assert.equal(sent.max_tokens, DEFAULT_MAX_TOKENS, "a real 400 must not move the ceiling");
    }
  });

  it("puts the ceiling back when lowering it did not help", async () => {
    // Believing the wrong explanation would spend the rest of the session
    // asking for a smaller answer for a reason that turned out to be false.
    // Two turns, because a 400 ends the first one: what matters is what the
    // next turn asks for.
    const dir = ws();
    const stub = nativeStub({ failTimes: 2, status: 400, body: REFUSAL });
    const engine = nativeEngine(dir, stub.fetchFn);
    await drain(engine.run("do the thing", allowAll));
    await drain(engine.run("try again", allowAll));

    const asked = stub.state.sent.map((s) => s.max_tokens);
    assert.equal(asked[0], DEFAULT_MAX_TOKENS);
    assert.equal(asked[1], 8192, "one try at the model's number");
    assert.equal(
      asked[2],
      DEFAULT_MAX_TOKENS,
      `and back to the default once that failed too, got ${asked.join(", ")}`,
    );
  });

  it("forgets a model's ceiling when the model changes", async () => {
    // Output maximums belong to models, not to sessions. Carrying one over
    // would cap a 64k model at the 8k of the model before it, for ever.
    const dir = ws();
    const stub = nativeStub({ failTimes: 1, status: 400, body: REFUSAL });
    const engine = nativeEngine(dir, stub.fetchFn);
    await drain(engine.run("do the thing", allowAll));
    assert.equal(stub.state.sent[1].max_tokens, 8192);

    engine.setModel("claude-opus-5");
    await drain(engine.run("do it on the new model", allowAll));
    assert.equal(
      stub.state.sent[2].max_tokens,
      DEFAULT_MAX_TOKENS,
      "the new model gets asked for what molt actually wants",
    );
  });
});

/** An OpenAI-shaped endpoint replaying scripted turns with stop reasons. */
function stopReasonStub(turns: { message: Msg; finish: string }[]) {
  const state = { calls: 0 };
  const fetchFn = (async () => {
    const turn = turns[Math.min(state.calls, turns.length - 1)];
    state.calls += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: turn.message, finish_reason: turn.finish }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
      text: async () => "",
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchFn, state };
}

function engineWith(dir: string, fetchFn: typeof fetch) {
  return new Engine({
    baseUrl: "http://mock/v1",
    model: "test-model",
    provider: "mock",
    cwd: dir,
    fetchFn,
    stream: false,
    bar: parseBar(`
version: 1
checks:
  - name: always
    run: "true"
`),
    archive: new Archive(dir),
    receipts: new Receipts(dir),
    maxProofAttempts: 1,
  });
}

describe("a tool call cut off at the ceiling", () => {
  it("is reported as running out of room, not as bad JSON", async () => {
    const dir = ws();
    // What a truncated write_file actually looks like: valid up to the cut.
    const truncated = '{"path":"big.ts","content":"export const a = 1;\\nexport con';
    const stub = stopReasonStub([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "write_file", arguments: truncated } },
          ],
        },
        finish: "length",
      },
      { message: { role: "assistant", content: "Done." }, finish: "stop" },
    ]);

    const engine = engineWith(dir, stub.fetchFn);
    const events = await drain(engine.run("write the file", allowAll));
    assert.ok(
      events.some((e) => e.kind === "tool" && e.note === "malformed"),
      "the call still cannot run",
    );

    // What the model was actually told is the thing under test, and it is
    // told in the transcript rather than in an event.
    const said = engine.getRecord().map((m) => m.content ?? "").join("\n");
    assert.match(said, /hit the output ceiling of \d+ tokens/);
    assert.match(said, /Write less in one go/);
    assert.doesNotMatch(
      said,
      /were not valid JSON, so nothing ran/,
      "telling it to send the same call again is the loop this fixes",
    );
  });

  it("still calls genuinely bad JSON what it is", async () => {
    const dir = ws();
    const stub = stopReasonStub([
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            { id: "c1", type: "function", function: { name: "read_file", arguments: "not json" } },
          ],
        },
        finish: "tool_calls",
      },
      { message: { role: "assistant", content: "Done." }, finish: "stop" },
    ]);

    const engine = engineWith(dir, stub.fetchFn);
    await drain(engine.run("read it", allowAll));
    const said = engine.getRecord().map((m) => m.content ?? "").join("\n");
    assert.match(said, /were not valid JSON/);
    assert.doesNotMatch(said, /hit the output ceiling/);
  });
});

describe("a reply cut off at the ceiling", () => {
  it("is not read as a claim of completion", async () => {
    const dir = ws();
    const stub = stopReasonStub([
      { message: { role: "assistant", content: "I have finished the work and everyth" }, finish: "length" },
      { message: { role: "assistant", content: "…ing passes. Done." }, finish: "stop" },
    ]);

    const events = await drain(engineWith(dir, stub.fetchFn).run("do the thing", allowAll));
    const steps = events.filter((e) => e.kind === "step_summary") as { outcome: string }[];

    assert.equal(steps[0]?.outcome, "truncated", "half a sentence is not a claim");
    assert.equal(steps[1]?.outcome, "claim", "the finished one is");
    assert.equal(stub.state.calls, 2, "it was asked to continue");
    assert.match(JSON.stringify(events), /cut off at the .* output ceiling/);
  });

  it("does not run the bar on it", async () => {
    // The expensive half of the same mistake: a suite spent proving a claim
    // the model never made.
    const dir = ws();
    const stub = stopReasonStub([
      { message: { role: "assistant", content: "I have finished the work and everyth" }, finish: "length" },
      { message: { role: "assistant", content: "…ing passes." }, finish: "stop" },
    ]);

    const events = await drain(engineWith(dir, stub.fetchFn).run("do the thing", allowAll));
    const proofs = events.filter((e) => e.kind === "proof_start");
    assert.equal(proofs.length, 1, "the bar runs once, for the real claim");

    // And the claim it was run against is the finished sentence, not the
    // half of one that arrived first.
    const answer = events.find((e) => e.kind === "assistant_text") as { text: string } | undefined;
    assert.equal(answer?.text, "…ing passes.");
  });

  it("gives up asking rather than looping for ever", async () => {
    const dir = ws();
    const stub = stopReasonStub([
      { message: { role: "assistant", content: "still going" }, finish: "length" },
    ]);

    const events = await drain(engineWith(dir, stub.fetchFn).run("do the thing", allowAll));
    const steps = events.filter((e) => e.kind === "step_summary") as { outcome: string }[];
    assert.ok(
      steps.some((s) => s.outcome === "claim"),
      "a model that always runs out of room is eventually taken at its word",
    );
    assert.ok(stub.state.calls <= 4, `and is not asked for ever, got ${stub.state.calls} calls`);
  });
});
