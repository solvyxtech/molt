/**
 * Every path that once spoke HTTP on the Claude Code backend.
 *
 * `claude-code.ts` states the invariant: the base URL "is not fetchable, and
 * nothing tries: `isClaudeCode` guards every path that would." Three paths
 * did. `claude-code://subscription` is a name for "the subscription is doing
 * the work", not a URL, and `fetch` refuses the scheme with the six words
 * "TypeError: fetch failed" — a sentence that names neither the cause nor the
 * layer, and that a reader has no way to tell from a dead local server.
 *
 * The salvage was the expensive one. It is the last request of a turn molt cut
 * short, and every ceiling in the loop ends in one, so on this backend a
 * budget, a deadline or the step limit threw the safety net into the journal
 * and put nothing at all on screen.
 *
 * All three now go through the CLI molt already drives. The invariant this
 * file pins is the one that survived: every one of these paths runs with a
 * `fetch` that fails the test if it is called at all.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { Archive } from "../src/archive.js";
import { parseBar } from "../src/bar.js";
import { CLAUDE_CODE_URL, claudeCodeAsk, type Sdk } from "../src/claude-code.js";
import { draftCriteria } from "../src/criteria.js";
import { Engine } from "../src/engine.js";
import { INTERVIEW_MAX_ROUNDS, interviewTurn } from "../src/interview.js";
import { Receipts } from "../src/receipts.js";
import type { EngineEvent } from "../src/types.js";
import { allowAll, drain, scriptedClaudeCode, workspace } from "./helpers.js";

const BAR = parseBar(`
version: 1
checks:
  - name: work-landed
    builtin: files-changed
`);

const cleanups: (() => void)[] = [];
after(() => cleanups.forEach((c) => c()));

/** A fetch that fails the test rather than the request. */
function noFetch(where: string): typeof fetch {
  return ((input: unknown) => {
    assert.fail(`${where} sent an HTTP request to ${String(input)}`);
  }) as unknown as typeof fetch;
}

function textOf(events: EngineEvent[], kind: EngineEvent["kind"]): string[] {
  return events
    .filter((e) => e.kind === kind)
    .map((e) => (e as { text?: string }).text ?? "");
}

describe("a turn cut short on the Claude Code backend", () => {
  it("salvages through the session instead of over HTTP", async () => {
    const w = workspace();
    cleanups.push(w.cleanup);
    const cc = scriptedClaudeCode([
      // The step: says something, writes nothing, so the bar refuses it and
      // the loop comes back round to the budget check.
      { text: "Read a few files. Nothing written yet." },
      // The salvage. It tries a tool it was just told it may not call, and
      // then answers — which is the whole point of a salvage.
      {
        calls: [{ name: "write_file", args: { path: "sneak.txt", content: "x\n" } }],
        text: "I read the config and the engine. I did not verify anything.",
      },
    ]);

    const engine = new Engine({
      baseUrl: CLAUDE_CODE_URL,
      model: "sonnet",
      provider: "claude-code",
      cwd: w.dir,
      bar: BAR,
      archive: new Archive(w.dir),
      receipts: new Receipts(w.dir),
      claudeCodeSdk: cc.sdk,
      maxProofAttempts: 2,
      // Nothing on this backend may reach the network at all.
      fetchFn: noFetch("the salvage"),
    });
    // Small enough that the second pass through the loop is over it.
    engine.setBudget(1);

    const events = await drain(engine.run("audit this repo", allowAll));

    // The closing answer reached the reader.
    const said = textOf(events, "assistant_text");
    assert.ok(
      said.some((t) => t.includes("I did not verify anything")),
      `the salvaged answer must reach the user, got ${JSON.stringify(said)}`,
    );

    // And it is labelled as notes, not as a completion.
    assert.ok(
      textOf(events, "info").some((t) => t.includes("NOT checked")),
      "a salvaged answer must be marked as unchecked",
    );

    // "You cannot call any more tools" has to be true, not just said. The
    // HTTP salvage enforces it with `tool_choice: "none"`; there is no
    // request body here, so the refusal happens at molt's own tool seam.
    assert.equal(
      existsSync(join(w.dir, "sneak.txt")),
      false,
      "a salvage may not write: the turn is already over",
    );
  });
});

/**
 * These two used to refuse: "needs an HTTP endpoint … switch endpoints". That
 * was true of the transport and false of the backend — molt already runs a
 * model here, and the interview is the more visible of the two, because
 * spec-first calls it on Run and every first Run on a subscription ended in an
 * apology. They ask the subprocess now. The rule the file exists for is
 * unchanged and still asserted: nothing on this backend speaks HTTP.
 */
describe("the pre-turn model calls on the Claude Code backend", () => {
  it("drafts criteria through the session instead of over HTTP", async () => {
    const cc = scriptedClaudeCode([
      { text: '{"checks":[{"name":"suite","run":"npm test"}],"notes":["reads cleanly"]}' },
    ]);
    const r = await draftCriteria({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      baseUrl: CLAUDE_CODE_URL,
      model: "opus",
      fetchFn: noFetch("draftCriteria"),
      claudeCodeSdk: cc.sdk,
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(
      r.ok ? r.draft.checks.map((c) => c.run) : [],
      ["npm test"],
      "the draft must come back from the session",
    );
    // The task reached the model, so this is its answer and not a canned one.
    assert.ok(cc.sent.some((t) => t.includes("audit this repo")), JSON.stringify(cc.sent));
  });

  it("interviews through the session instead of over HTTP", async () => {
    const cc = scriptedClaudeCode([
      {
        text: JSON.stringify({
          questions: [
            { id: "q1", prompt: "What counts as done?", options: ["tests pass", "a demo"] },
          ],
        }),
      },
    ]);
    const r = await interviewTurn({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      history: [],
      round: 1,
      baseUrl: CLAUDE_CODE_URL,
      model: "opus",
      fetchFn: noFetch("interviewTurn"),
      claudeCodeSdk: cc.sdk,
    });
    assert.equal(r.kind, "ask");
    assert.equal(r.kind === "ask" ? r.questions[0]?.prompt : "", "What counts as done?");

    // A question is not work: this path gets no tools at all, so nothing it
    // does can land on disk without a ledger entry behind it.
    const opts = cc.options();
    assert.deepEqual(opts.tools, [], "the pre-turn call may hold no tools");
    assert.deepEqual(opts.mcpServers, {}, "and no molt tool server either");
    assert.deepEqual(opts.settingSources, [], "a CLAUDE.md may not steer a proposal");
  });

  it("reports a refusal from the CLI as itself, not as a network fault", async () => {
    const cc = scriptedClaudeCode([{ error: "usage limit reached" }]);
    const r = await interviewTurn({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      history: [],
      round: 1,
      baseUrl: CLAUDE_CODE_URL,
      model: "opus",
      fetchFn: noFetch("interviewTurn"),
      claudeCodeSdk: cc.sdk,
    });
    assert.equal(r.kind, "error");
    const err = r.kind === "error" ? (r.error ?? "") : "";
    assert.match(err, /usage limit reached/);
    assert.ok(!/fetch failed/i.test(err), "must not report a network fault");
  });

  it("says so when the draft comes back refused", async () => {
    const cc = scriptedClaudeCode([{ error: "error_max_turns" }]);
    const r = await draftCriteria({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      baseUrl: CLAUDE_CODE_URL,
      model: "opus",
      fetchFn: noFetch("draftCriteria"),
      claudeCodeSdk: cc.sdk,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /error_max_turns/);
  });

  it("proposes at the last round rather than opening another one", async () => {
    // Round 4 is the last and the model asks anyway. What comes back is a
    // proposal — empty, because it proposed nothing — and never a fifth round.
    const cc = scriptedClaudeCode([
      {
        text: JSON.stringify({
          questions: [{ id: "q9", prompt: "One more?", options: ["yes", "no"] }],
          proposal: { checks: [{ name: "suite", run: "npm test" }], notes: [] },
        }),
      },
    ]);
    const r = await interviewTurn({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      history: [],
      round: INTERVIEW_MAX_ROUNDS,
      baseUrl: CLAUDE_CODE_URL,
      model: "opus",
      fetchFn: noFetch("interviewTurn"),
      claudeCodeSdk: cc.sdk,
    });
    assert.equal(r.kind, "propose");
    assert.deepEqual(
      r.kind === "propose" ? r.proposal.checks.map((c) => c.run) : [],
      ["npm test"],
      "the last round must seal what there is, not ask again",
    );
  });
});

/**
 * The other side of the same fork.
 *
 * `draftCriteria` had no test at all, so nothing said which transport it
 * chooses — and a branch on `isClaudeCode` is only correct if the ordinary
 * endpoint still goes over HTTP to the path it always used.
 */
describe("the same pre-turn calls on an ordinary endpoint", () => {
  it("drafts over HTTP against /chat/completions", async () => {
    let seen = "";
    const fetchFn = (async (url: unknown) => {
      seen = String(url);
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: '{"checks":[{"name":"suite","run":"npm test"}],"notes":[]}' } },
          ],
        }),
      };
    }) as unknown as typeof fetch;
    const r = await draftCriteria({
      task: "audit this repo",
      scripts: ["test"],
      barChecks: ["types"],
      baseUrl: "http://localhost:1234/v1",
      model: "local",
      fetchFn,
    });
    assert.equal(seen, "http://localhost:1234/v1/chat/completions");
    assert.deepEqual(r.ok ? r.draft.checks.map((c) => c.name) : [], ["suite"]);
  });

  it("reports the status when the endpoint refuses", async () => {
    const fetchFn = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;
    const r = await draftCriteria({
      task: "audit this repo",
      scripts: [],
      barChecks: [],
      baseUrl: "http://localhost:1234/v1",
      model: "local",
      fetchFn,
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /HTTP 503 drafting criteria/);
  });

  /**
   * A dead endpoint is `TypeError: fetch failed` and nothing else until the
   * cause is unwrapped. Both pre-turn calls go through `errorText` for that
   * reason, and neither had a test that made a request actually throw.
   */
  it("unwraps what a thrown fetch was hiding, in both calls", async () => {
    const boom = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("ECONNREFUSED") });
    }) as unknown as typeof fetch;
    const drafted = await draftCriteria({
      task: "audit this repo",
      scripts: [],
      barChecks: [],
      baseUrl: "http://localhost:1234/v1",
      model: "local",
      fetchFn: boom,
    });
    assert.equal(drafted.ok, false);
    assert.match(drafted.ok ? "" : drafted.error, /ECONNREFUSED/);

    const asked = await interviewTurn({
      task: "audit this repo",
      scripts: [],
      barChecks: [],
      history: [],
      round: 1,
      baseUrl: "http://localhost:1234/v1",
      model: "local",
      fetchFn: boom,
    });
    assert.equal(asked.kind, "error");
    assert.match(asked.kind === "error" ? asked.error : "", /ECONNREFUSED/);
  });
});

/** A fake SDK that yields exactly the messages a test names, and no more. */
function stubSdk(messages: unknown[]): {
  sdk: Sdk;
  sent: string[];
  options: () => Record<string, unknown>;
} {
  const sent: string[] = [];
  let options: Record<string, unknown> = {};
  const sdk = {
    z: {},
    tool: () => ({}),
    createSdkMcpServer: () => ({}),
    query: ({ prompt, options: o }: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
      options = o;
      return {
        async *[Symbol.asyncIterator]() {
          // Drained to the end, not broken out of: molt's input generator is
          // one message and then done, and a stub that abandons it would
          // never run the half of it that closes.
          for await (const m of prompt) {
            sent.push(String((m as { message: { content: string } }).message.content));
          }
          for (const m of messages) yield m;
        },
      };
    },
  };
  return { sdk: sdk as unknown as Sdk, sent, options: () => options };
}

/**
 * What a question costs on this backend, and what it is allowed to do.
 *
 * `claudeCodeAsk` is the whole of the pre-turn transport, so the cases that
 * are awkward to reach through the interview are pinned directly: no SDK on
 * the machine, a CLI that ends without answering, a result that carries a
 * refusal instead of text.
 */
describe("asking Claude Code a question with no session", () => {
  it("loads the SDK and runs the CLI the machine has", async () => {
    const cc = stubSdk([{ type: "result", subtype: "success", result: "  an answer  " }]);
    const r = await claudeCodeAsk({
      model: "sonnet",
      systemPrompt: "be brief",
      prompt: "what would prove this?",
      cwd: "/tmp",
      // No `sdk`: this is the production shape, with the two lookups stubbed.
      load: async () => cc.sdk,
      find: async () => "/usr/local/bin/claude",
    });
    assert.deepEqual(r, { ok: true, text: "an answer" });
    assert.deepEqual(cc.sent, ["what would prove this?"]);
    const opts = cc.options();
    assert.equal(opts.cwd, "/tmp");
    assert.equal(opts.maxTurns, 1);
    assert.equal(
      opts.pathToClaudeCodeExecutable,
      "/usr/local/bin/claude",
      "the CLI you logged into, not the SDK's own copy",
    );
  });

  it("names the missing SDK rather than reporting a failed request", async () => {
    const r = await claudeCodeAsk({
      model: "sonnet",
      systemPrompt: "be brief",
      prompt: "anything",
      load: async () => {
        throw new Error("npm install -g @anthropic-ai/claude-agent-sdk");
      },
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /claude-agent-sdk/);
  });

  it("reports a refusal by its subtype when it carries no text", async () => {
    const cc = stubSdk([{ type: "result", subtype: "error_max_turns", result: "" }]);
    const r = await claudeCodeAsk({
      model: "sonnet",
      systemPrompt: "be brief",
      prompt: "anything",
      sdk: cc.sdk,
    });
    assert.deepEqual(r, { ok: false, error: "error_max_turns" });
    assert.equal(
      cc.options().pathToClaudeCodeExecutable,
      undefined,
      "a supplied SDK spawns nothing, so nothing is looked up",
    );
  });

  it("falls back to plain words when the result says nothing at all", async () => {
    const cc = stubSdk([{ type: "result" }]);
    const r = await claudeCodeAsk({
      model: "sonnet",
      systemPrompt: "be brief",
      prompt: "anything",
      sdk: cc.sdk,
    });
    assert.deepEqual(r, { ok: false, error: "the Claude Code session failed" });
  });

  it("refuses an empty answer instead of passing it on as one", async () => {
    const cc = stubSdk([
      { type: "assistant", message: { content: [{ type: "text", text: "thinking" }] } },
      { type: "result", subtype: "success" },
    ]);
    const r = await claudeCodeAsk({
      model: "sonnet",
      systemPrompt: "be brief",
      prompt: "anything",
      sdk: cc.sdk,
    });
    assert.deepEqual(r, { ok: false, error: "Claude Code returned nothing" });
  });

  it("says when the CLI ended without a result at all", async () => {
    const cc = stubSdk([{ type: "system", subtype: "init" }]);
    const r = await claudeCodeAsk({
      model: "sonnet",
      systemPrompt: "be brief",
      prompt: "anything",
      sdk: cc.sdk,
    });
    assert.deepEqual(r, { ok: false, error: "Claude Code ended without answering" });
  });
});

describe("what a stringified error says", () => {
  it("carries the cause fetch hides behind six words", async () => {
    const { errorText } = await import("../src/format.js");
    let caught: unknown;
    try {
      await fetch("claude-code://subscription/chat/completions");
    } catch (e) {
      caught = e;
    }
    assert.ok(caught, "the scheme must be refused");
    const text = errorText(caught);
    assert.match(text, /fetch failed/);
    // The half that was being thrown away, and the only half that identifies
    // the layer: undici puts the reason in `cause`.
    assert.match(text, /unknown scheme/);
  });
});
