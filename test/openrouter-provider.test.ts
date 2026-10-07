import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openRouterProvider } from "../src/providers.js";

const OR = "https://openrouter.ai/api/v1";
describe("openRouterProvider", () => {
  it("pins the named model to its provider with no fallback", () => {
    assert.deepEqual(openRouterProvider(OR, "minimax/minimax-m3", "minimax/minimax-m3=gmicloud/fp8"), { provider: { only: ["gmicloud/fp8"], allow_fallbacks: false } });
  });
  it("leaves other models (a judge on the same key) alone", () => {
    assert.deepEqual(openRouterProvider(OR, "openai/gpt-5.6-luna", "minimax/minimax-m3=gmicloud/fp8"), {});
  });
  it("only applies to OpenRouter", () => {
    assert.deepEqual(openRouterProvider("http://127.0.0.1:8091/v1", "minimax/minimax-m3", "minimax/minimax-m3=gmicloud/fp8"), {});
  });
  it("reads several pairs", () => {
    assert.deepEqual(openRouterProvider(OR, "b", "a=x;b=y,z").provider?.only, ["y", "z"]);
  });
});
