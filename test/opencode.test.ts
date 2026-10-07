/**
 * The OpenCode ask path: `opencode://subscription` as a judge. The CLI is
 * stubbed; the facts the stubs encode (event shapes, the 403 on a denied
 * tool list, auto-rejected asks) were measured on opencode 1.18.33.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { askModel } from "../src/ask.js";
import { draftCriteria } from "../src/criteria.js";
import { expandEndpointShorthand, endpointProblem, OPENCODE_URL } from "../src/endpoint.js";
import { judgeTarget } from "../src/judge.js";
import {
  OPENCODE_CONFIG,
  isOpencode,
  opencodeArgs,
  opencodeAsk,
  opencodeEnv,
  opencodeModel,
  parseOpencodeEvents,
} from "../src/opencode.js";
import { isSelfHosted } from "../src/providers.js";

const ev = (o: object) => JSON.stringify(o);
const textStream = (t: string) =>
  [ev({ type: "step_start", part: { type: "step-start" } }), ev({ type: "text", part: { type: "text", text: t } }), ev({ type: "step_finish", part: {} })].join("\n");
const errorStream = (message: string, statusCode?: number) =>
  ev({ type: "error", error: { name: "APIError", data: { message, ...(statusCode ? { statusCode } : {}) } } });

const noFetch = ((input: unknown) => {
  assert.fail(`sent an HTTP request to ${String(input)}`);
}) as unknown as typeof fetch;

describe("opencode endpoint", () => {
  it("is a name, not an address", () => {
    assert.equal(isOpencode(OPENCODE_URL), true);
    assert.equal(isOpencode("https://opencode.ai/zen"), false);
    assert.equal(expandEndpointShorthand("opencode"), OPENCODE_URL);
    assert.equal(endpointProblem(OPENCODE_URL), null);
    assert.equal(isSelfHosted(OPENCODE_URL), false);
  });
  it("is what MAAT_JUDGE_URL turns the judge into, with no key", () => {
    const j = judgeTarget(
      { baseUrl: "grok-build://subscription", model: "grok-4.7" },
      { MAAT_JUDGE_MODEL: "opencode/big-pickle", MAAT_JUDGE_URL: OPENCODE_URL },
    );
    assert.equal(j.baseUrl, OPENCODE_URL);
    assert.equal(j.model, "opencode/big-pickle");
    assert.equal("apiKey" in j, false);
  });
});

describe("arguments and environment", () => {
  it("runs the real CLI in json mode in the given directory", () => {
    const a = opencodeArgs("opencode/big-pickle", "hello", "/tmp/x");
    assert.deepEqual(a, ["run", "-m", "opencode/big-pickle", "--format", "json", "--dir", "/tmp/x", "hello"]);
    assert.equal(opencodeModel("big-pickle"), "opencode/big-pickle");
    assert.equal(opencodeModel("opencode/big-pickle"), "opencode/big-pickle");
  });
  it("refuses every tool by asking, never by denying (a deny is a 403 on the free tier)", () => {
    const cfg = JSON.parse(OPENCODE_CONFIG) as { permission: Record<string, string> };
    for (const k of ["*", "bash", "edit", "webfetch", "websearch", "task", "external_directory"]) {
      assert.equal(cfg.permission[k], "ask", k);
    }
    assert.ok(!Object.values(cfg.permission).includes("allow"));
    assert.ok(!Object.values(cfg.permission).includes("deny"));
  });
  it("pins PWD to the empty directory and carries the config", () => {
    const env = opencodeEnv("/tmp/empty", { PWD: "/elsewhere", HOME: "/h" });
    assert.equal(env.PWD, "/tmp/empty");
    assert.equal(env.HOME, "/h");
    assert.equal(env.OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG);
  });
});

describe("reading the event stream", () => {
  it("joins the text events", () => {
    const r = parseOpencodeEvents(textStream('{"checks":[]}'));
    assert.deepEqual(r, { ok: true, text: '{"checks":[]}' });
  });
  it("ignores non-JSON lines", () => {
    assert.deepEqual(parseOpencodeEvents("log noise\n" + textStream("hi")), { ok: true, text: "hi" });
  });
  it("says so when the model reached for a tool instead of answering", () => {
    const r = parseOpencodeEvents(ev({ type: "tool_use", part: { type: "tool", tool: "bash", state: { status: "error" } } }));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /tried its bash tool/u);
  });
  it("reports the free-tier refusal as a refusal, not a rate limit", () => {
    const r = parseOpencodeEvents(errorStream("OpenCode's free tier can only be used from within OpenCode", 403));
    assert.match(r.ok ? "" : r.error, /refused the request/u);
  });
  it("turns a 429 into a rate-limit message", () => {
    const r = parseOpencodeEvents(errorStream("Rate limit exceeded", 429));
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /rate limit/iu);
    assert.equal(r.ok ? undefined : r.transient, true);
  });
  it("calls a daily cap long, not transient", () => {
    const r = parseOpencodeEvents(errorStream("Free usage limit reached. Resets in 3h20m", 429));
    assert.equal(r.ok ? undefined : r.transient, undefined);
  });
  it("calls an empty stream empty", () => {
    assert.deepEqual(parseOpencodeEvents(""), { ok: false, error: "OpenCode returned nothing" });
  });
});

describe("opencodeAsk", () => {
  it("sends system, the no-tools instruction and the prompt in one message", async () => {
    let args: string[] = [];
    let opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    const r = await opencodeAsk({
      model: "big-pickle",
      systemPrompt: "SYS",
      prompt: "PROMPT",
      run: async (cmd, a, o) => {
        assert.equal(cmd, "opencode");
        args = a;
        opts = o;
        return { stdout: textStream("answer") };
      },
    });
    assert.deepEqual(r, { ok: true, text: "answer" });
    const msg = args[args.length - 1];
    assert.match(msg, /SYS[\s\S]*Do not use any tools[\s\S]*PROMPT/u);
    assert.equal(args[args.indexOf("-m") + 1], "opencode/big-pickle");
    assert.equal(opts.env?.OPENCODE_CONFIG_CONTENT, OPENCODE_CONFIG);
  });
  it("asks once more when the first reply was a tool attempt", async () => {
    let calls = 0;
    const r = await opencodeAsk({
      model: "big-pickle",
      systemPrompt: "S",
      prompt: "P",
      run: async () => {
        calls++;
        return { stdout: calls === 1 ? ev({ type: "tool_use", part: { tool: "read" } }) : textStream("ok") };
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(r, { ok: true, text: "ok" });
  });
  it("reads the error event off a failed spawn", async () => {
    const r = await opencodeAsk({
      model: "big-pickle",
      systemPrompt: "S",
      prompt: "P",
      run: async () => {
        throw Object.assign(new Error("exit 1"), { stdout: errorStream("Rate limit exceeded", 429) });
      },
    });
    assert.match(r.ok ? "" : r.error, /rate limit/iu);
  });
  it("asks again once when an attempt stalled", async () => {
    let calls = 0;
    const r = await opencodeAsk({
      model: "big-pickle",
      systemPrompt: "S",
      prompt: "P",
      run: async () => {
        if (++calls === 1) throw new Error("opencode did not answer within 90s");
        return { stdout: textStream("second") };
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(r, { ok: true, text: "second" });
  });
  it("names a missing CLI", async () => {
    const r = await opencodeAsk({
      model: "big-pickle",
      systemPrompt: "S",
      prompt: "P",
      run: async () => {
        throw new Error("spawn opencode ENOENT");
      },
    });
    assert.match(r.ok ? "" : r.error, /not installed/u);
  });
});

describe("through askModel and the criteria drafter, with no HTTP", () => {
  it("answers an ask", async () => {
    const r = await askModel({
      baseUrl: OPENCODE_URL,
      model: "opencode/big-pickle",
      system: "S",
      prompt: "P",
      fetchFn: noFetch,
      cliRun: async () => ({ stdout: textStream("fine") }),
    });
    assert.deepEqual(r, { ok: true, text: "fine", cutOff: false });
  });
  it("turns a long quota wall into the harness's rate-limit phrase", async () => {
    const r = await askModel({
      baseUrl: OPENCODE_URL,
      model: "opencode/big-pickle",
      system: "S",
      prompt: "P",
      fetchFn: noFetch,
      cliRun: async () => ({ stdout: errorStream("Free usage limit reached. Rate limit: resets in 3h20m", 429) }),
    });
    assert.equal(r.ok, false);
    assert.match(r.ok ? "" : r.error, /rate limit is reached until/u);
  });
  it("backs off and retries a transient 429", async () => {
    let n = 0;
    const r = await askModel({
      baseUrl: OPENCODE_URL,
      model: "opencode/big-pickle",
      system: "S",
      prompt: "P",
      fetchFn: noFetch,
      overloadBackoffMs: [1],
      cliRun: async () => ({ stdout: ++n === 1 ? errorStream("Too many requests", 429) : textStream("later") }),
    });
    assert.equal(n, 2);
    assert.equal(r.ok, true);
  });
  it("drafts criteria", async () => {
    const r = await draftCriteria({
      task: "fix the bug",
      scripts: ["test"],
      barChecks: ["types"],
      baseUrl: OPENCODE_URL,
      model: "opencode/big-pickle",
      fetchFn: noFetch,
      cliRun: async () => ({ stdout: textStream('{"checks":[{"name":"suite","run":"npm test"}],"notes":["n"]}') }),
    });
    assert.ok(r.ok, r.ok ? "" : r.error);
    assert.deepEqual(r.ok ? r.draft.checks.map((c) => c.run) : [], ["npm test"]);
  });
});
