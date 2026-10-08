import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeTarget } from "../src/judge.js";

const worker = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "k", model: "inception/mercury-2.5" };

describe("judgeTarget", () => {
  it("is the worker's own model by default", () => {
    assert.deepEqual(judgeTarget(worker, {}), worker);
  });
  it("moves to MAAT_JUDGE_MODEL on the same provider, keeping the key", () => {
    assert.deepEqual(judgeTarget(worker, { MAAT_JUDGE_MODEL: "other/model" }), { ...worker, model: "other/model" });
  });
  it("does not send the worker's key to a different provider", () => {
    const t = judgeTarget(worker, { MAAT_JUDGE_MODEL: "m", MAAT_JUDGE_URL: "http://127.0.0.1:8091/v1" });
    assert.equal(t.baseUrl, "http://127.0.0.1:8091/v1");
    assert.equal(t.apiKey, undefined);
  });
  it("uses MAAT_JUDGE_KEY when given", () => {
    assert.equal(judgeTarget(worker, { MAAT_JUDGE_MODEL: "m", MAAT_JUDGE_URL: "https://x/v1", MAAT_JUDGE_KEY: "j" }).apiKey, "j");
  });
  it("a subscription worker judged on OpenRouter uses OPENROUTER_API_KEY", () => {
    const t = judgeTarget({ baseUrl: "grok-build://subscription", model: "grok-4.7" }, { MAAT_JUDGE_MODEL: "z-ai/glm-5.3-flash", MAAT_JUDGE_URL: "https://openrouter.ai/api/v1", OPENROUTER_API_KEY: "or" });
    assert.deepEqual(t, { baseUrl: "https://openrouter.ai/api/v1", model: "z-ai/glm-5.3-flash", apiKey: "or" });
  });
});

import { parseArgs } from "../src/cli.js";
import { askModel } from "../src/ask.js";
import { GROK_BUILD_URL, OPENCODE_URL } from "../src/endpoint.js";
import { scriptedAcpAgent } from "./acp-agent.js";

describe("--judge / --judge-url", () => {
  it("parse into args", () => {
    const a = parseArgs(["--judge", "grok-4.7", "--judge-url", "grok-build://subscription", "do it"], {});
    assert.equal(a.judge, "grok-4.7");
    assert.equal(a.judgeUrl, GROK_BUILD_URL);
  });
  it("expand the same shorthands as --url", () => {
    assert.equal(parseArgs(["--judge", "grok-4.7", "--judge-url", "grok", "x"], {}).judgeUrl, GROK_BUILD_URL);
    assert.equal(parseArgs(["--judge", "opencode/big-pickle", "--judge-url", "opencode", "x"], {}).judgeUrl, OPENCODE_URL);
  });
  it("refuse a removed subscription backend at parse time", () => {
    assert.throws(() => parseArgs(["--judge", "m", "--judge-url", "gemini-cli://subscription", "x"], {}), /--judge-url: .*removed/);
  });
});

const noFetch = ((input: unknown) => {
  assert.fail(`sent an HTTP request to ${String(input)}`);
}) as unknown as typeof fetch;

describe("Grok Build as the judge of an HTTP worker", () => {
  it("routes the judge's question over ACP, with no key and no HTTP", async () => {
    const t = judgeTarget(worker, { MAAT_JUDGE_MODEL: "grok-4.7", MAAT_JUDGE_URL: GROK_BUILD_URL });
    assert.deepEqual(t, { baseUrl: GROK_BUILD_URL, model: "grok-4.7" });
    const agent = scriptedAcpAgent([{ text: '{"criteria":[]}' }]);
    const r = await askModel({ ...t, system: "S", prompt: "P", fetchFn: noFetch, acpSpawn: agent.spawnFn, timeoutMs: 5_000 });
    assert.deepEqual(r, { ok: true, text: '{"criteria":[]}', cutOff: false });
  });
});

describe("a judge on a different provider's API", () => {
  it("takes that provider's own key variable when the worker is elsewhere", () => {
    const t = judgeTarget(
      { baseUrl: "https://openrouter.ai/api/v1", apiKey: "worker-key", model: "worker-model" },
      { MAAT_JUDGE_MODEL: "judge-model", MAAT_JUDGE_URL: "https://api.anthropic.com/v1", ANTHROPIC_API_KEY: "judge-key" },
    );
    assert.equal(t.apiKey, "judge-key");
    assert.equal(t.model, "judge-model");
  });
});
